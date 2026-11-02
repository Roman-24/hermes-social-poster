# Architecture

One Node.js 22 process in one rootless Podman container on the Hermes VPS, listening on
`127.0.0.1:8787`. Tailscale is the only way in from outside.

```
                 ┌──────────────────────────── container ────────────────────────────┐
 Hermes ─MCP─►   │ Fastify: /mcp  /api/v1  /ws/*  static UI                          │
 (host)  ◄─────  │   │                                                               │
  webhook        │   ▼                                                               │
                 │ PostService ── Renderer ── MediaService (sharp, ffmpeg)            │
                 │   │  codes (argon2)      │                                         │
                 │   ▼                      ▼                                         │
                 │ Scheduler (5 s poll, row leases) ──► NetworkAdapter.publish()      │
                 │   │                              x · farcaster · linkedin · nostr · bluesky
                 │   ▼                              (BrowserManager: one Chromium)    │
                 │ Notifier (outbox, HMAC webhooks) ─► Hermes deliver_only route ─► SimpleX
                 │ SQLite (WAL) · Vault (AES-256-GCM) · audit · metrics               │
                 └───────────────────────────────────────────────────────────────────┘
```

## Packages

- **`packages/core`** — the contract everything else compiles against: `Network`, limits
  (`limits.ts`), text measurement (weighted / bytes / graphemes / chars), the thread splitter
  (paragraph → sentence → word, atomic URLs and mentions, `(i/n)` markers), schedule resolution
  with DST gap/overlap detection (Luxon), LinkedIn little-text escaping, `PosterError` with stable
  codes, zod schemas for MCP/REST inputs and outputs, `Settings`, and the `NetworkAdapter`
  interface (`validate`, `connectionStatus`, `publish`, `selfTest`, `findRecent`, `testPost`,
  plus a `connect` flow of kind `credentials` | `oauth` | `browser`).
- **`packages/adapters`** — one adapter per network behind that interface, a fake adapter for
  tests, and the shared `BrowserManager` (persistent Chromium profile per network, one publish at
  a time, host allowlist, CDP screencast sessions for remote login).
- **`apps/server`** — Drizzle schema + migrations, vault, settings/secrets, accounts, media
  pipeline, renderer, post service (draft → confirm → scheduled → published), scheduler, notifier,
  auth (argon2id, TOTP, sessions, CSRF, tokens), browser-session bridge, jobs (retention, token
  expiry warnings, nightly self-test), REST routes, WebSockets, MCP server, CLI.
- **`apps/web`** — React SPA (Login, Accounts, Remote browser, Queue, History, Post detail,
  Settings), built into `apps/server/public`.

## Post lifecycle

```
draft ──confirm(code)──► scheduled | queued ──due──► publishing ──► published
  │                                                      │          partially_published
  ├─ expired (24 h)                                      └────────► failed
  └─ cancelled
target: pending → publishing → published | failed | skipped ; retrying ; needs_auth ; cancelled
```

- The renderer freezes each target's parts at confirm time so retries publish exactly what was
  previewed.
- The scheduler leases a target with a single conditional `UPDATE` before running it; a restart
  with an expired lease marks the target `UNKNOWN_OUTCOME` rather than re-posting.
- Transient errors (`RATE_LIMITED`, `NETWORK_ERROR`, `UPSTREAM_ERROR`) retry with 1/5/15 min
  backoff, max 3 attempts. `AUTH_REQUIRED` flips the account to `needs_auth` and you get a SimpleX
  message. `UNKNOWN_OUTCOME` and `MISSED_WINDOW` wait for your decision (Post now / reschedule).
- Threads publish in order; `PartialPublishError` keeps the already-published remote ids so a
  retry continues from the failed part.

## Data

Single SQLite file `/data/app.db` (WAL). Tables: `accounts`, `posts`, `post_targets`,
`post_media`, `media`, `drafts_codes`, `attempts`, `settings`, `secrets`, `tokens`,
`audit_log`, `ui_sessions`, `notifications` (webhook outbox), `oauth_states`. Media files live in
`/data/media/<sha256>/` (original + per-network variants + thumbnail), browser profiles in
`/data/browser/<network>/profile`, debug screenshots in `/data/debug`.
