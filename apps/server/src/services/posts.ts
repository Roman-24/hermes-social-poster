import { and, asc, desc, eq, gte, inArray, lt, lte, ne, notInArray, sql } from 'drizzle-orm';
import {
  derivePostStatus,
  FINAL_TARGET_STATUSES,
  formatInZone,
  hasErrors,
  newId,
  NETWORK_LABELS,
  PosterError,
  resolveSchedule,
  type Actor,
  type CancelPostInput,
  type CreateDraftInput,
  type DraftPreview,
  type ListPostsInput,
  type MediaInfo,
  type Network,
  type PostList,
  type PostStatus,
  type PostView,
  type ScheduleInput,
  type ScheduleView,
  type TargetStatus,
  type TargetView,
  type UpdateDraftInput,
} from '@poster/core';
import type { Db } from '../db/index.js';
import {
  attempts as attemptsTable,
  media as mediaTable,
  postMedia,
  posts,
  postTargets,
} from '../db/schema.js';
import type { Logger } from '../logger.js';
import type { AccountService } from './accounts.js';
import type { AuditService } from './audit.js';
import type { CodeService } from './codes.js';
import type { EventBus } from './events.js';
import type { MediaService } from './media.js';
import type { Notifier } from './notifier.js';
import type { RenderInput, Renderer } from './render.js';
import type { SettingsService } from './settings.js';

type PostRow = typeof posts.$inferSelect;
type TargetRow = typeof postTargets.$inferSelect;

const OPEN_POST_STATUSES: PostStatus[] = ['draft', 'scheduled', 'queued', 'publishing'];

export interface ConfirmOptions {
  /** UI sessions are trusted and may confirm without a code. */
  trusted: boolean;
  code?: string;
  actor: Actor;
}

/**
 * Draft → preview → confirm → scheduled/queued → (scheduler) → published/failed.
 * Each network is a separate target so one failure never blocks the others.
 */
export class PostService {
  constructor(
    private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly accounts: AccountService,
    private readonly media: MediaService,
    private readonly renderer: Renderer,
    private readonly codes: CodeService,
    private readonly notifier: Notifier,
    private readonly events: EventBus,
    private readonly audit: AuditService,
    private readonly logger: Logger,
  ) {}

  /* ------------------------------------------------------------------ */
  /* Drafts                                                               */
  /* ------------------------------------------------------------------ */

  async createDraft(input: CreateDraftInput, source: Actor): Promise<DraftPreview> {
    const settings = this.settings.get();
    const now = Date.now();
    const schedule = resolveSchedule(input.schedule, settings.defaultTz, now);
    // Validate per-network overrides eagerly so the error is attributable.
    for (const [n, s] of Object.entries(input.scheduleOverrides ?? {})) {
      if (s !== undefined) resolveSchedule(s as ScheduleInput, settings.defaultTz, now);
      if (!input.networks.includes(n as Network)) {
        throw new PosterError(
          'VALIDATION',
          `scheduleOverrides.${n} refers to a network that is not in "networks".`,
        );
      }
    }
    const mediaIds = await this.collectMediaIds(input);
    const id = newId();
    const networks = [...new Set(input.networks)];

    this.db.transaction((tx) => {
      tx.insert(posts)
        .values({
          id,
          status: 'draft',
          baseText: input.text,
          threadMode: input.thread ?? 'auto',
          networks,
          overrides: stripUndefined(input.overrides ?? {}),
          scheduleOverrides: stripUndefined(input.scheduleOverrides ?? {}),
          scheduledAtUtc: schedule.atUtcMs,
          tz: schedule.tz,
          localInput: schedule.localInput,
          source: source === 'system' ? 'api' : source,
          createdAt: now,
          updatedAt: now,
          expiresAt: now + settings.draftExpiryHours * 3600_000,
        })
        .run();
      this.writePostMedia(
        tx as unknown as Db,
        id,
        mediaIds,
        input.altTexts ?? [],
        input.overrides ?? {},
      );
      for (const network of networks) {
        tx.insert(postTargets)
          .values({
            id: newId(),
            postId: id,
            network,
            textOverride: input.overrides?.[network]?.text ?? null,
            scheduledAtUtc: schedule.atUtcMs,
            tz: schedule.tz,
            localInput: schedule.localInput,
            status: 'pending',
            updatedAt: now,
          })
          .run();
      }
    });
    this.audit.record(source, 'draft.create', id, {
      networks,
      schedule: schedule.isoUtc,
      mediaCount: mediaIds.length,
    });
    this.events.emit({ type: 'post.updated', postId: id, status: 'draft' });
    return this.previewAndIssueCode(id, source);
  }

  async updateDraft(input: UpdateDraftInput, actor: Actor): Promise<DraftPreview> {
    const row = this.getRow(input.draftId);
    if (row.status !== 'draft') {
      throw new PosterError(
        'STATE_INVALID',
        `Post ${row.id} is ${row.status}; only drafts can be updated. Use reschedule_post or cancel_post.`,
      );
    }
    const settings = this.settings.get();
    const now = Date.now();
    const set: Partial<typeof posts.$inferInsert> = {
      updatedAt: now,
      expiresAt: now + settings.draftExpiryHours * 3600_000,
    };
    if (input.text !== undefined) set.baseText = input.text;
    if (input.thread !== undefined) set.threadMode = input.thread;
    if (input.overrides !== undefined) set.overrides = stripUndefined(input.overrides);
    if (input.scheduleOverrides !== undefined) {
      for (const s of Object.values(input.scheduleOverrides))
        if (s !== undefined) resolveSchedule(s as ScheduleInput, settings.defaultTz, now);
      set.scheduleOverrides = stripUndefined(input.scheduleOverrides);
    }
    let schedule: ReturnType<typeof resolveSchedule> | null = null;
    if (input.schedule !== undefined) {
      schedule = resolveSchedule(input.schedule, settings.defaultTz, now);
      set.scheduledAtUtc = schedule.atUtcMs;
      set.tz = schedule.tz;
      set.localInput = schedule.localInput;
    }
    const networks = input.networks ? [...new Set(input.networks)] : (row.networks as Network[]);
    if (input.networks) set.networks = networks;
    const mediaIds =
      input.mediaIds !== undefined || input.mediaPaths !== undefined
        ? await this.collectMediaIds(input as CreateDraftInput)
        : null;

    this.db.transaction((tx) => {
      tx.update(posts).set(set).where(eq(posts.id, row.id)).run();
      if (mediaIds !== null || input.overrides !== undefined) {
        const ids = mediaIds ?? this.postMediaIds(row.id);
        tx.delete(postMedia).where(eq(postMedia.postId, row.id)).run();
        this.writePostMedia(
          tx as unknown as Db,
          row.id,
          ids,
          input.altTexts ?? [],
          (set.overrides ?? row.overrides) as Record<
            string,
            { text?: string; mediaIds?: string[] }
          >,
        );
      }
      const existing = tx.select().from(postTargets).where(eq(postTargets.postId, row.id)).all();
      const keep = new Set(networks);
      for (const t of existing)
        if (!keep.has(t.network as Network))
          tx.delete(postTargets).where(eq(postTargets.id, t.id)).run();
      const have = new Set(existing.map((t) => t.network));
      const overrides = (set.overrides ?? row.overrides) as Record<string, { text?: string }>;
      for (const network of networks) {
        const base = {
          textOverride: overrides[network]?.text ?? null,
          scheduledAtUtc: schedule?.atUtcMs ?? row.scheduledAtUtc,
          tz: schedule?.tz ?? row.tz,
          localInput: schedule?.localInput ?? row.localInput,
          updatedAt: now,
        };
        if (have.has(network))
          tx.update(postTargets)
            .set(base)
            .where(and(eq(postTargets.postId, row.id), eq(postTargets.network, network)))
            .run();
        else
          tx.insert(postTargets)
            .values({ id: newId(), postId: row.id, network, status: 'pending', ...base })
            .run();
      }
    });
    this.audit.record(actor, 'draft.update', row.id, {
      fields: Object.keys(input).filter((k) => k !== 'draftId'),
    });
    return this.previewAndIssueCode(row.id, actor);
  }

  /** Recompute the preview and issue a fresh confirmation code (invalidating the old one). */
  async previewAndIssueCode(postId: string, actor: Actor): Promise<DraftPreview> {
    const preview = await this.preview(postId);
    const row = this.getRow(postId);
    if (row.status !== 'draft') return preview;
    const errors = preview.errors;
    if (errors.length > 0) {
      // No code for an unconfirmable draft; the agent must fix it first.
      this.codes.invalidate(postId);
      return { ...preview, codeDelivery: 'none', codeExpiresAt: null };
    }
    const direct = this.notifier.directRouteConfigured();
    const { code, expiresAt } = await this.codes.issue(postId, direct ? 'direct' : 'returned');
    if (direct) {
      this.notifier.enqueue({
        event: 'confirmation_code',
        draftId: postId,
        code,
        expiresAt: new Date(expiresAt).toISOString(),
        summary: codeMessage(code, preview, expiresAt),
        at: new Date().toISOString(),
      });
      this.audit.record(actor, 'draft.code_issued', postId, { delivery: 'direct' });
      return { ...preview, codeDelivery: 'direct', codeExpiresAt: expiresAt };
    }
    this.audit.record(actor, 'draft.code_issued', postId, { delivery: 'returned' });
    return { ...preview, codeDelivery: 'returned', code, codeExpiresAt: expiresAt };
  }

  async preview(postId: string): Promise<DraftPreview> {
    const row = this.getRow(postId);
    const rendered = await this.renderer.renderAll(this.renderInput(row));
    const previews = rendered.map((r) => this.renderer.toPreview(r));
    const warnings: string[] = [];
    const errors: string[] = [];
    for (const p of previews) {
      for (const i of p.issues) {
        const line = `${NETWORK_LABELS[p.network]}: ${i.message}`;
        if (i.level === 'error') errors.push(line);
        else if (i.level === 'warning') warnings.push(line);
      }
    }
    const sched = formatInZone(row.scheduledAtUtc, row.tz);
    const active = this.codes.active(postId);
    return {
      draftId: row.id,
      status: row.status as PostStatus,
      previews,
      schedule: {
        atUtcMs: row.scheduledAtUtc,
        tz: row.tz,
        ...sched,
        immediate: row.localInput === 'now',
      },
      warnings: [...new Set(warnings)],
      errors: [...new Set(errors)],
      codeDelivery: active ? (active.deliveredVia as 'direct' | 'returned') : 'none',
      codeExpiresAt: active?.expiresAt ?? null,
      expiresAt: row.expiresAt ?? row.createdAt + this.settings.get().draftExpiryHours * 3600_000,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Confirm                                                              */
  /* ------------------------------------------------------------------ */

  async confirm(
    draftId: string,
    opts: ConfirmOptions,
  ): Promise<{ postId: string; status: PostStatus; schedule: ScheduleView }> {
    const row = this.getRow(draftId);
    if (row.status !== 'draft')
      throw new PosterError('STATE_INVALID', `Post ${row.id} is already ${row.status}.`);
    if (row.expiresAt && row.expiresAt < Date.now()) {
      this.setPostStatus(row.id, 'expired');
      throw new PosterError(
        'STATE_INVALID',
        'This draft has expired (not confirmed within 24 h). Create a new draft.',
      );
    }
    if (!opts.trusted) {
      if (!opts.code) throw new PosterError('CODE_INVALID', 'A confirmation code is required.');
      await this.codes.consume(row.id, opts.code);
    } else {
      this.codes.invalidate(row.id);
    }

    // Re-render with the current state and freeze the parts.
    const rendered = await this.renderer.renderAll(this.renderInput(row));
    const allIssues = rendered.flatMap((r) => r.issues);
    if (hasErrors(allIssues)) {
      const msgs = allIssues
        .filter((i) => i.level === 'error')
        .map((i) => `${NETWORK_LABELS[i.network ?? (row.networks[0] as Network)]}: ${i.message}`);
      throw new PosterError('VALIDATION', `Draft cannot be published: ${msgs.join(' | ')}`, {
        extra: { issues: msgs },
      });
    }

    this.enforceDailyLimit();
    const now = Date.now();
    const settings = this.settings.get();
    for (const r of rendered)
      this.enforceMinGap(r.network, r.schedule.atUtcMs, row.id, settings.minGapPerNetworkMinutes);

    const immediate = rendered.every((r) => r.schedule.atUtcMs <= now + 60_000);
    const status: PostStatus = immediate ? 'queued' : 'scheduled';
    this.db.transaction((tx) => {
      tx.update(posts)
        .set({ status, confirmedAt: now, updatedAt: now, expiresAt: null })
        .where(eq(posts.id, row.id))
        .run();
      for (const r of rendered) {
        tx.update(postTargets)
          .set({
            scheduledAtUtc: r.schedule.atUtcMs,
            tz: r.schedule.tz,
            localInput: r.schedule.immediate ? 'now' : r.schedule.isoLocal,
            renderedParts: r.rendered.parts.map((p) => p.text),
            status: 'pending',
            nextAttemptAt: null,
            lastErrorCode: null,
            lastErrorMsg: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(postTargets.postId, row.id),
              eq(postTargets.network, r.network),
              notInArray(postTargets.status, ['published']),
            ),
          )
          .run();
      }
    });
    this.audit.record(opts.actor, 'post.confirm', row.id, {
      status,
      trusted: opts.trusted,
      networks: row.networks,
    });
    this.events.emit({ type: 'post.updated', postId: row.id, status });
    const sched = formatInZone(row.scheduledAtUtc, row.tz);
    return {
      postId: row.id,
      status,
      schedule: { atUtcMs: row.scheduledAtUtc, tz: row.tz, ...sched, immediate },
    };
  }

  private enforceDailyLimit(): void {
    const max = this.settings.get().maxPostsPerDay;
    const since = Date.now() - 24 * 3600_000;
    const n = this.db
      .select({ n: sql<number>`count(*)` })
      .from(posts)
      .where(
        and(
          gte(posts.confirmedAt, since),
          notInArray(posts.status, ['draft', 'cancelled', 'expired']),
        ),
      )
      .get()?.n;
    if ((n ?? 0) >= max) {
      throw new PosterError(
        'RATE_LIMITED',
        `Daily limit reached: ${n} post(s) confirmed in the last 24 h (max ${max}, see Settings).`,
        { retryable: false },
      );
    }
  }

  private enforceMinGap(
    network: Network,
    atUtcMs: number,
    postId: string,
    gapMinutes: number,
  ): void {
    if (gapMinutes <= 0) return;
    const gap = gapMinutes * 60_000;
    const clash = this.db
      .select({ id: postTargets.id, postId: postTargets.postId, at: postTargets.scheduledAtUtc })
      .from(postTargets)
      .innerJoin(posts, eq(posts.id, postTargets.postId))
      .where(
        and(
          eq(postTargets.network, network),
          ne(postTargets.postId, postId),
          inArray(posts.status, ['scheduled', 'queued', 'publishing']),
          notInArray(postTargets.status, [...FINAL_TARGET_STATUSES]),
          gte(postTargets.scheduledAtUtc, atUtcMs - gap),
          lte(postTargets.scheduledAtUtc, atUtcMs + gap),
        ),
      )
      .get();
    if (clash) {
      throw new PosterError(
        'SCHEDULE_INVALID',
        `${NETWORK_LABELS[network]}: another post (${clash.postId}) is scheduled within ${gapMinutes} min of this time.`,
      );
    }
  }

  /* ------------------------------------------------------------------ */
  /* Cancel / reschedule / retry / post now                               */
  /* ------------------------------------------------------------------ */

  cancel(
    input: CancelPostInput,
    actor: Actor,
  ): {
    postId: string;
    status: PostStatus;
    cancelled: Network[];
    notCancelled: { network: Network; reason: string }[];
  } {
    const row = this.getRow((input.postId ?? input.draftId)!);
    const targets = this.targets(row.id);
    const wanted = input.networks?.length ? new Set(input.networks) : null;
    const cancelled: Network[] = [];
    const notCancelled: { network: Network; reason: string }[] = [];
    const now = Date.now();
    for (const t of targets) {
      const n = t.network as Network;
      if (wanted && !wanted.has(n)) continue;
      if (t.status === 'publishing') {
        notCancelled.push({ network: n, reason: 'currently publishing' });
        continue;
      }
      if (FINAL_TARGET_STATUSES.has(t.status as TargetStatus)) {
        notCancelled.push({ network: n, reason: `already ${t.status}` });
        continue;
      }
      this.db
        .update(postTargets)
        .set({ status: 'cancelled', updatedAt: now, leaseUntil: null, nextAttemptAt: null })
        .where(eq(postTargets.id, t.id))
        .run();
      cancelled.push(n);
      this.events.emit({
        type: 'target.updated',
        postId: row.id,
        targetId: t.id,
        network: n,
        status: 'cancelled',
      });
    }
    const status = this.recomputePostStatus(
      row.id,
      row.status === 'draft' && !wanted ? 'cancelled' : undefined,
    );
    if (row.status === 'draft') this.codes.invalidate(row.id);
    this.audit.record(actor, 'post.cancel', row.id, { cancelled, notCancelled });
    return { postId: row.id, status, cancelled, notCancelled };
  }

  /**
   * Reschedule. Untrusted callers (MCP) get the post back as a draft with a fresh code;
   * trusted callers (UI) apply the change directly.
   */
  async reschedule(
    postId: string,
    schedule: ScheduleInput,
    networks: Network[] | undefined,
    actor: Actor,
    trusted: boolean,
  ): Promise<DraftPreview | PostView> {
    const row = this.getRow(postId);
    if (
      !OPEN_POST_STATUSES.includes(row.status as PostStatus) &&
      row.status !== 'failed' &&
      row.status !== 'partially_published'
    ) {
      throw new PosterError(
        'STATE_INVALID',
        `Post ${row.id} is ${row.status} and cannot be rescheduled.`,
      );
    }
    const settings = this.settings.get();
    const now = Date.now();
    const resolved = resolveSchedule(schedule, settings.defaultTz, now);
    const targets = this.targets(row.id);
    const wanted = networks?.length ? new Set(networks) : null;
    const movable = targets.filter(
      (t) =>
        (!wanted || wanted.has(t.network as Network)) &&
        !['publishing', 'published', 'cancelled'].includes(t.status),
    );
    if (movable.length === 0)
      throw new PosterError(
        'STATE_INVALID',
        'No target can be rescheduled (all published, cancelled or publishing).',
      );
    if (trusted)
      for (const t of movable)
        this.enforceMinGap(
          t.network as Network,
          resolved.atUtcMs,
          row.id,
          settings.minGapPerNetworkMinutes,
        );

    this.db.transaction((tx) => {
      for (const t of movable) {
        tx.update(postTargets)
          .set({
            scheduledAtUtc: resolved.atUtcMs,
            tz: resolved.tz,
            localInput: resolved.localInput,
            status: 'pending',
            nextAttemptAt: null,
            leaseUntil: null,
            lastErrorCode: null,
            lastErrorMsg: null,
            updatedAt: now,
          })
          .where(eq(postTargets.id, t.id))
          .run();
      }
      const scheduleOverrides = { ...(row.scheduleOverrides as Record<string, unknown>) };
      if (wanted) for (const n of wanted) scheduleOverrides[n] = schedule;
      const set: Partial<typeof posts.$inferInsert> = { updatedAt: now, scheduleOverrides };
      if (!wanted) {
        set.scheduledAtUtc = resolved.atUtcMs;
        set.tz = resolved.tz;
        set.localInput = resolved.localInput;
        set.scheduleOverrides = {};
      }
      if (!trusted) {
        set.status = 'draft';
        set.confirmedAt = null;
        set.expiresAt = now + settings.draftExpiryHours * 3600_000;
      } else {
        set.status = resolved.immediate ? 'queued' : 'scheduled';
      }
      tx.update(posts).set(set).where(eq(posts.id, row.id)).run();
    });
    this.audit.record(actor, 'post.reschedule', row.id, {
      to: resolved.isoUtc,
      networks: movable.map((t) => t.network),
      trusted,
    });
    if (!trusted) {
      this.events.emit({ type: 'post.updated', postId: row.id, status: 'draft' });
      return this.previewAndIssueCode(row.id, actor);
    }
    const status = this.recomputePostStatus(row.id);
    this.events.emit({ type: 'post.updated', postId: row.id, status });
    return this.get(row.id);
  }

  /** Re-queue failed / needs_auth / cancelled targets for an immediate attempt. */
  retry(
    postId: string,
    networks: Network[] | undefined,
    actor: Actor,
    opts: { now?: boolean } = {},
  ): PostView {
    const row = this.getRow(postId);
    if (row.status === 'draft') throw new PosterError('STATE_INVALID', 'Confirm the draft first.');
    const wanted = networks?.length ? new Set(networks) : null;
    const now = Date.now();
    let n = 0;
    for (const t of this.targets(row.id)) {
      if (wanted && !wanted.has(t.network as Network)) continue;
      if (!['failed', 'needs_auth', 'retrying', 'cancelled', 'pending'].includes(t.status))
        continue;
      if (t.status === 'pending' && !opts.now) continue;
      this.db
        .update(postTargets)
        .set({
          status: 'pending',
          nextAttemptAt: now,
          leaseUntil: null,
          lastErrorCode: null,
          lastErrorMsg: null,
          updatedAt: now,
          ...(opts.now ? { scheduledAtUtc: now, localInput: 'now' } : {}),
        })
        .where(eq(postTargets.id, t.id))
        .run();
      this.events.emit({
        type: 'target.updated',
        postId: row.id,
        targetId: t.id,
        network: t.network as Network,
        status: 'pending',
      });
      n++;
    }
    if (n === 0) throw new PosterError('STATE_INVALID', 'No target to retry.');
    const status = this.recomputePostStatus(row.id, opts.now ? 'queued' : 'scheduled');
    this.audit.record(actor, opts.now ? 'post.post_now' : 'post.retry', row.id, {
      networks: networks ?? 'all',
    });
    this.events.emit({ type: 'post.updated', postId: row.id, status });
    return this.get(row.id);
  }

  postNow(postId: string, networks: Network[] | undefined, actor: Actor): PostView {
    return this.retry(postId, networks, actor, { now: true });
  }

  /* ------------------------------------------------------------------ */
  /* Queries                                                              */
  /* ------------------------------------------------------------------ */

  get(postId: string, withAttempts = true): PostView {
    const row = this.getRow(postId);
    return this.toView(row, withAttempts);
  }

  list(input: ListPostsInput): PostList {
    const conds = [];
    if (input.status?.length) conds.push(inArray(posts.status, input.status));
    if (input.from) conds.push(gte(posts.scheduledAtUtc, Date.parse(input.from)));
    if (input.to) conds.push(lt(posts.scheduledAtUtc, Date.parse(input.to)));
    const onlyOpen =
      !!input.status?.length && input.status.every((s) => OPEN_POST_STATUSES.includes(s));
    if (input.cursor) {
      const [cAt, cId] = input.cursor.split('_');
      const at = Number(cAt);
      if (Number.isFinite(at) && cId) {
        conds.push(
          onlyOpen
            ? sql`(${posts.scheduledAtUtc} > ${at} or (${posts.scheduledAtUtc} = ${at} and ${posts.id} > ${cId}))`
            : sql`(${posts.scheduledAtUtc} < ${at} or (${posts.scheduledAtUtc} = ${at} and ${posts.id} < ${cId}))`,
        );
      }
    }
    const rows = this.db
      .select()
      .from(posts)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(
        ...(onlyOpen
          ? [asc(posts.scheduledAtUtc), asc(posts.id)]
          : [desc(posts.scheduledAtUtc), desc(posts.id)]),
      )
      .limit(input.limit + 1)
      .all();
    const page = rows.slice(0, input.limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => this.toView(r, false)),
      nextCursor: rows.length > input.limit && last ? `${last.scheduledAtUtc}_${last.id}` : null,
    };
  }

  counts(): { scheduled: number; publishing: number; failed24h: number } {
    const since = Date.now() - 24 * 3600_000;
    const c = (where: ReturnType<typeof and>) =>
      this.db
        .select({ n: sql<number>`count(*)` })
        .from(posts)
        .where(where)
        .get()?.n ?? 0;
    return {
      scheduled: c(inArray(posts.status, ['scheduled', 'queued'])),
      publishing: c(eq(posts.status, 'publishing')),
      failed24h: c(
        and(inArray(posts.status, ['failed', 'partially_published']), gte(posts.updatedAt, since)),
      ),
    };
  }

  /* ------------------------------------------------------------------ */
  /* Scheduler support                                                    */
  /* ------------------------------------------------------------------ */

  expireDrafts(now = Date.now()): number {
    const rows = this.db
      .select({ id: posts.id })
      .from(posts)
      .where(and(eq(posts.status, 'draft'), lt(posts.expiresAt, now)))
      .all();
    for (const r of rows) {
      this.setPostStatus(r.id, 'expired');
      this.codes.invalidate(r.id);
      this.audit.record('system', 'draft.expire', r.id);
    }
    return rows.length;
  }

  getRow(postId: string): PostRow {
    const row = this.db.select().from(posts).where(eq(posts.id, postId)).get();
    if (!row) throw new PosterError('NOT_FOUND', `Post ${postId} not found`);
    return row;
  }

  targets(postId: string): TargetRow[] {
    return this.db
      .select()
      .from(postTargets)
      .where(eq(postTargets.postId, postId))
      .orderBy(asc(postTargets.id))
      .all();
  }

  /** Build the render input for a stored post (frozen parts when targets carry them). */
  renderInput(row: PostRow, frozen = false): RenderInput {
    const pm = this.db
      .select()
      .from(postMedia)
      .where(eq(postMedia.postId, row.id))
      .orderBy(asc(postMedia.position))
      .all();
    const infos = new Map(
      this.media.getMany([...new Set(pm.map((m) => m.mediaId))]).map((i) => [i.id, i]),
    );
    const media: RenderInput['media'] = [];
    const mediaByNetwork: RenderInput['mediaByNetwork'] = {};
    for (const m of pm) {
      const info = infos.get(m.mediaId);
      if (!info) continue;
      const entry = { info, altText: m.altText ?? info.altText ?? null };
      if (m.network) (mediaByNetwork[m.network as Network] ??= []).push(entry);
      else media.push(entry);
    }
    const targets = this.targets(row.id);
    const targetIds: Partial<Record<Network, string>> = {};
    const frozenParts: Partial<Record<Network, string[]>> = {};
    for (const t of targets) {
      targetIds[t.network as Network] = t.id;
      if (frozen && t.renderedParts.length) frozenParts[t.network as Network] = t.renderedParts;
    }
    return {
      postId: row.id,
      baseText: row.baseText,
      threadMode: row.threadMode as 'auto' | 'off',
      networks: row.networks as Network[],
      overrides: row.overrides as Record<string, { text?: string; mediaIds?: string[] }>,
      media,
      mediaByNetwork,
      schedule: { atUtcMs: row.scheduledAtUtc, tz: row.tz, localInput: row.localInput },
      scheduleOverrides: row.scheduleOverrides as Record<string, unknown>,
      targetIds,
      frozenParts: frozen ? frozenParts : undefined,
    };
  }

  setPostStatus(postId: string, status: PostStatus): void {
    this.db.update(posts).set({ status, updatedAt: Date.now() }).where(eq(posts.id, postId)).run();
    this.events.emit({ type: 'post.updated', postId, status });
  }

  /** Derive the post status from its targets and persist it. */
  recomputePostStatus(postId: string, forced?: PostStatus): PostStatus {
    const row = this.getRow(postId);
    const targets = this.targets(postId);
    let status: PostStatus;
    if (forced) status = forced;
    else if (row.status === 'draft' || row.status === 'expired') status = row.status as PostStatus;
    else {
      const derived = derivePostStatus(targets.map((t) => ({ status: t.status as TargetStatus })));
      if (derived === 'scheduled') {
        const open = targets.filter((t) => !FINAL_TARGET_STATUSES.has(t.status as TargetStatus));
        status = open.every((t) => t.scheduledAtUtc <= Date.now()) ? 'queued' : 'scheduled';
      } else status = derived;
    }
    if (status !== row.status) {
      this.db
        .update(posts)
        .set({ status, updatedAt: Date.now() })
        .where(eq(posts.id, postId))
        .run();
      this.events.emit({ type: 'post.updated', postId, status });
    }
    return status;
  }

  /* ------------------------------------------------------------------ */
  /* Views                                                                */
  /* ------------------------------------------------------------------ */

  toView(row: PostRow, withAttempts: boolean): PostView {
    const targets = this.targets(row.id);
    const pm = this.db
      .select()
      .from(postMedia)
      .where(and(eq(postMedia.postId, row.id)))
      .orderBy(asc(postMedia.position))
      .all();
    const mediaInfos = pm.length ? this.media.getMany([...new Set(pm.map((m) => m.mediaId))]) : [];
    const byId = new Map(mediaInfos.map((m) => [m.id, m]));
    const sched = formatInZone(row.scheduledAtUtc, row.tz);
    return {
      id: row.id,
      status: row.status as PostStatus,
      baseText: row.baseText,
      threadMode: row.threadMode as 'auto' | 'off',
      schedule: {
        atUtcMs: row.scheduledAtUtc,
        tz: row.tz,
        ...sched,
        immediate: row.localInput === 'now',
      },
      source: row.source as 'mcp' | 'ui' | 'api',
      createdAt: row.createdAt,
      confirmedAt: row.confirmedAt,
      targets: targets.map((t) => this.targetView(t, withAttempts)),
      media: pm
        .filter((m) => !m.network)
        .map((m) => byId.get(m.mediaId))
        .filter((m): m is MediaInfo => !!m)
        .map((m) => this.media.summary(m)),
    };
  }

  targetView(t: TargetRow, withAttempts: boolean): TargetView {
    const sched = formatInZone(t.scheduledAtUtc, t.tz);
    const parts = t.renderedParts.length ? t.renderedParts : [t.textOverride ?? ''];
    return {
      id: t.id,
      network: t.network as Network,
      status: t.status as TargetStatus,
      schedule: {
        atUtcMs: t.scheduledAtUtc,
        tz: t.tz,
        ...sched,
        immediate: t.localInput === 'now',
      },
      attempts: t.attempts,
      nextAttemptAt: t.nextAttemptAt,
      publishedUrl: t.publishedUrl,
      remoteIds: t.remoteIds,
      lastErrorCode: t.lastErrorCode,
      lastErrorMessage: t.lastErrorMsg,
      text: parts.join('\n\n'),
      parts,
      attemptLog: withAttempts
        ? this.db
            .select()
            .from(attemptsTable)
            .where(eq(attemptsTable.targetId, t.id))
            .orderBy(desc(attemptsTable.startedAt))
            .all()
            .map((a) => ({
              id: a.id,
              startedAt: a.startedAt,
              finishedAt: a.finishedAt,
              outcome: a.outcome,
              errorCode: a.errorCode,
              errorMessage: a.errorMsg,
              screenshot: typeof a.debug.screenshot === 'string' ? a.id : null,
            }))
        : undefined,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Media helpers                                                        */
  /* ------------------------------------------------------------------ */

  private async collectMediaIds(
    input: Pick<CreateDraftInput, 'mediaIds' | 'mediaPaths' | 'altTexts'>,
  ): Promise<string[]> {
    const ids: string[] = [];
    for (const [i, p] of (input.mediaPaths ?? []).entries()) {
      const r = await this.media.ingestFromInbox(p, input.altTexts?.[i]);
      ids.push(r.id);
    }
    for (const id of input.mediaIds ?? []) {
      this.media.get(id); // throws NOT_FOUND
      ids.push(id);
    }
    return ids;
  }

  private postMediaIds(postId: string): string[] {
    return this.db
      .select({ mediaId: postMedia.mediaId })
      .from(postMedia)
      .where(and(eq(postMedia.postId, postId), sql`${postMedia.network} is null`))
      .orderBy(asc(postMedia.position))
      .all()
      .map((m) => m.mediaId);
  }

  private writePostMedia(
    tx: Db,
    postId: string,
    mediaIds: string[],
    altTexts: string[],
    overrides: Record<string, { text?: string; mediaIds?: string[] }>,
  ): void {
    mediaIds.forEach((mediaId, position) => {
      tx.insert(postMedia)
        .values({
          id: newId(),
          postId,
          mediaId,
          position,
          network: null,
          altText: altTexts[position] ?? null,
        })
        .run();
    });
    for (const [network, o] of Object.entries(overrides)) {
      if (!o?.mediaIds) continue;
      o.mediaIds.forEach((mediaId, position) => {
        const exists = tx
          .select({ id: mediaTable.id })
          .from(mediaTable)
          .where(eq(mediaTable.id, mediaId))
          .get();
        if (!exists)
          throw new PosterError(
            'NOT_FOUND',
            `overrides.${network}.mediaIds: media ${mediaId} not found`,
          );
        tx.insert(postMedia)
          .values({ id: newId(), postId, mediaId, position, network, altText: null })
          .run();
      });
    }
  }
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as T;
}

function codeMessage(code: string, preview: DraftPreview, expiresAt: number): string {
  const nets = preview.previews.map((p) => NETWORK_LABELS[p.network]).join(', ');
  const first = preview.previews[0]?.parts[0]?.text ?? '';
  const excerpt = first.length > 80 ? `${first.slice(0, 77)}…` : first;
  const minutes = Math.max(1, Math.round((expiresAt - Date.now()) / 60_000));
  return `Confirmation code for the post to ${nets} at ${preview.schedule.display}: ${code}\n"${excerpt}"\nReply "yes ${code}" to Hermes to publish, or "cancel". The code expires in ${minutes} min.`;
}
