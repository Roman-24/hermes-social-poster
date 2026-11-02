import { eq } from 'drizzle-orm';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  NETWORKS,
  PosterError,
  type AccountConnectionStatus,
  type AccountPatch,
  type AccountState,
  type AccountStatus,
  type AccountView,
  type AdapterContext,
  type ConnectResult,
  type Network,
  type NetworkAdapter,
} from '@poster/core';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { accounts } from '../db/schema.js';
import type { Logger } from '../logger.js';
import type { Vault } from '../vault.js';
import type { AuditService } from './audit.js';
import type { EventBus } from './events.js';
import type { SettingsService } from './settings.js';

export type AdapterRegistry = Record<Network, NetworkAdapter>;

export class AccountService {
  constructor(
    private readonly db: Db,
    private readonly vault: Vault,
    private readonly settings: SettingsService,
    private readonly adapters: AdapterRegistry,
    private readonly config: Config,
    private readonly events: EventBus,
    private readonly audit: AuditService,
    private readonly logger: Logger,
  ) {}

  adapter(network: Network): NetworkAdapter {
    const a = this.adapters[network];
    if (!a) throw new PosterError('NOT_FOUND', `Unknown network ${network}`);
    return a;
  }

  adapterContext(network: Network, attemptKey?: string): AdapterContext {
    return {
      logger: this.logger.child({ network, attemptKey }),
      settings: this.settings.get(),
      limits: this.settings.limitsFor(network),
      dataDir: join(this.config.browserDir, network),
      debugDir: this.config.debugDir,
      chromiumPath: this.config.CHROMIUM_PATH,
    };
  }

  /** Decrypted state or null when no row exists. */
  getState(network: Network): AccountState | null {
    const row = this.db.select().from(accounts).where(eq(accounts.network, network)).get();
    if (!row) return null;
    let secrets: Record<string, unknown> | null = null;
    if (row.secretsEnc) {
      try {
        secrets = this.vault.decrypt<Record<string, unknown>>(`account:${network}`, row.secretsEnc);
      } catch (err) {
        this.logger.error({ err, network }, 'cannot decrypt account secrets');
      }
    }
    return {
      network,
      status: row.status as AccountConnectionStatus,
      handle: row.handle,
      secrets,
      meta: row.meta ?? {},
      browserProfileDir: row.browserProfileDir,
      proxy: row.proxy,
    };
  }

  profileDirFor(network: Network): string {
    return join(this.config.browserDir, network, 'profile');
  }

  async saveConnection(
    network: Network,
    result: ConnectResult,
    actor: 'ui' | 'system' = 'ui',
  ): Promise<AccountView> {
    const now = Date.now();
    const adapter = this.adapter(network);
    const browserProfileDir =
      adapter.connect.kind === 'browser' ? this.profileDirFor(network) : null;
    const existing = this.db.select().from(accounts).where(eq(accounts.network, network)).get();
    const values = {
      handle: result.handle,
      status: 'connected' as const,
      secretsEnc: this.vault.encrypt(`account:${network}`, result.secrets),
      meta: { ...(existing?.meta ?? {}), ...result.meta },
      browserProfileDir,
      updatedAt: now,
    };
    if (existing) {
      this.db.update(accounts).set(values).where(eq(accounts.network, network)).run();
    } else {
      this.db
        .insert(accounts)
        .values({ network, createdAt: now, ...values })
        .run();
    }
    this.audit.record(actor, 'account.connect', network, { handle: result.handle });
    this.events.emit({ type: 'account.updated', network, status: 'connected' });
    return this.view(network, true);
  }

  async patch(network: Network, patch: AccountPatch): Promise<void> {
    const existing = this.db.select().from(accounts).where(eq(accounts.network, network)).get();
    if (!existing) return;
    const set: Partial<typeof accounts.$inferInsert> = { updatedAt: Date.now() };
    if (patch.secrets !== undefined) {
      set.secretsEnc = patch.secrets
        ? this.vault.encrypt(`account:${network}`, patch.secrets)
        : null;
    }
    if (patch.meta) set.meta = { ...(existing.meta ?? {}), ...patch.meta };
    if (patch.handle !== undefined) set.handle = patch.handle;
    if (patch.status) set.status = patch.status;
    this.db.update(accounts).set(set).where(eq(accounts.network, network)).run();
    if (patch.status) this.events.emit({ type: 'account.updated', network, status: patch.status });
  }

  markNeedsAuth(network: Network, reason: string): void {
    const existing = this.db.select().from(accounts).where(eq(accounts.network, network)).get();
    if (!existing || existing.status === 'needs_auth') return;
    this.db
      .update(accounts)
      .set({ status: 'needs_auth', updatedAt: Date.now() })
      .where(eq(accounts.network, network))
      .run();
    this.audit.record('system', 'account.needs_auth', network, { reason });
    this.events.emit({ type: 'account.updated', network, status: 'needs_auth' });
  }

  setProxy(network: Network, proxy: string | null): void {
    this.db
      .update(accounts)
      .set({ proxy, updatedAt: Date.now() })
      .where(eq(accounts.network, network))
      .run();
  }

  recordSelfTest(network: Network, result: { at: number; ok: boolean; message?: string }): void {
    this.db
      .update(accounts)
      .set({ lastSelfTest: result, updatedAt: Date.now() })
      .where(eq(accounts.network, network))
      .run();
  }

  disconnect(network: Network, actor: 'ui' | 'system' = 'ui'): AccountView {
    const existing = this.db.select().from(accounts).where(eq(accounts.network, network)).get();
    if (existing) {
      this.db
        .update(accounts)
        .set({
          status: 'disconnected',
          secretsEnc: null,
          handle: null,
          meta: {},
          lastSelfTest: null,
          updatedAt: Date.now(),
        })
        .where(eq(accounts.network, network))
        .run();
      if (existing.browserProfileDir && existsSync(existing.browserProfileDir)) {
        try {
          rmSync(existing.browserProfileDir, { recursive: true, force: true });
        } catch (err) {
          this.logger.warn({ err, network }, 'could not remove browser profile');
        }
      }
    }
    this.audit.record(actor, 'account.disconnect', network);
    this.events.emit({ type: 'account.updated', network, status: 'disconnected' });
    return this.viewSync(network, null);
  }

  /** Status via the adapter (may do a cheap remote call when `refresh`). */
  async status(network: Network, refresh = false): Promise<AccountStatus> {
    const adapter = this.adapter(network);
    const state = this.getState(network);
    const ctx = this.adapterContext(network);
    if (!refresh) return this.cheapStatus(network, state, ctx);
    try {
      const status = await adapter.connectionStatus(state, ctx);
      if (state && status.status !== state.status && status.status !== 'disconnected') {
        await this.patch(network, { status: status.status });
      }
      return status;
    } catch (err) {
      this.logger.warn({ err, network }, 'connectionStatus failed');
      const s = this.cheapStatus(network, state, ctx);
      s.warnings.push(`Status check failed: ${err instanceof Error ? err.message : String(err)}`);
      return s;
    }
  }

  private cheapStatus(
    network: Network,
    state: AccountState | null,
    ctx: AdapterContext,
  ): AccountStatus {
    const connected = !!state?.secrets && state.status === 'connected';
    const expiresAt = typeof state?.meta.expiresAt === 'number' ? state.meta.expiresAt : null;
    const warnings: string[] = [];
    if (expiresAt && expiresAt - Date.now() < 7 * 24 * 3600_000) {
      const days = Math.max(0, Math.round((expiresAt - Date.now()) / (24 * 3600_000)));
      warnings.push(
        expiresAt < Date.now()
          ? 'Access token has expired. Reconnect.'
          : `Access token expires in ${days} day(s). Reconnect soon.`,
      );
    }
    if (state?.status === 'needs_auth')
      warnings.push('Login required. Reconnect from this screen.');
    return {
      network,
      connected,
      status: state?.status ?? 'disconnected',
      handle: state?.handle ?? null,
      limits: ctx.limits,
      warnings,
      expiresAt,
      details: publicMeta(state?.meta ?? {}),
      lastSelfTest: null,
    };
  }

  async view(network: Network, refresh = false): Promise<AccountView> {
    const status = await this.status(network, refresh);
    return this.viewSync(network, status);
  }

  private viewSync(network: Network, status: AccountStatus | null): AccountView {
    const adapter = this.adapter(network);
    const ctx = this.adapterContext(network);
    const state = this.getState(network);
    const s = status ?? this.cheapStatus(network, state, ctx);
    const row = this.db
      .select({ lastSelfTest: accounts.lastSelfTest })
      .from(accounts)
      .where(eq(accounts.network, network))
      .get();
    const limits = s.limits;
    return {
      network,
      connected: s.connected,
      status: s.status,
      handle: s.handle,
      expiresAt: s.expiresAt,
      warnings: s.warnings,
      details: s.details,
      limits: {
        text: {
          max: limits.text.max,
          unit: limits.text.unit,
          ...(limits.text.secondaryMaxBytes
            ? { secondaryMaxBytes: limits.text.secondaryMaxBytes }
            : {}),
        },
        images: { max: limits.images.max, maxBytes: limits.images.maxBytes },
        video: limits.video
          ? {
              max: limits.video.max,
              maxBytes: limits.video.maxBytes,
              maxDurationMs: limits.video.maxDurationMs,
            }
          : null,
        threads: limits.threads,
        notes: [...limits.notes],
      },
      connectKind: adapter.connect.kind,
      connectFields: adapter.connect.kind === 'credentials' ? adapter.connect.fields : undefined,
      lastSelfTest: row?.lastSelfTest ?? s.lastSelfTest ?? null,
      canTestPost: typeof adapter.testPost === 'function' && s.connected,
    };
  }

  async listViews(refresh = false): Promise<AccountView[]> {
    return Promise.all(NETWORKS.map((n) => this.view(n, refresh)));
  }

  /** Accounts that have secrets and are usable for publishing. */
  connectedNetworks(): Network[] {
    return NETWORKS.filter((n) => {
      const s = this.getState(n);
      return !!s?.secrets && s.status === 'connected';
    });
  }

  /** Re-encrypt every account row with a new vault (key rotation). */
  reencryptAll(newVault: Vault): number {
    const rows = this.db.select().from(accounts).all();
    let n = 0;
    for (const row of rows) {
      if (!row.secretsEnc) continue;
      const plain = this.vault.decrypt(`account:${row.network}`, row.secretsEnc);
      this.db
        .update(accounts)
        .set({
          secretsEnc: newVault.encrypt(`account:${row.network}`, plain),
          updatedAt: Date.now(),
        })
        .where(eq(accounts.network, row.network))
        .run();
      n++;
    }
    return n;
  }
}

const PRIVATE_META =
  /^(session|cookies|token|secret|password|sk|apiKey|accessToken|refreshToken)$/i;
function publicMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) if (!PRIVATE_META.test(k)) out[k] = v;
  return out;
}
