import { z } from 'zod';
import { DEFAULT_TZ } from './schedule.js';

/**
 * Settings stored in the `settings` table (one JSON value per key path, merged over these defaults).
 * Secrets (webhook secret, API tokens) are NOT here; they live encrypted in the vault.
 */
export const SettingsSchema = z.object({
  defaultTz: z.string().default(DEFAULT_TZ),
  /** Max posts per day; soft guard against runaway agents. */
  maxPostsPerDay: z.number().int().min(1).max(100).default(3),
  codeTtlMinutes: z.number().int().min(1).max(240).default(30),
  draftExpiryHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 14)
    .default(24),
  missedWindowMinutes: z
    .number()
    .int()
    .min(1)
    .max(24 * 60)
    .default(30),
  minGapPerNetworkMinutes: z
    .number()
    .int()
    .min(0)
    .max(24 * 60)
    .default(1),
  retentionDays: z.number().int().min(1).max(3650).default(30),
  threadMarker: z
    .object({
      enabled: z.boolean().default(true),
      format: z.string().min(1).max(20).default('({i}/{n})'),
    })
    .default({ enabled: true, format: '({i}/{n})' }),
  retry: z
    .object({
      maxAttempts: z.number().int().min(1).max(10).default(3),
      /** Backoff delays in minutes between attempts. */
      backoffMinutes: z.array(z.number().int().min(0)).default([1, 5, 15]),
    })
    .default({ maxAttempts: 3, backoffMinutes: [1, 5, 15] }),
  nostr: z
    .object({
      relays: z.array(z.string().url()).default([]),
      /** A note counts as published once this many relays return OK. */
      minRelays: z.number().int().min(1).default(2),
      softTextMax: z.number().int().min(100).default(5000),
    })
    .default({ relays: [], minRelays: 2, softTextMax: 5000 }),
  blossom: z
    .object({
      primary: z.string().url().default('https://blossom.primal.net'),
      mirrors: z
        .array(z.string().url())
        .default(['https://blossom.band', 'https://nostr.download']),
    })
    .default({
      primary: 'https://blossom.primal.net',
      mirrors: ['https://blossom.band', 'https://nostr.download'],
    }),
  x: z
    .object({
      /** Use the Playwright composer if rettiwt fails with a non-auth error. */
      composerFallback: z.boolean().default(false),
      /** Pin: the rettiwt-api version this build was tested with (informational). */
      rettiwtVersion: z.string().default('7.1.x'),
    })
    .default({ composerFallback: false, rettiwtVersion: '7.1.x' }),
  hermes: z
    .object({
      /** Base URL of the Hermes webhook adapter, e.g. http://host.containers.internal:8644 */
      webhookBaseUrl: z.string().url().nullable().default(null),
      /** deliver_only route that reaches you in SimpleX without running the agent. */
      directRoute: z.string().default('poster-direct'),
      /** Optional route that runs the agent (MISSED_WINDOW / UNKNOWN_OUTCOME follow-ups). */
      agentRoute: z.string().nullable().default(null),
      signatureHeader: z.string().default('X-Webhook-Signature'),
      /** "hex" → raw hex digest; "sha256=" → "sha256=<hex>" */
      signaturePrefix: z.string().default('sha256='),
    })
    .default({
      webhookBaseUrl: null,
      directRoute: 'poster-direct',
      agentRoute: null,
      signatureHeader: 'X-Webhook-Signature',
      signaturePrefix: 'sha256=',
    }),
  selfTest: z
    .object({
      enabled: z.boolean().default(true),
      /** Hour of day (default zone) for the nightly browser selector check. */
      hour: z.number().int().min(0).max(23).default(4),
    })
    .default({ enabled: true, hour: 4 }),
  /** Partial overrides of DEFAULT_LIMITS, keyed by network. */
  limits: z.record(z.string(), z.unknown()).default({}),
  /** Hostnames accepted in the Host header besides 127.0.0.1:8787 (e.g. poster.tailnet.ts.net). */
  allowedHosts: z.array(z.string()).default([]),
  /** Browser automation knobs. */
  browser: z
    .object({
      remoteSessionIdleMinutes: z.number().int().min(1).max(60).default(10),
      typingDelayMsMin: z.number().int().min(0).default(20),
      typingDelayMsMax: z.number().int().min(0).default(90),
      keepDebugScreenshots: z.boolean().default(true),
    })
    .default({
      remoteSessionIdleMinutes: 10,
      typingDelayMsMin: 20,
      typingDelayMsMax: 90,
      keepDebugScreenshots: true,
    }),
});
export type Settings = z.infer<typeof SettingsSchema>;
export type SettingsPatch = z.input<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({});

/** UI-facing update schema: everything optional, deep. */
export const SettingsUpdateSchema = SettingsSchema.partial();
