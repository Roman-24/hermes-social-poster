import { desc, lt } from 'drizzle-orm';
import { newId, type Actor } from '@poster/core';
import type { Db } from '../db/index.js';
import { auditLog } from '../db/schema.js';

export interface AuditEntry {
  id: string;
  at: number;
  actor: Actor;
  action: string;
  entity: string | null;
  details: Record<string, unknown>;
}

export class AuditService {
  constructor(private readonly db: Db) {}

  record(
    actor: Actor,
    action: string,
    entity?: string | null,
    details: Record<string, unknown> = {},
  ): void {
    this.db
      .insert(auditLog)
      .values({
        id: newId(),
        at: Date.now(),
        actor,
        action,
        entity: entity ?? null,
        details: scrub(details),
      })
      .run();
  }

  list(limit = 100, cursor?: string): { items: AuditEntry[]; nextCursor: string | null } {
    const rows = this.db
      .select()
      .from(auditLog)
      .where(cursor ? lt(auditLog.id, cursor) : undefined)
      .orderBy(desc(auditLog.id))
      .limit(limit + 1)
      .all();
    const items = rows.slice(0, limit).map((r) => ({ ...r, actor: r.actor as Actor }));
    return {
      items,
      nextCursor: rows.length > limit ? (items[items.length - 1]?.id ?? null) : null,
    };
  }
}

const SECRET_KEYS =
  /^(secret|token|password|cookie|nsec|apikey|apiKey|appPassword|accessToken|refreshToken|sk|authorization)$/i;

/** Defensive: never let a secret-looking key into the audit log. */
export function scrub<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => scrub(v)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.test(k) ? '[redacted]' : scrub(v);
    }
    return out as T;
  }
  return value;
}
