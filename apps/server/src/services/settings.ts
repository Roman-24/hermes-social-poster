import { eq } from 'drizzle-orm';
import {
  DEFAULT_LIMITS,
  mergeLimits,
  PosterError,
  SettingsSchema,
  type Network,
  type NetworkLimits,
  type Settings,
} from '@poster/core';
import type { Db } from '../db/index.js';
import { secrets as secretsTable, settings as settingsTable } from '../db/schema.js';
import type { Vault } from '../vault.js';

/** Secret keys stored encrypted in the `secrets` table. */
export type SecretKey =
  | 'hermes.webhookSecret'
  | 'linkedin.clientId'
  | 'linkedin.clientSecret'
  | 'ui.passwordHash'
  | 'ui.totpSecret'
  | 'ui.totpPending';

const SETTINGS_ROW_KEY = 'app';

/**
 * Settings live as one JSON document under key "app" (merged over DEFAULT_SETTINGS on read).
 * Secrets live in `secrets`, AES-256-GCM encrypted with the key name as AAD.
 */
export class SettingsService {
  private cache: Settings | null = null;

  constructor(
    private readonly db: Db,
    private readonly vault: Vault,
  ) {}

  get(): Settings {
    if (this.cache) return this.cache;
    const row = this.db
      .select()
      .from(settingsTable)
      .where(eq(settingsTable.key, SETTINGS_ROW_KEY))
      .get();
    const parsed = SettingsSchema.safeParse(row?.value ?? {});
    this.cache = parsed.success ? parsed.data : SettingsSchema.parse({});
    return this.cache;
  }

  /**
   * Deep-merge a partial patch over the current settings and validate the result. The patch is
   * validated AFTER merging: zod's .partial() would otherwise fill defaults for omitted keys and
   * silently reset them.
   */
  update(patch: unknown): Settings {
    const current = this.get();
    if (
      patch !== undefined &&
      (patch === null || typeof patch !== 'object' || Array.isArray(patch))
    ) {
      throw new PosterError('VALIDATION', 'Settings patch must be an object.');
    }
    const merged = deepMerge(
      current as unknown as Record<string, unknown>,
      (patch ?? {}) as Record<string, unknown>,
    );
    const parsed = SettingsSchema.safeParse(merged);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i) => `${i.path.join('.') || 'settings'}: ${i.message}`)
        .join('; ');
      throw new PosterError('VALIDATION', `Invalid settings: ${detail}`);
    }
    const next = parsed.data;
    this.db
      .insert(settingsTable)
      .values({ key: SETTINGS_ROW_KEY, value: next, updatedAt: Date.now() })
      .onConflictDoUpdate({
        target: settingsTable.key,
        set: { value: next, updatedAt: Date.now() },
      })
      .run();
    this.cache = next;
    return next;
  }

  limits(): Record<Network, NetworkLimits> {
    const s = this.get();
    const merged = mergeLimits(DEFAULT_LIMITS, s.limits as never);
    // Nostr soft cap follows settings.nostr.softTextMax unless overridden explicitly.
    if (!(s.limits as Record<string, unknown>).nostr) {
      merged.nostr = { ...merged.nostr, text: { ...merged.nostr.text, max: s.nostr.softTextMax } };
    }
    return merged;
  }

  limitsFor(network: Network): NetworkLimits {
    return this.limits()[network];
  }

  /* ---------------- secrets ---------------- */

  getSecret<T = string>(key: SecretKey): T | null {
    const row = this.db.select().from(secretsTable).where(eq(secretsTable.key, key)).get();
    if (!row) return null;
    return this.vault.decrypt<T>(key, row.valueEnc);
  }

  setSecret(key: SecretKey, value: unknown): void {
    if (value === null || value === undefined || value === '') {
      this.db.delete(secretsTable).where(eq(secretsTable.key, key)).run();
      return;
    }
    const enc = this.vault.encrypt(key, value);
    this.db
      .insert(secretsTable)
      .values({ key, valueEnc: enc, updatedAt: Date.now() })
      .onConflictDoUpdate({
        target: secretsTable.key,
        set: { valueEnc: enc, updatedAt: Date.now() },
      })
      .run();
  }

  hasSecret(key: SecretKey): boolean {
    return !!this.db
      .select({ key: secretsTable.key })
      .from(secretsTable)
      .where(eq(secretsTable.key, key))
      .get();
  }

  /** Re-encrypt all secrets with a new vault (key rotation). */
  reencryptAll(newVault: Vault): number {
    const rows = this.db.select().from(secretsTable).all();
    for (const row of rows) {
      const plain = this.vault.decrypt(row.key, row.valueEnc);
      this.db
        .update(secretsTable)
        .set({ valueEnc: newVault.encrypt(row.key, plain), updatedAt: Date.now() })
        .where(eq(secretsTable.key, row.key))
        .run();
    }
    return rows.length;
  }

  invalidate(): void {
    this.cache = null;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const b = out[k];
    out[k] = isPlainObject(b) && isPlainObject(v) ? deepMerge(b, v) : v;
  }
  return out;
}
