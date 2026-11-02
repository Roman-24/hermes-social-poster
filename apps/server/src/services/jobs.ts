import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DateTime } from 'luxon';
import { FINAL_POST_STATUSES, NETWORK_LABELS, NETWORKS, type Network } from '@poster/core';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { media as mediaTable, posts, postMedia, postTargets } from '../db/schema.js';
import type { Logger } from '../logger.js';
import type { AccountService } from './accounts.js';
import type { AuditService } from './audit.js';
import type { MediaService } from './media.js';
import type { Notifier } from './notifier.js';
import type { SettingsService } from './settings.js';

/**
 * Daily housekeeping: media/screenshot retention, token-expiry warnings, nightly browser
 * selector self-test. Runs on a 10-minute check and fires each job at most once per day.
 */
export class Jobs {
  private timer: NodeJS.Timeout | null = null;
  private lastRetentionDay = '';
  private lastExpiryDay = '';
  private lastSelfTestDay = '';

  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly settings: SettingsService,
    private readonly accounts: AccountService,
    private readonly media: MediaService,
    private readonly notifier: Notifier,
    private readonly audit: AuditService,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 10 * 60_000);
    this.timer.unref();
    setTimeout(() => void this.tick(), 30_000).unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(now = DateTime.now()): Promise<void> {
    const tz = this.settings.get().defaultTz;
    const local = now.setZone(tz);
    const day = local.toISODate() ?? '';
    try {
      if (this.lastRetentionDay !== day && local.hour >= 3) {
        this.lastRetentionDay = day;
        this.runRetention();
      }
      if (this.lastExpiryDay !== day && local.hour >= 9) {
        this.lastExpiryDay = day;
        this.warnExpiringTokens();
      }
      const s = this.settings.get().selfTest;
      if (s.enabled && this.lastSelfTestDay !== day && local.hour >= s.hour) {
        this.lastSelfTestDay = day;
        await this.runSelfTests();
      }
    } catch (err) {
      this.logger.error({ err }, 'jobs tick failed');
    }
  }

  /** Delete media files and debug screenshots N days after their post is final; rows stay. */
  runRetention(): { media: number; screenshots: number } {
    const days = this.settings.get().retentionDays;
    const cutoff = Date.now() - days * 24 * 3600_000;
    const finalPosts = this.db
      .select({ id: posts.id })
      .from(posts)
      .where(and(inArray(posts.status, [...FINAL_POST_STATUSES]), lt(posts.updatedAt, cutoff)))
      .all()
      .map((p) => p.id);
    let purged = 0;
    if (finalPosts.length) {
      const candidates = this.db
        .selectDistinct({ mediaId: postMedia.mediaId })
        .from(postMedia)
        .where(inArray(postMedia.postId, finalPosts))
        .all()
        .map((m) => m.mediaId);
      // Only purge media not referenced by any non-final post.
      const stillUsed = new Set(
        candidates.length
          ? this.db
              .selectDistinct({ mediaId: postMedia.mediaId })
              .from(postMedia)
              .innerJoin(posts, eq(posts.id, postMedia.postId))
              .where(
                and(
                  inArray(postMedia.mediaId, candidates),
                  sql`${posts.status} not in ('published','partially_published','failed','cancelled','expired')`,
                ),
              )
              .all()
              .map((m) => m.mediaId)
          : [],
      );
      purged = this.media.purgeFiles(candidates.filter((id) => !stillUsed.has(id)));
    }
    // Orphan uploads never attached to a post.
    const orphans = this.db
      .select({ id: mediaTable.id })
      .from(mediaTable)
      .leftJoin(postMedia, eq(postMedia.mediaId, mediaTable.id))
      .where(
        and(isNull(postMedia.id), lt(mediaTable.createdAt, cutoff), isNull(mediaTable.purgedAt)),
      )
      .all()
      .map((m) => m.id);
    purged += this.media.purgeFiles(orphans);

    let shots = 0;
    if (existsSync(this.config.debugDir)) {
      for (const f of readdirSync(this.config.debugDir)) {
        const p = join(this.config.debugDir, f);
        try {
          if (statSync(p).mtimeMs < cutoff) {
            rmSync(p, { force: true });
            shots++;
          }
        } catch {
          /* ignore */
        }
      }
    }
    if (purged || shots) {
      this.audit.record('system', 'retention.run', null, {
        media: purged,
        screenshots: shots,
        days,
      });
      this.logger.info({ media: purged, screenshots: shots }, 'retention run');
    }
    return { media: purged, screenshots: shots };
  }

  /** LinkedIn (and any adapter exposing meta.expiresAt): warn 7 days before expiry, once a day. */
  warnExpiringTokens(): void {
    for (const network of NETWORKS) {
      const state = this.accounts.getState(network);
      const expiresAt = typeof state?.meta.expiresAt === 'number' ? state.meta.expiresAt : null;
      if (!state?.secrets || !expiresAt) continue;
      const daysLeft = (expiresAt - Date.now()) / (24 * 3600_000);
      if (daysLeft > 7) continue;
      const summary =
        daysLeft < 0
          ? `${NETWORK_LABELS[network]}: access token has expired. Reconnect in the UI (Accounts → ${NETWORK_LABELS[network]}).`
          : `${NETWORK_LABELS[network]}: access token expires in ${Math.max(0, Math.ceil(daysLeft))} day(s). Reconnect in the UI to renew it.`;
      this.notifier.enqueue({
        event: 'token_expiring',
        network,
        expiresAt: new Date(expiresAt).toISOString(),
        at: new Date().toISOString(),
        summary,
      });
      if (daysLeft < 0) this.accounts.markNeedsAuth(network, 'token expired');
    }
  }

  /** Nightly read-only check of browser selectors and auth for each connected account. */
  async runSelfTests(only?: Network[]): Promise<Record<string, { ok: boolean; message: string }>> {
    const out: Record<string, { ok: boolean; message: string }> = {};
    for (const network of only ?? NETWORKS) {
      const adapter = this.accounts.adapter(network);
      const state = this.accounts.getState(network);
      if (!adapter.selfTest || !state?.secrets) continue;
      try {
        const r = await adapter.selfTest(state, this.accounts.adapterContext(network));
        out[network] = { ok: r.ok, message: r.message };
        this.accounts.recordSelfTest(network, { at: Date.now(), ok: r.ok, message: r.message });
        if (!r.ok) {
          this.notifier.enqueue({
            event: 'self_test_failed',
            network,
            message: r.message,
            at: new Date().toISOString(),
            summary: `${NETWORK_LABELS[network]} self-test failed: ${r.message}`,
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        out[network] = { ok: false, message };
        this.accounts.recordSelfTest(network, { at: Date.now(), ok: false, message });
        this.notifier.enqueue({
          event: 'self_test_failed',
          network,
          message,
          at: new Date().toISOString(),
          summary: `${NETWORK_LABELS[network]} self-test failed: ${message}`,
        });
      }
    }
    this.audit.record('system', 'selftest.run', null, out);
    return out;
  }

  /** Count open targets per network (for /system). */
  openTargets(): Record<string, number> {
    const rows = this.db
      .select({ network: postTargets.network, n: sql<number>`count(*)` })
      .from(postTargets)
      .where(inArray(postTargets.status, ['pending', 'retrying', 'publishing']))
      .groupBy(postTargets.network)
      .all();
    return Object.fromEntries(rows.map((r) => [r.network, r.n]));
  }
}
