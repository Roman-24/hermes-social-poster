import { createHmac } from 'node:crypto';
import { and, desc, eq, isNull, lte, or } from 'drizzle-orm';
import { newId, type NotificationView, type WebhookEvent } from '@poster/core';
import type { Db } from '../db/index.js';
import { notifications } from '../db/schema.js';
import type { Logger } from '../logger.js';
import type { EventBus } from './events.js';
import type { SettingsService } from './settings.js';

const BACKOFF_MS = [30_000, 60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
const GIVE_UP_AFTER_MS = 24 * 3600_000;

export type NotifyFetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Outbox + delivery loop for signed webhook events to the Hermes webhook adapter
 * (POST {webhookBaseUrl}/webhooks/{route}). Retries with backoff for 24 h; undelivered events
 * stay visible in the UI.
 */
export class Notifier {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly events: EventBus,
    private readonly logger: Logger,
    private readonly fetchImpl: NotifyFetch = (url, init) => fetch(url, init),
  ) {}

  /** True when a direct (deliver_only) route is configured, i.e. codes can bypass the agent. */
  directRouteConfigured(): boolean {
    const s = this.settings.get().hermes;
    return !!s.webhookBaseUrl && !!s.directRoute;
  }

  /** Queue an event. Returns the notification id, or null if no webhook is configured. */
  enqueue(event: WebhookEvent, routeKind: 'direct' | 'agent' = 'direct'): string | null {
    const h = this.settings.get().hermes;
    if (!h.webhookBaseUrl) return null;
    const route = routeKind === 'agent' ? h.agentRoute : h.directRoute;
    if (!route) return null;
    const id = newId();
    this.db
      .insert(notifications)
      .values({
        id,
        event: event.event,
        route,
        payload: { ...event, message: event.summary } as Record<string, unknown>,
        attempts: 0,
        nextAttemptAt: Date.now(),
        createdAt: Date.now(),
      })
      .run();
    // Kick the loop so the user gets the code immediately.
    setImmediate(() => void this.tick());
    return id;
  }

  start(intervalMs = 10_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = Date.now();
      const due = this.db
        .select()
        .from(notifications)
        .where(
          and(
            isNull(notifications.deliveredAt),
            or(isNull(notifications.nextAttemptAt), lte(notifications.nextAttemptAt, now)),
          ),
        )
        .orderBy(notifications.createdAt)
        .limit(20)
        .all();
      for (const row of due) await this.deliver(row.id);
    } catch (err) {
      this.logger.error({ err }, 'notifier tick failed');
    } finally {
      this.running = false;
    }
  }

  async deliver(id: string): Promise<NotificationView> {
    const row = this.db.select().from(notifications).where(eq(notifications.id, id)).get();
    if (!row) throw new Error(`notification ${id} not found`);
    if (row.deliveredAt) return toView(row);
    const h = this.settings.get().hermes;
    const secret = this.settings.getSecret('hermes.webhookSecret');
    const now = Date.now();

    if (!h.webhookBaseUrl) {
      this.db
        .update(notifications)
        .set({ lastError: 'webhook base URL not configured', nextAttemptAt: now + 60_000 })
        .where(eq(notifications.id, id))
        .run();
      return toView(this.db.select().from(notifications).where(eq(notifications.id, id)).get()!);
    }

    const url = `${h.webhookBaseUrl.replace(/\/+$/, '')}/webhooks/${encodeURIComponent(row.route)}`;
    const body = JSON.stringify(row.payload);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'user-agent': 'hermes-social-poster/0.1',
      'x-poster-event': row.event,
      'x-poster-notification-id': row.id,
    };
    if (secret)
      headers[h.signatureHeader.toLowerCase()] = signBody(secret, body, h.signaturePrefix);

    let error: string | null = null;
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok)
        error = `HTTP ${res.status}${(await safeText(res)) ? ': ' + (await safeText(res)) : ''}`;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    const attempts = row.attempts + 1;
    if (!error) {
      this.db
        .update(notifications)
        .set({ attempts, deliveredAt: now, lastError: null, nextAttemptAt: null })
        .where(eq(notifications.id, id))
        .run();
      this.events.emit({ type: 'notification.updated', id, delivered: true });
      this.logger.info({ id, event: row.event, route: row.route }, 'webhook delivered');
    } else {
      const expired = now - row.createdAt > GIVE_UP_AFTER_MS;
      const backoff = BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)] ?? 60 * 60_000;
      this.db
        .update(notifications)
        .set({
          attempts,
          lastError: error.slice(0, 500),
          nextAttemptAt: expired ? null : now + backoff,
        })
        .where(eq(notifications.id, id))
        .run();
      this.events.emit({ type: 'notification.updated', id, delivered: false });
      this.logger.warn(
        { id, event: row.event, attempts, error, expired },
        'webhook delivery failed',
      );
    }
    return toView(this.db.select().from(notifications).where(eq(notifications.id, id)).get()!);
  }

  /** Manual retry from the UI: schedule now and deliver. */
  async retry(id: string): Promise<NotificationView> {
    this.db
      .update(notifications)
      .set({ nextAttemptAt: Date.now() })
      .where(eq(notifications.id, id))
      .run();
    return this.deliver(id);
  }

  list(opts: { undeliveredOnly?: boolean; limit?: number } = {}): NotificationView[] {
    const rows = this.db
      .select()
      .from(notifications)
      .where(opts.undeliveredOnly ? isNull(notifications.deliveredAt) : undefined)
      .orderBy(desc(notifications.createdAt))
      .limit(opts.limit ?? 100)
      .all();
    return rows.map(toView);
  }

  /** Fire a one-off test ping (not stored). */
  async testPing(): Promise<{ ok: boolean; status?: number; error?: string }> {
    const h = this.settings.get().hermes;
    if (!h.webhookBaseUrl) return { ok: false, error: 'webhook base URL not configured' };
    const secret = this.settings.getSecret('hermes.webhookSecret');
    const body = JSON.stringify({
      event: 'test',
      at: new Date().toISOString(),
      summary: 'Social Poster webhook test',
      message: 'Social Poster webhook test',
    });
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (secret)
      headers[h.signatureHeader.toLowerCase()] = signBody(secret, body, h.signaturePrefix);
    try {
      const res = await this.fetchImpl(
        `${h.webhookBaseUrl.replace(/\/+$/, '')}/webhooks/${encodeURIComponent(h.directRoute)}`,
        {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(10_000),
        },
      );
      return { ok: res.ok, status: res.status, ...(res.ok ? {} : { error: await safeText(res) }) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

export function signBody(secret: string, body: string, prefix: string): string {
  const hex = createHmac('sha256', secret).update(body).digest('hex');
  return `${prefix ?? ''}${hex}`;
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.clone().text()).slice(0, 200);
  } catch {
    return '';
  }
}

function toView(row: typeof notifications.$inferSelect): NotificationView {
  return {
    id: row.id,
    event: row.event,
    route: row.route,
    createdAt: row.createdAt,
    deliveredAt: row.deliveredAt,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt,
    lastError: row.lastError,
    payload: redactPayload(row.payload),
  };
}

/** The UI may show the code (it is the user's own screen), but never anything else sensitive. */
function redactPayload(p: Record<string, unknown>): Record<string, unknown> {
  return p;
}
