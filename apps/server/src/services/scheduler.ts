import { and, eq, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import {
  formatInZone,
  isTransientNetworkError,
  newId,
  NETWORK_LABELS,
  PartialPublishError,
  PosterError,
  type Network,
  type PublishCtx,
  type PublishResult,
  type RenderedPost,
  type TargetStatus,
} from '@poster/core';
import type { Db } from '../db/index.js';
import { attempts as attemptsTable, posts, postTargets } from '../db/schema.js';
import type { Logger } from '../logger.js';
import type { AccountService } from './accounts.js';
import type { AuditService } from './audit.js';
import type { EventBus } from './events.js';
import type { MediaService } from './media.js';
import type { Metrics } from './metrics.js';
import type { Notifier } from './notifier.js';
import type { PostService } from './posts.js';
import type { Renderer } from './render.js';
import type { SettingsService } from './settings.js';

const LEASE_MS = 15 * 60_000;
const RUNNABLE_POST_STATUSES = ['scheduled', 'queued', 'publishing'];

/**
 * SQLite-backed job runner: polls every 5 s, leases due targets (so a restart never
 * double-posts), publishes one target per network at a time, retries transient errors with
 * backoff, and turns long-overdue targets into MISSED_WINDOW failures.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private readonly inFlight = new Map<Network, Promise<void>>();
  lastTickAt = 0;
  lagMs = 0;

  constructor(
    private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly accounts: AccountService,
    private readonly media: MediaService,
    private readonly renderer: Renderer,
    private readonly postsSvc: PostService,
    private readonly notifier: Notifier,
    private readonly events: EventBus,
    private readonly audit: AuditService,
    private readonly metrics: Metrics,
    private readonly logger: Logger,
  ) {}

  start(intervalMs = 5000): void {
    if (this.timer) return;
    this.recoverStaleLeases();
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
    void this.tick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.allSettled([...this.inFlight.values()]);
  }

  get running(): boolean {
    return this.timer !== null;
  }

  /**
   * Targets left in `publishing` with an expired lease belong to a crashed run. Whether the
   * network accepted the post is unknown, so we never retry automatically.
   */
  recoverStaleLeases(): void {
    const now = Date.now();
    const stale = this.db
      .select()
      .from(postTargets)
      .where(
        and(
          eq(postTargets.status, 'publishing'),
          or(isNull(postTargets.leaseUntil), lt(postTargets.leaseUntil, now)),
        ),
      )
      .all();
    for (const t of stale) {
      this.failTarget(
        t.id,
        t.postId,
        t.network as Network,
        'UNKNOWN_OUTCOME',
        'The app restarted while this target was publishing; check the network manually before retrying.',
        { needsDecision: true },
      );
    }
    if (stale.length)
      this.logger.warn(
        { count: stale.length },
        'recovered stale publishing leases as UNKNOWN_OUTCOME',
      );
  }

  async tick(now = Date.now()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    this.lastTickAt = now;
    try {
      this.postsSvc.expireDrafts(now);
      this.failMissedWindows(now);
      const due = this.dueTargets(now);
      if (due.length) this.lagMs = Math.max(0, now - Math.min(...due.map((t) => t.scheduledAtUtc)));
      else this.lagMs = 0;
      this.metrics.setGauge('poster_scheduler_lag_ms', this.lagMs);
      for (const t of due) {
        const network = t.network as Network;
        if (this.inFlight.has(network)) continue; // one at a time per network
        if (!this.lease(t.id, now)) continue;
        const p = this.runTarget(t.id)
          .catch((err) => this.logger.error({ err, targetId: t.id }, 'runTarget crashed'))
          .finally(() => this.inFlight.delete(network));
        this.inFlight.set(network, p);
      }
    } catch (err) {
      this.logger.error({ err }, 'scheduler tick failed');
    } finally {
      this.ticking = false;
    }
  }

  private dueTargets(now: number) {
    return this.db
      .select({
        id: postTargets.id,
        postId: postTargets.postId,
        network: postTargets.network,
        scheduledAtUtc: postTargets.scheduledAtUtc,
      })
      .from(postTargets)
      .innerJoin(posts, eq(posts.id, postTargets.postId))
      .where(
        and(
          inArray(postTargets.status, ['pending', 'retrying']),
          inArray(posts.status, RUNNABLE_POST_STATUSES),
          lte(postTargets.scheduledAtUtc, now),
          or(isNull(postTargets.nextAttemptAt), lte(postTargets.nextAttemptAt, now)),
          or(isNull(postTargets.leaseUntil), lt(postTargets.leaseUntil, now)),
        ),
      )
      .orderBy(postTargets.scheduledAtUtc)
      .limit(25)
      .all();
  }

  /** Row-level lease: the UPDATE succeeds for exactly one runner. */
  private lease(targetId: string, now: number): boolean {
    const res = this.db
      .update(postTargets)
      .set({ status: 'publishing', leaseUntil: now + LEASE_MS, updatedAt: now })
      .where(
        and(
          eq(postTargets.id, targetId),
          inArray(postTargets.status, ['pending', 'retrying']),
          or(isNull(postTargets.leaseUntil), lt(postTargets.leaseUntil, now)),
        ),
      )
      .run();
    return res.changes === 1;
  }

  /**
   * Missed window: the app was down and the target is more than N minutes late on its first
   * attempt. It is not posted; you are asked whether to post now.
   */
  private failMissedWindows(now: number): void {
    const windowMs = this.settings.get().missedWindowMinutes * 60_000;
    const late = this.db
      .select({
        id: postTargets.id,
        postId: postTargets.postId,
        network: postTargets.network,
        at: postTargets.scheduledAtUtc,
      })
      .from(postTargets)
      .innerJoin(posts, eq(posts.id, postTargets.postId))
      .where(
        and(
          eq(postTargets.status, 'pending'),
          inArray(posts.status, RUNNABLE_POST_STATUSES),
          eq(postTargets.attempts, 0),
          isNull(postTargets.nextAttemptAt),
          lt(postTargets.scheduledAtUtc, now - windowMs),
          sql`${postTargets.localInput} != 'now'`,
        ),
      )
      .all();
    for (const t of late) {
      const minutes = Math.round((now - t.at) / 60_000);
      this.failTarget(
        t.id,
        t.postId,
        t.network as Network,
        'MISSED_WINDOW',
        `Scheduled time passed ${minutes} min ago while the app was not running. Not posted; use "Post now" or reschedule.`,
        { needsDecision: true },
      );
    }
  }

  /* ------------------------------------------------------------------ */
  /* One target                                                           */
  /* ------------------------------------------------------------------ */

  async runTarget(targetId: string): Promise<void> {
    const target = this.db.select().from(postTargets).where(eq(postTargets.id, targetId)).get();
    if (!target) return;
    const post = this.postsSvc.getRow(target.postId);
    const network = target.network as Network;
    const now = Date.now();
    const attemptId = newId();
    const attemptNo = target.attempts + 1;
    const log = this.logger.child({ targetId, postId: post.id, network, attempt: attemptNo });

    this.db
      .update(postTargets)
      .set({ attempts: attemptNo, updatedAt: now })
      .where(eq(postTargets.id, targetId))
      .run();
    this.db
      .insert(attemptsTable)
      .values({ id: attemptId, targetId, startedAt: now, outcome: 'running' })
      .run();
    this.postsSvc.recomputePostStatus(post.id);
    this.events.emit({
      type: 'target.updated',
      postId: post.id,
      targetId,
      network,
      status: 'publishing',
    });
    this.metrics.inc('poster_publish_attempts_total', { network });

    const account = this.accounts.getState(network);
    if (!account?.secrets || account.status !== 'connected') {
      this.finishAttempt(attemptId, 'failed', 'AUTH_REQUIRED', 'Account not connected');
      this.failTarget(
        targetId,
        post.id,
        network,
        'AUTH_REQUIRED',
        `${NETWORK_LABELS[network]} is not connected.`,
        { needsAuth: true },
      );
      return;
    }

    let rendered: RenderedPost;
    try {
      const input = this.postsSvc.renderInput(post, true);
      const r = await this.renderer.renderOne(input, network);
      rendered = {
        ...r.rendered,
        targetId,
        publishedRemoteIds: target.remoteIds.length ? target.remoteIds : undefined,
      };
      // Media errors surface here (e.g. purged files). Text/limit issues were frozen at confirm time.
      const hardErrors = r.issues.filter(
        (i) => i.level === 'error' && !['NOT_CONNECTED', 'AUTH_REQUIRED'].includes(i.code),
      );
      if (hardErrors.length)
        throw new PosterError('VALIDATION', hardErrors.map((i) => i.message).join(' | '), {
          retryable: false,
        });
    } catch (err) {
      const pe = PosterError.from(err, 'VALIDATION');
      this.finishAttempt(attemptId, 'failed', pe.code, pe.message);
      this.failTarget(targetId, post.id, network, pe.code, pe.message);
      return;
    }

    const adapter = this.accounts.adapter(network);
    const ctx: PublishCtx = {
      ...this.accounts.adapterContext(network, attemptId),
      attemptKey: attemptId,
      account,
      updateAccount: async (patch) => {
        await this.accounts.patch(network, patch);
      },
      cacheMediaUrls: async (mediaId, urls) => this.media.cacheBlossomUrls(mediaId, urls),
    };

    const started = Date.now();
    try {
      // Skip parts already published in an earlier attempt (thread resume).
      const toPublish: RenderedPost = rendered.publishedRemoteIds?.length
        ? { ...rendered, parts: rendered.parts.slice(rendered.publishedRemoteIds.length) }
        : rendered;
      if (toPublish.parts.length === 0) {
        throw new PosterError('STATE_INVALID', 'All parts are already published.', {
          retryable: false,
        });
      }
      const result = await adapter.publish(toPublish, ctx);
      const remoteIds = [...(rendered.publishedRemoteIds ?? []), ...result.remoteIds];
      this.succeed(targetId, post, network, { ...result, remoteIds }, attemptId, started);
    } catch (err) {
      await this.handleFailure(err, {
        targetId,
        post,
        network,
        attemptId,
        attemptNo,
        started,
        rendered,
        log,
      });
    }
  }

  private succeed(
    targetId: string,
    post: typeof posts.$inferSelect,
    network: Network,
    result: PublishResult,
    attemptId: string,
    started: number,
  ): void {
    const now = Date.now();
    this.db
      .update(postTargets)
      .set({
        status: 'published',
        publishedUrl: result.url ?? null,
        remoteIds: result.remoteIds,
        leaseUntil: null,
        nextAttemptAt: null,
        lastErrorCode: null,
        lastErrorMsg: null,
        updatedAt: now,
      })
      .where(eq(postTargets.id, targetId))
      .run();
    this.finishAttempt(attemptId, 'published', null, null, {
      ...(result.debug ?? {}),
      relaysOk: result.relaysOk,
      relaysTotal: result.relaysTotal,
      url: result.url,
    });
    this.metrics.inc('poster_publish_total', { network, outcome: 'published' });
    this.metrics.observe('poster_publish_latency_ms', now - started, { network });
    this.events.emit({
      type: 'target.updated',
      postId: post.id,
      targetId,
      network,
      status: 'published',
    });
    const status = this.postsSvc.recomputePostStatus(post.id);
    this.audit.record('system', 'target.published', targetId, {
      network,
      url: result.url,
      postStatus: status,
    });
    const sched = formatInZone(post.scheduledAtUtc, post.tz);
    const relays =
      result.relaysOk !== undefined
        ? ` · ${result.relaysOk}/${result.relaysTotal ?? '?'} relays OK`
        : '';
    this.notifier.enqueue({
      event: 'published',
      postId: post.id,
      network,
      url: result.url ?? null,
      scheduledFor: sched.isoLocal,
      at: new Date(now).toISOString(),
      summary: `Posted to ${NETWORK_LABELS[network]}${result.url ? `: ${result.url}` : ''}${relays}`,
    });
  }

  private async handleFailure(
    err: unknown,
    c: {
      targetId: string;
      post: typeof posts.$inferSelect;
      network: Network;
      attemptId: string;
      attemptNo: number;
      started: number;
      rendered: RenderedPost;
      log: Logger;
    },
  ): Promise<void> {
    const settings = this.settings.get();
    let cause = err;
    let publishedSoFar: string[] | null = null;
    if (err instanceof PartialPublishError) {
      publishedSoFar = [...(c.rendered.publishedRemoteIds ?? []), ...err.publishedRemoteIds];
      cause = err.cause;
      this.db
        .update(postTargets)
        .set({ remoteIds: publishedSoFar, updatedAt: Date.now() })
        .where(eq(postTargets.id, c.targetId))
        .run();
    }
    const pe = PosterError.is(cause)
      ? (cause as PosterError)
      : isTransientNetworkError(cause)
        ? new PosterError('NETWORK_ERROR', (cause as Error).message, { cause })
        : PosterError.from(cause, 'UPSTREAM_ERROR');
    const partNote = publishedSoFar
      ? ` (parts 1-${publishedSoFar.length} are published; retry continues from part ${publishedSoFar.length + 1})`
      : '';
    const message = `${pe.message}${partNote}`;
    c.log.warn({ code: pe.code, retryable: pe.retryable, err: pe }, 'publish failed');
    this.metrics.inc('poster_publish_total', { network: c.network, outcome: 'failed' });
    this.metrics.inc('poster_publish_failures_total', { network: c.network, code: pe.code });

    const debug: Record<string, unknown> = {
      ...(pe.extra.debug as Record<string, unknown> | undefined),
    };
    if (typeof pe.extra.screenshot === 'string') debug.screenshot = pe.extra.screenshot;
    this.finishAttempt(c.attemptId, publishedSoFar ? 'partial' : 'failed', pe.code, message, debug);

    if (pe.code === 'AUTH_REQUIRED') {
      this.accounts.markNeedsAuth(c.network, pe.message);
      this.failTarget(c.targetId, c.post.id, c.network, 'AUTH_REQUIRED', message, {
        needsAuth: true,
      });
      return;
    }
    if (pe.code === 'UNKNOWN_OUTCOME') {
      this.failTarget(c.targetId, c.post.id, c.network, 'UNKNOWN_OUTCOME', message, {
        needsDecision: true,
      });
      return;
    }
    if (pe.retryable && c.attemptNo < settings.retry.maxAttempts) {
      const backoff =
        (settings.retry.backoffMinutes[c.attemptNo - 1] ??
          settings.retry.backoffMinutes.at(-1) ??
          15) * 60_000;
      const next = Date.now() + backoff;
      this.db
        .update(postTargets)
        .set({
          status: 'retrying',
          nextAttemptAt: next,
          leaseUntil: null,
          lastErrorCode: pe.code,
          lastErrorMsg: message,
          updatedAt: Date.now(),
        })
        .where(eq(postTargets.id, c.targetId))
        .run();
      this.events.emit({
        type: 'target.updated',
        postId: c.post.id,
        targetId: c.targetId,
        network: c.network,
        status: 'retrying',
      });
      this.postsSvc.recomputePostStatus(c.post.id);
      return;
    }
    this.failTarget(c.targetId, c.post.id, c.network, pe.code, message);
  }

  private failTarget(
    targetId: string,
    postId: string,
    network: Network,
    code: string,
    message: string,
    opts: { needsAuth?: boolean; needsDecision?: boolean } = {},
  ): void {
    const now = Date.now();
    const status: TargetStatus = opts.needsAuth ? 'needs_auth' : 'failed';
    this.db
      .update(postTargets)
      .set({
        status,
        leaseUntil: null,
        nextAttemptAt: null,
        lastErrorCode: code,
        lastErrorMsg: message.slice(0, 1000),
        updatedAt: now,
      })
      .where(eq(postTargets.id, targetId))
      .run();
    this.events.emit({ type: 'target.updated', postId, targetId, network, status });
    const postStatus = this.postsSvc.recomputePostStatus(postId);
    this.audit.record('system', 'target.failed', targetId, { network, code, postStatus });
    const post = this.postsSvc.getRow(postId);
    const sched = formatInZone(post.scheduledAtUtc, post.tz);
    const ev = {
      event: 'failed' as const,
      postId,
      network,
      code,
      message,
      scheduledFor: sched.isoLocal,
      at: new Date(now).toISOString(),
      summary: `${NETWORK_LABELS[network]} post ${postId} failed (${code}): ${message}${opts.needsAuth ? ' Open the UI → Accounts to log in again.' : ''}${opts.needsDecision ? ' Post it now?' : ''}`,
      needsDecision: !!opts.needsDecision,
    };
    this.notifier.enqueue(ev, 'direct');
    if (opts.needsDecision) this.notifier.enqueue(ev, 'agent');
    if (opts.needsAuth) {
      this.notifier.enqueue({
        event: 'session_expired',
        network,
        at: ev.at,
        summary: `${NETWORK_LABELS[network]}: login required. Reconnect in the UI (Accounts → ${NETWORK_LABELS[network]} → Reconnect).`,
      });
    }
  }

  private finishAttempt(
    attemptId: string,
    outcome: string,
    errorCode: string | null,
    errorMsg: string | null,
    debug: Record<string, unknown> = {},
  ): void {
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(debug)) if (v !== undefined) clean[k] = v;
    this.db
      .update(attemptsTable)
      .set({
        finishedAt: Date.now(),
        outcome,
        errorCode,
        errorMsg: errorMsg?.slice(0, 2000) ?? null,
        debug: clean,
      })
      .where(eq(attemptsTable.id, attemptId))
      .run();
  }
}
