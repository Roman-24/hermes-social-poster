import { resolve } from 'node:path';
import { z } from 'zod';

/**
 * Process configuration from the environment. Secrets never come from env in production:
 * the master key is a file (Podman secret), tokens live hashed in the DB.
 */
const EnvSchema = z.object({
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().default(8787),
  /** Writable data volume. */
  DATA_DIR: z.string().default('/data'),
  /** Read-only mount of the SimpleX files folder. */
  INBOX_DIR: z.string().default('/inbox'),
  /** Host-side prefix Hermes reports; mapped onto INBOX_DIR. */
  INBOX_HOST_PREFIX: z.string().default('/home/admin/.simplex/files'),
  /** Podman secret file with 32 random bytes (raw or hex/base64). */
  MASTER_KEY_FILE: z.string().default('/run/secrets/poster_master_key'),
  /** Dev only: generate a master key under DATA_DIR if MASTER_KEY_FILE is missing. */
  POSTER_DEV_AUTOKEY: z.string().optional(),
  /** Dev/test: replace every adapter with the in-memory fake. */
  POSTER_FAKE_ADAPTERS: z.string().optional(),
  /** Dev bootstrap: accept this MCP bearer token in addition to DB tokens. */
  POSTER_MCP_TOKEN: z.string().optional(),
  /** Dev bootstrap: set the UI password at boot if none exists. */
  POSTER_UI_PASSWORD: z.string().optional(),
  /** Comma-separated extra Host header values (e.g. poster.tailnet.ts.net). */
  POSTER_ALLOWED_HOSTS: z.string().optional(),
  /** Public base URL for OAuth callbacks, e.g. https://poster.tailnet.ts.net */
  POSTER_PUBLIC_URL: z.string().optional(),
  /** Static UI directory. */
  PUBLIC_DIR: z.string().optional(),
  CHROMIUM_PATH: z.string().optional(),
  LOG_LEVEL: z.string().default('info'),
  LOG_PRETTY: z.string().optional(),
  /** Scheduler poll interval (ms). */
  SCHEDULER_INTERVAL_MS: z.coerce.number().int().default(5000),
  /**
   * Trust X-Forwarded-* from a proxy on loopback (tailscale serve). Parsed as a real boolean: the
   * strings "false" and "0" used to count as set, which silently turned trust ON.
   */
  TRUST_PROXY: z.preprocess((v) => {
    if (v === undefined) return undefined;
    const s = String(v).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(s)) return true;
    if (['', '0', 'false', 'no', 'off'].includes(s)) return false;
    return v; // anything else fails validation instead of guessing
  }, z.boolean().optional()),
  NODE_ENV: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

export interface Config extends Env {
  dbPath: string;
  mediaDir: string;
  debugDir: string;
  browserDir: string;
  backupDir: string;
  publicDir: string;
  fakeAdapters: boolean;
  devAutokey: boolean;
  allowedHostsEnv: string[];
  isTest: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.parse(env);
  const dataDir = resolve(parsed.DATA_DIR);
  return {
    ...parsed,
    DATA_DIR: dataDir,
    dbPath: resolve(dataDir, 'app.db'),
    mediaDir: resolve(dataDir, 'media'),
    debugDir: resolve(dataDir, 'debug'),
    browserDir: resolve(dataDir, 'browser'),
    backupDir: resolve(dataDir, 'backups'),
    publicDir: parsed.PUBLIC_DIR
      ? resolve(parsed.PUBLIC_DIR)
      : resolve(import.meta.dirname, '..', 'public'),
    fakeAdapters: truthy(parsed.POSTER_FAKE_ADAPTERS),
    devAutokey: truthy(parsed.POSTER_DEV_AUTOKEY),
    allowedHostsEnv: (parsed.POSTER_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    isTest: parsed.NODE_ENV === 'test',
  };
}

function truthy(v: string | undefined): boolean {
  return v !== undefined && ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}
