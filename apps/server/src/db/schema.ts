import { blob, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * One SQLite file (/data/app.db, WAL). IDs are ULIDs, timestamps are UTC epoch ms, every
 * `*_enc` column holds AES-256-GCM ciphertext (iv | tag | data) with the row id as AAD.
 */

export const accounts = sqliteTable('accounts', {
  network: text('network').primaryKey(),
  handle: text('handle'),
  status: text('status').notNull().default('disconnected'), // connected | needs_auth | disconnected
  secretsEnc: blob('secrets_enc', { mode: 'buffer' }),
  meta: text('meta', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
  browserProfileDir: text('browser_profile_dir'),
  proxy: text('proxy'),
  lastSelfTest: text('last_self_test', { mode: 'json' }).$type<{
    at: number;
    ok: boolean;
    message?: string;
  } | null>(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const posts = sqliteTable(
  'posts',
  {
    id: text('id').primaryKey(),
    status: text('status').notNull(), // PostStatus
    baseText: text('base_text').notNull(),
    threadMode: text('thread_mode').notNull().default('auto'),
    networks: text('networks', { mode: 'json' }).$type<string[]>().notNull(),
    overrides: text('overrides', { mode: 'json' })
      .$type<Record<string, { text?: string; mediaIds?: string[] }>>()
      .notNull()
      .default({}),
    scheduleOverrides: text('schedule_overrides', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    scheduledAtUtc: integer('scheduled_at_utc').notNull(),
    tz: text('tz').notNull(),
    localInput: text('local_input').notNull(),
    source: text('source').notNull(), // mcp | ui | api
    createdAt: integer('created_at').notNull(),
    confirmedAt: integer('confirmed_at'),
    updatedAt: integer('updated_at').notNull(),
    /** Draft expiry (24 h default). */
    expiresAt: integer('expires_at'),
  },
  (t) => [
    index('posts_status_sched_idx').on(t.status, t.scheduledAtUtc),
    index('posts_created_idx').on(t.createdAt),
  ],
);

export const postTargets = sqliteTable(
  'post_targets',
  {
    id: text('id').primaryKey(),
    postId: text('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    network: text('network').notNull(),
    textOverride: text('text_override'),
    scheduledAtUtc: integer('scheduled_at_utc').notNull(),
    tz: text('tz').notNull(),
    localInput: text('local_input').notNull(),
    status: text('status').notNull().default('pending'), // TargetStatus
    attempts: integer('attempts').notNull().default(0),
    leaseUntil: integer('lease_until'),
    nextAttemptAt: integer('next_attempt_at'),
    publishedUrl: text('published_url'),
    remoteIds: text('remote_ids', { mode: 'json' }).$type<string[]>().notNull().default([]),
    /** Frozen at confirm time so retries publish exactly what was previewed. */
    renderedParts: text('rendered_parts', { mode: 'json' }).$type<string[]>().notNull().default([]),
    lastErrorCode: text('last_error_code'),
    lastErrorMsg: text('last_error_msg'),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    index('targets_post_idx').on(t.postId),
    index('targets_due_idx').on(t.status, t.scheduledAtUtc, t.nextAttemptAt),
    index('targets_network_sched_idx').on(t.network, t.scheduledAtUtc),
  ],
);

export const postMedia = sqliteTable(
  'post_media',
  {
    id: text('id').primaryKey(),
    postId: text('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    mediaId: text('media_id')
      .notNull()
      .references(() => media.id),
    position: integer('position').notNull(),
    /** null = all networks; otherwise an override for one network. */
    network: text('network'),
    altText: text('alt_text'),
  },
  (t) => [index('post_media_post_idx').on(t.postId)],
);

export const media = sqliteTable(
  'media',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(), // image | video
    sha256: text('sha256').notNull(),
    mime: text('mime').notNull(),
    bytes: integer('bytes').notNull(),
    width: integer('width'),
    height: integer('height'),
    durationMs: integer('duration_ms'),
    /** Where the untouched copy lives under /data/media/<sha256>/. */
    originalPath: text('original_path').notNull(),
    /** Source path as reported by Hermes (inside the inbox), for the audit trail. */
    sourcePath: text('source_path'),
    variants: text('variants', { mode: 'json' })
      .$type<
        Record<
          string,
          {
            path: string;
            mime: string;
            bytes: number;
            width?: number;
            height?: number;
            durationMs?: number;
          }
        >
      >()
      .notNull()
      .default({}),
    blossomUrls: text('blossom_urls', { mode: 'json' }).$type<string[]>().notNull().default([]),
    altText: text('alt_text'),
    /** Set when files were deleted by retention; the row stays. */
    purgedAt: integer('purged_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('media_sha_idx').on(t.sha256)],
);

export const draftCodes = sqliteTable(
  'drafts_codes',
  {
    id: text('id').primaryKey(),
    draftId: text('draft_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(), // argon2id
    /** SHA-256 of the draft content the code was issued for; a code only confirms that content. */
    contentDigest: text('content_digest').notNull().default(''),
    expiresAt: integer('expires_at').notNull(),
    deliveredVia: text('delivered_via').notNull(), // direct | returned | none
    failedAttempts: integer('failed_attempts').notNull().default(0),
    usedAt: integer('used_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('codes_draft_idx').on(t.draftId)],
);

export const attempts = sqliteTable(
  'attempts',
  {
    id: text('id').primaryKey(),
    targetId: text('target_id')
      .notNull()
      .references(() => postTargets.id, { onDelete: 'cascade' }),
    startedAt: integer('started_at').notNull(),
    finishedAt: integer('finished_at'),
    outcome: text('outcome').notNull(), // running | published | failed | partial
    errorCode: text('error_code'),
    errorMsg: text('error_msg'),
    /** No secrets. X: { screenshot: '/data/debug/<id>.png' } */
    debug: text('debug', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [index('attempts_target_idx').on(t.targetId)],
);

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).$type<unknown>().notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/** Encrypted key/value secrets: webhook secret, LinkedIn client secret, UI password hash, TOTP secret. */
export const secrets = sqliteTable('secrets', {
  key: text('key').primaryKey(),
  valueEnc: blob('value_enc', { mode: 'buffer' }).notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/** Bearer tokens for MCP and REST. Only the SHA-256 of the token is stored. */
export const tokens = sqliteTable('tokens', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(), // mcp | api
  scope: text('scope').notNull().default('write'), // read | write
  tokenHash: text('token_hash').notNull(),
  label: text('label'),
  createdAt: integer('created_at').notNull(),
  lastUsedAt: integer('last_used_at'),
  revokedAt: integer('revoked_at'),
});

export const auditLog = sqliteTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    at: integer('at').notNull(),
    actor: text('actor').notNull(), // mcp | ui | api | system
    action: text('action').notNull(),
    entity: text('entity'),
    details: text('details', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
  },
  (t) => [index('audit_at_idx').on(t.at)],
);

export const uiSessions = sqliteTable('ui_sessions', {
  idHash: text('id_hash').primaryKey(),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
  userAgent: text('user_agent'),
});

/** Outbox for webhook events to Hermes (retried with backoff for 24 h). */
export const notifications = sqliteTable(
  'notifications',
  {
    id: text('id').primaryKey(),
    event: text('event').notNull(),
    route: text('route').notNull(),
    payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: integer('next_attempt_at'),
    deliveredAt: integer('delivered_at'),
    lastError: text('last_error'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('notifications_due_idx').on(t.deliveredAt, t.nextAttemptAt)],
);

/** OAuth state for LinkedIn (PKCE verifier), short-lived. */
export const oauthStates = sqliteTable('oauth_states', {
  state: text('state').primaryKey(),
  network: text('network').notNull(),
  codeVerifier: text('code_verifier').notNull(),
  redirectUri: text('redirect_uri').notNull(),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
});
