# HTTP, MCP and WebSocket API

All routes are served by one Fastify process on `127.0.0.1:8787`. Request and response bodies are
JSON unless noted. Errors are RFC 9457 `application/problem+json` with a stable `code` field
(see `packages/core/src/errors.ts`): `VALIDATION`, `NOT_FOUND`, `UNAUTHORIZED`, `FORBIDDEN`,
`CONFLICT`, `STATE_INVALID`, `SCHEDULE_INVALID`, `CODE_INVALID`, `CODE_EXPIRED`, `AUTH_REQUIRED`,
`RATE_LIMITED`, `MISSED_WINDOW`, `UNKNOWN_OUTCOME`, `MEDIA_UNSUPPORTED`, `MEDIA_TOO_LARGE`,
`NETWORK_ERROR`, `UPSTREAM_ERROR`, `NOT_CONNECTED`, `SELECTOR_BROKEN`, `INTERNAL`.

Types referenced below (`DraftPreview`, `PostView`, `AccountView`, `Settings`, …) are the zod
schemas exported from `@poster/core` (`packages/core/src/api.ts`, `settings.ts`).

## Authentication

| Client         | Mechanism                                                                                                                    |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Hermes (MCP)   | `Authorization: Bearer <MCP token>` on `/mcp`. Constant-time compare.                                                        |
| Scripts (REST) | `Authorization: Bearer <API token>` on `/api/v1/*`. Read-only unless created with write scope.                               |
| UI             | Session cookie `poster_session` (HttpOnly, Secure, SameSite=Strict, 12 h) + `X-CSRF-Token` header on every mutating request. |

A request whose `Host` header is not `127.0.0.1:8787`, `localhost:8787` or one of
`settings.allowedHosts` is rejected with 421 (DNS-rebinding protection). `/health` is exempt.

### UI auth routes

| Method   | Path                       | Body                  | Response                                                                                                                                                                                          |
| -------- | -------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/api/v1/auth/me`          | —                     | `{ authenticated, setupRequired, totpEnabled, csrfToken }`                                                                                                                                        |
| `POST`   | `/api/v1/auth/setup`       | `{ password }`        | Only while `setupRequired` is true (no password set yet). Creates the password; does not log in.                                                                                                  |
| `POST`   | `/api/v1/auth/login`       | `{ password, totp? }` | `{ ok: true, csrfToken }` and sets the cookie. Rate limit 5/min. `401` with `code: UNAUTHORIZED`; if TOTP is enabled and missing: `401` with `code: UNAUTHORIZED` and `extra.totpRequired: true`. |
| `POST`   | `/api/v1/auth/logout`      | —                     | `{ ok: true }`                                                                                                                                                                                    |
| `POST`   | `/api/v1/auth/totp/setup`  | —                     | `{ secret, otpauthUrl }` (pending until enabled)                                                                                                                                                  |
| `POST`   | `/api/v1/auth/totp/enable` | `{ code }`            | `{ ok: true }`                                                                                                                                                                                    |
| `DELETE` | `/api/v1/auth/totp`        | `{ code }`            | `{ ok: true }`                                                                                                                                                                                    |
| `POST`   | `/api/v1/auth/password`    | `{ current, next }`   | `{ ok: true }`                                                                                                                                                                                    |

## REST `/api/v1`

### Accounts

| Method   | Path                                     | Body → Response                                                                                                                                                                                                                                                                    |
| -------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/accounts`                              | → `AccountView[]`                                                                                                                                                                                                                                                                  |
| `GET`    | `/accounts/:network`                     | → `AccountView` (refreshes remote status)                                                                                                                                                                                                                                          |
| `POST`   | `/accounts/:network/connect`             | credentials networks (`nostr`, `bluesky`): `{ fields: Record<string,string> }` → `AccountView`. OAuth (`linkedin`): `{}` → `{ kind: "oauth", url }` (UI redirects there). Browser (`x`, `farcaster`): `{}` → `{ kind: "browser", sessionId }` (UI opens `/ws/browser/:sessionId`). |
| `DELETE` | `/accounts/:network`                     | Disconnect and wipe secrets (and the browser profile) → `AccountView`                                                                                                                                                                                                              |
| `GET`    | `/accounts/linkedin/callback?code&state` | OAuth redirect target. Redirects to `/accounts?connected=linkedin` or `/accounts?error=<message>`.                                                                                                                                                                                 |
| `POST`   | `/accounts/:network/test-post`           | → `{ url, remoteIds }` (Nostr, Bluesky, Farcaster only; `409` otherwise)                                                                                                                                                                                                           |
| `POST`   | `/accounts/:network/self-test`           | → `{ ok, message, details? }`                                                                                                                                                                                                                                                      |
| `DELETE` | `/browser-sessions/:id`                  | Close a remote login session → `{ ok: true }`                                                                                                                                                                                                                                      |

`AccountView.connectKind` tells the UI which flow to render; `connectFields` lists the inputs for
credential flows. LinkedIn also needs `linkedin.clientId` / `linkedin.clientSecret` stored via
`PUT /settings` (`secrets.linkedinClientSecret`) before connecting.

### Drafts and posts

| Method  | Path                                                 | Body → Response                                                                                          |
| ------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `POST`  | `/drafts`                                            | `CreateDraftInput` → `DraftPreview` (`source: "ui"`)                                                     |
| `PATCH` | `/drafts/:id`                                        | `UpdateDraftInput` minus `draftId` → `DraftPreview`                                                      |
| `POST`  | `/drafts/:id/confirm`                                | `{ code? }` → `ConfirmResult`. A UI session may omit the code; API tokens must send it.                  |
| `GET`   | `/posts?status=a,b&from=ISO&to=ISO&limit=50&cursor=` | → `PostList` (newest scheduled first for history; soonest first when `status` contains only open states) |
| `GET`   | `/posts/:id`                                         | → `PostView` (targets include `attemptLog`)                                                              |
| `POST`  | `/posts/:id/cancel`                                  | `{ networks? }` → `CancelResult`                                                                         |
| `POST`  | `/posts/:id/retry`                                   | `{ networks? }` → `PostView` (re-queues failed / needs_auth targets now)                                 |
| `POST`  | `/posts/:id/reschedule`                              | `{ schedule, networks? }` → `PostView` (UI session: applied directly; API token: `403`)                  |
| `POST`  | `/posts/:id/post-now`                                | `{ networks? }` → `PostView` (used for `MISSED_WINDOW`)                                                  |

### Media

| Method | Path                 | Body → Response                                                      |
| ------ | -------------------- | -------------------------------------------------------------------- |
| `POST` | `/media`             | multipart: `file` (+ optional `altText` field) → `MediaUploadResult` |
| `POST` | `/media/from-path`   | `{ path, altText? }` (inbox path) → `MediaUploadResult`              |
| `GET`  | `/media/:id`         | → `MediaInfo`                                                        |
| `GET`  | `/media/:id/preview` | `image/jpeg` thumbnail (UI only; videos get a poster frame)          |

### Settings, tokens, notifications, system

| Method | Path                                  | Body → Response                                                                                                                                                    |
| ------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET`  | `/settings`                           | → `SettingsView = Settings & { secretsSet: { hermesWebhookSecret, linkedinClientSecret, mcpToken, apiToken }, linkedinClientId: string \| null, effectiveLimits }` |
| `PUT`  | `/settings`                           | `Partial<Settings> & { secrets?: { hermesWebhookSecret?, linkedinClientSecret?, linkedinClientId? } }` → `SettingsView`                                            |
| `POST` | `/settings/tokens/:kind/rotate`       | `kind` = `mcp` \| `api`; body `{ scope?: "read" \| "write" }` for `api` → `{ token }` (shown once, never retrievable)                                              |
| `POST` | `/settings/webhook/test`              | — → `{ ok, status?, error? }` sends a `self_test_failed`-shaped ping with `event: "test"`                                                                          |
| `GET`  | `/notifications?undelivered=1&limit=` | → `NotificationView[]`                                                                                                                                             |
| `POST` | `/notifications/:id/retry`            | → `NotificationView`                                                                                                                                               |
| `GET`  | `/system`                             | → `{ version, uptimeMs, now, tz, codeDelivery: "direct" \| "returned", scheduler: { lastTickAt, lagMs, running }, counts: { scheduled, publishing, failed24h } }`  |
| `GET`  | `/audit?limit=&cursor=`               | → `{ items: AuditEntry[], nextCursor }`                                                                                                                            |

### Unauthenticated

| Method | Path       | Response                                           |
| ------ | ---------- | -------------------------------------------------- |
| `GET`  | `/health`  | `{ ok: true }`                                     |
| `GET`  | `/metrics` | Prometheus text (UI session or API token required) |

## WebSocket

### `/ws/events` (UI session cookie)

Server → client: `WsEvent` JSON (`post.updated`, `target.updated`, `account.updated`,
`notification.updated`, `browser.session`, `ping` every 25 s).

### `/ws/browser/:sessionId` (UI session cookie)

Remote Chromium view for X / Farcaster login. Viewport is 1280×800 CSS px; coordinates sent by the
client are in that space.

Server → client:

```json
{ "type": "frame", "data": "<base64 JPEG>", "width": 1280, "height": 800 }
{ "type": "state", "state": "started" | "logged_in" | "saved" | "closed" | "error", "message": "…" }
{ "type": "url", "url": "https://x.com/home" }
```

Client → server:

```json
{ "type": "mouse", "event": "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel",
  "x": 10, "y": 20, "button": "left" | "right" | "middle" | "none", "clickCount": 1,
  "deltaX": 0, "deltaY": -120, "modifiers": 0 }
{ "type": "key", "event": "keyDown" | "keyUp" | "char", "key": "a", "code": "KeyA", "text": "a",
  "modifiers": 0, "windowsVirtualKeyCode": 65 }
{ "type": "text", "text": "pasted password" }
{ "type": "navigate", "url": "https://x.com/login" }
{ "type": "save" }
{ "type": "close" }
```

`save` runs the adapter's `capture()` on the live page, stores the result encrypted, emits
`state: saved`, then closes the session. Sessions auto-close after
`settings.browser.remoteSessionIdleMinutes` without input. Only one remote session may be open at a
time (`409 CONFLICT` otherwise). Navigation outside the adapter's host allowlist is blocked.

## MCP (`POST /mcp`, Streamable HTTP)

Tools, all with zod input schemas from `@poster/core`:

| Tool              | Input                 | Output (structured)                 |
| ----------------- | --------------------- | ----------------------------------- |
| `list_networks`   | —                     | `AccountView[]` minus limits detail |
| `create_draft`    | `CreateDraftInput`    | `DraftPreview`                      |
| `update_draft`    | `UpdateDraftInput`    | `DraftPreview`                      |
| `confirm_post`    | `ConfirmPostInput`    | `ConfirmResult`                     |
| `cancel_post`     | `CancelPostInput`     | `CancelResult`                      |
| `reschedule_post` | `ReschedulePostInput` | `DraftPreview` (new code required)  |
| `get_post`        | `GetPostInput`        | `PostView`                          |
| `list_posts`      | `ListPostsInput`      | `PostList`                          |
| `upload_media`    | `UploadMediaInput`    | `MediaUploadResult`                 |

Tool results carry both `content[0].text` (a compact human-readable rendering the agent should
show verbatim) and `structuredContent`. MCP never returns secrets, tokens, cookies or paths outside
the inbox. In soft mode (no direct webhook route) `DraftPreview.code` is populated and
`codeDelivery` is `"returned"`.
