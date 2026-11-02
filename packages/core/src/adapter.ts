import type { Issue } from './issues.js';
import type { NetworkLimits } from './limits.js';
import type { Network } from './networks.js';
import type { PublishResult, RenderedPost } from './post.js';
import type { Settings } from './settings.js';
import type { AccountConnectionStatus } from './states.js';

/** Minimal structural logger (pino-compatible). */
export interface Logger {
  debug(obj: unknown, msg?: string): void;
  debug(msg: string): void;
  info(obj: unknown, msg?: string): void;
  info(msg: string): void;
  warn(obj: unknown, msg?: string): void;
  warn(msg: string): void;
  error(obj: unknown, msg?: string): void;
  error(msg: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

/** Network-specific decrypted secrets (opaque JSON). Never logged, never returned by MCP. */
export type AccountSecrets = Record<string, unknown>;

export interface AccountState {
  network: Network;
  status: AccountConnectionStatus;
  handle: string | null;
  /** Decrypted secrets, or null when disconnected. */
  secrets: AccountSecrets | null;
  /** Non-secret metadata: URN, FID, pubkey, token expiry, email verified… */
  meta: Record<string, unknown>;
  /** Absolute path of the persistent Chromium profile (X, Farcaster). */
  browserProfileDir: string | null;
  /** Optional outbound proxy for this account's browser profile (e.g. socks5://100.x.y.z:1055). */
  proxy: string | null;
}

export interface AccountPatch {
  secrets?: AccountSecrets | null;
  meta?: Record<string, unknown>;
  handle?: string | null;
  status?: AccountConnectionStatus;
}

export interface AccountStatus {
  network: Network;
  connected: boolean;
  status: AccountConnectionStatus;
  handle: string | null;
  limits: NetworkLimits;
  warnings: string[];
  /** Epoch ms when a token/session expires, if applicable. */
  expiresAt: number | null;
  /** Public, non-secret details for the Accounts screen. */
  details: Record<string, unknown>;
  lastSelfTest?: { at: number; ok: boolean; message?: string } | null;
}

/** Everything an adapter needs beyond the post itself. */
export interface AdapterContext {
  logger: Logger;
  settings: Settings;
  limits: NetworkLimits;
  /** Writable data dir for this network (browser profiles, caches). */
  dataDir: string;
  /** Where debug screenshots go (attempt-scoped). */
  debugDir: string;
  /** Path of the Chromium binary, or undefined to let Playwright resolve it. */
  chromiumPath?: string;
}

export interface PublishCtx extends AdapterContext {
  /** Unique per attempt; adapters use it for idempotency where the network allows. */
  attemptKey: string;
  account: AccountState;
  /** Persist refreshed secrets/meta (e.g. refreshed Bluesky session, updated X cookies). */
  updateAccount(patch: AccountPatch): Promise<void>;
  /** Cache Blossom URLs on a media row so re-publishes do not re-upload. */
  cacheMediaUrls?(mediaId: string, urls: string[]): Promise<void>;
  signal?: AbortSignal;
}

export interface SelfTestResult {
  ok: boolean;
  message: string;
  details?: Record<string, unknown>;
}

/** Credential-style connect (Nostr nsec, Bluesky handle + app password). */
export interface CredentialsConnect {
  kind: 'credentials';
  /** Fields to render in the UI. */
  fields: { name: string; label: string; secret: boolean; placeholder?: string }[];
  connect(input: Record<string, string>, ctx: AdapterContext): Promise<ConnectResult>;
}

/** OAuth 2.0 (LinkedIn). The server owns the redirect route and PKCE state. */
export interface OAuthConnect {
  kind: 'oauth';
  authorizeUrl(params: {
    redirectUri: string;
    state: string;
    codeChallenge: string;
    clientId: string;
  }): string;
  exchangeCode(
    params: {
      code: string;
      redirectUri: string;
      codeVerifier: string;
      clientId: string;
      clientSecret: string;
    },
    ctx: AdapterContext,
  ): Promise<ConnectResult>;
}

/** Browser login streamed to the UI (X, Farcaster). */
export interface BrowserConnect {
  kind: 'browser';
  startUrl: string;
  /** Hostname allowlist for navigation inside the remote session. */
  allowedHosts: string[];
  /** Called after each navigation / periodically; true once the user is logged in. */
  detectLoggedIn(page: BrowserPageLike): Promise<boolean>;
  /** Pull what the adapter needs from the live profile (cookies → rettiwt key, handle…). */
  capture(page: BrowserPageLike, ctx: AdapterContext): Promise<ConnectResult>;
}

export type ConnectFlow = CredentialsConnect | OAuthConnect | BrowserConnect;

export interface ConnectResult {
  handle: string | null;
  secrets: AccountSecrets;
  meta: Record<string, unknown>;
  warnings?: string[];
}

/**
 * Loose structural type for a Playwright `Page` so core does not depend on playwright.
 * Adapters cast to the real type.
 */
export interface BrowserPageLike {
  url(): string;
  context(): unknown;
}

export interface NetworkAdapter {
  readonly id: Network;
  /** Static capabilities; `ctx.limits` carries runtime overrides. */
  readonly capabilities: NetworkLimits;
  readonly connect: ConnectFlow;
  /** Pre-preview validation of the rendered post. */
  validate(post: RenderedPost, account: AccountState | null, ctx: AdapterContext): Issue[];
  /** Cheap status: decrypted secrets present, expiry, warnings. May do a read-only remote call. */
  connectionStatus(account: AccountState | null, ctx: AdapterContext): Promise<AccountStatus>;
  /** Publish all parts. Throw PosterError(AUTH_REQUIRED) on logged-out sessions. */
  publish(post: RenderedPost, ctx: PublishCtx): Promise<PublishResult>;
  /** Read-only nightly check (selectors, auth). */
  selfTest?(account: AccountState, ctx: AdapterContext): Promise<SelfTestResult>;
  /** Best-effort: find a recently published post with this text (X UNKNOWN_OUTCOME recovery). */
  findRecent?(
    text: string,
    account: AccountState,
    ctx: AdapterContext,
  ): Promise<{ url: string; remoteId: string } | null>;
  /** Optional "Test post to self" where the network allows a harmless self-visible post. */
  testPost?(account: AccountState, ctx: PublishCtx): Promise<PublishResult>;
}
