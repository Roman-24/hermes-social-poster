# Security

The app holds the keys to five public identities and is driven by an LLM agent that reads
untrusted content. The design assumes the VPS is reachable from the internet and that Hermes can
be manipulated by what it reads (prompt injection).

## Fix first, on the VPS

`SIMPLEX_AUTO_ACCEPT` without `SIMPLEX_ALLOWED_USERS` means anyone who learns the bot's SimpleX
address can connect and instruct Hermes. Set `SIMPLEX_ALLOWED_USERS` to your own contactId before
wiring the poster in. The confirmation code still protects posting (it only goes to
`SIMPLEX_HOME_CHANNEL` / your `chat_id`), but Hermes has other tools.

## Network exposure

- One published port, loopback only: `PublishPort=127.0.0.1:8787:8787`.
- UI over `tailscale serve --https=443 http://127.0.0.1:8787`. **Never `tailscale funnel`.**
- `Host` header allowlist (`127.0.0.1:8787`, `localhost:8787`, the ts.net name you configure);
  everything else gets `421`. `/health` is exempt and returns only `{ok:true}`.
- Security headers: `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
  `Cache-Control: no-store` on API responses.

## Authentication and authorization

| Client           | Mechanism                                                                                                                                                                                       | Can                                                                                                                                                                                                      |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hermes (MCP)     | Static bearer token (`spm_…`, 32 random bytes), SHA-256 at rest, constant-time compare                                                                                                          | draft, preview, confirm **with a code**, cancel, reschedule (→ new code), read posts, register inbox media                                                                                               |
| Scripts (REST)   | Separate `spa_…` token, read-only or write                                                                                                                                                      | same as MCP plus REST reads; may re-queue failed targets of a confirmed post; cannot confirm without a code, cannot reschedule, cannot post-now or revive anything that was cancelled or never confirmed |
| UI               | argon2id password + optional TOTP; `HttpOnly Secure SameSite=Strict` signed cookie, 12 h; `X-CSRF-Token` (HMAC of the session id with the master key) on every mutation; login limited to 5/min | everything, including settings, account connections, tokens, confirm without code                                                                                                                        |
| Webhook → Hermes | `X-Webhook-Signature: sha256=<HMAC-SHA256(body)>` with the shared `WEBHOOK_SECRET`                                                                                                              | —                                                                                                                                                                                                        |

The MCP token cannot change settings, connect accounts or read secrets. Those are UI-only.

WebSockets (`/ws/events`, `/ws/browser/:id`) are authenticated by the session cookie. A WebSocket
upgrade is a GET, so there is no CSRF token; instead an upgrade that carries an `Origin` other than
this host is refused (`SameSite=Strict` separates sites, not origins on the same site). Each open
socket is tied to the session that opened it and re-checks it every 5 seconds and before every
message and event, so logout, a password change, `poster set-password` and the 12 h expiry close
it (code 4401).

## The confirmation code

- 6 characters from an alphabet without `0/O/1/I`, argon2id-hashed, 30 min TTL (Settings), one
  use, 5 wrong guesses invalidate it (each guess spends an attempt atomically before the slow
  check, so concurrent guesses cannot share a counter), any `update_draft`/`reschedule_post`
  issues a new one and invalidates the old one in the same transaction as the change.
- A code is bound to a digest of the draft it was issued for: text, thread mode, networks,
  per-network overrides, schedule, and every attachment by content hash with its alt text. It is
  burned by a single statement that requires the draft to still have that digest, and `confirm`
  re-checks the digest and the draft status before it commits. A draft that changes after you saw
  it cannot be confirmed with the old code.
- Delivered through a Hermes webhook route with `deliver_only: true`, so the agent process never
  sees it. The message shows the complete post: every network, every part, attachments with alt
  text and each network's own schedule, with all agent-written text quoted so it cannot add lines.
  If the post is too large to show in one message, no code is sent and the draft must be confirmed
  in the UI.
- Without a direct route the code is **not** handed to the agent. Confirm drafts in the web UI
  (Confirm button on the post). **Soft mode**, where the code is returned in the tool result and the
  agent can confirm posts on its own, exists only if you switch it on in Settings → Hermes
  (`hermes.allowSoftMode`); the UI and `GET /api/v1/system` show the current mode
  (`direct`, `returned` or `none`).
- Rescheduling requires a fresh confirmation; cancelling does not.
- Nothing runs without a recorded confirmation: the scheduler only picks up posts with
  `confirmedAt` set. `retry` and `post-now` never create one for a script or agent; only an
  operator in the UI can revive a cancelled or never-confirmed post, and doing so goes through the
  same cap and gap as `confirm` and counts as the confirmation.
- A daily cap (`maxPostsPerDay`, default 3) and a per-network minimum gap bound the blast radius of
  a runaway agent. Both also read the `attempts` table, which only the scheduler writes, so a post
  that already published still counts after an agent turns it back into a draft.

## Secrets at rest

- Master key: 32 bytes in `/run/secrets/poster_master_key` (Podman secret, mode 0400). Never in
  env vars, never in the image. `POSTER_DEV_AUTOKEY=1` exists for development only.
- Every secret column is AES-256-GCM with a random 12-byte IV and the row id (or secret key name)
  as AAD, so a ciphertext cannot be swapped between rows. Stored: X cookies/API key, Bluesky app
  password + session, LinkedIn tokens, Nostr `nsec`, LinkedIn client secret, webhook secret, UI
  password hash, TOTP secret.
- Browser profiles (X, Farcaster) sit on the data volume; cookies in a Chromium profile cannot be
  encrypted per field. Encrypt the volume at rest (LUKS or an encrypted VPS disk).
- `poster rotate-key` re-encrypts all rows; `poster backup` writes an encrypted archive.

## Agent safety

- Nothing publishes without the code (see above). Injected text cannot confirm a post.
- MCP tool outputs never include secrets, tokens, cookies, or file paths outside `/inbox`.
- Draft text is treated as data; no part of it is interpreted. X automation types it as plain
  text; LinkedIn's little-text specials are escaped so posts are not truncated.
- Media paths from Hermes are mapped from the host prefix onto `/inbox`, resolved with `realpath`
  and must stay inside the inbox (blocks traversal and symlinks). Type detection uses magic
  bytes, not extensions. Images are re-encoded and all metadata (EXIF, GPS) stripped.

## Container hardening

Rootless Podman, uid 1000, read-only root FS (writable only `/data` and a `/tmp` tmpfs),
`--cap-drop=ALL`, `--security-opt=no-new-privileges`, default seccomp. `/inbox` is mounted
read-only. Pin the base image digest; CI runs `pnpm audit`.

**Chromium runs without its own sandbox.** Playwright adds `--no-sandbox` unless the launch passes
`chromiumSandbox: true`, and this build does not, so the renderer processes are not confined by
Chromium's user-namespace sandbox. It was not verified that the sandbox can start under Podman's
default seccomp profile with all capabilities dropped, so it is not switched on. The browser only
loads pages from a host allowlist (x.com and related hosts, farcaster.xyz and related hosts) while
the operator is logged in, and the container boundary above is what remains if a renderer is ever
compromised: it would run as uid 1000 with access to `/data`, which holds the database and the
live-cookie browser profiles. To close this, enable the sandbox and supply a seccomp profile that
permits user namespaces, then test the browser features on the real host.

## Logging and audit

pino redacts `authorization`, `cookie`, `token`, `nsec`, `secret`, `password`, `apiKey`,
`appPassword`, `accessToken`, `refreshToken`, `sk` and `secrets` at any depth. The `audit_log`
table records actor (`mcp` / `ui` / `api` / `system`), action and entity for every create,
confirm, cancel, reschedule, connect, disconnect, publish, token rotation and settings change.

## Known residual risks

- Cookie-based posting to X and browser automation of Farcaster can violate those services' terms
  and get an account limited. Low volume (≤3/day) and human-like pacing reduce but do not remove
  the risk. Both break when the sites change; the nightly selector self-test tells you.
- LinkedIn may require a re-login about every 60 days.
- Anything uploaded to Blossom for Nostr is public and stays downloadable by anyone with the link,
  even after the note is deleted. The preview says so.
- Soft mode, when switched on, lets the agent see the code and confirm posts without you. Leave
  it off and configure the direct route.
- Chromium runs with `--no-sandbox` (see Container hardening).
- Hermes and the poster must not run as the same OS account on the host. Anything that can run
  `podman exec` or read the Podman secret store as that account can bypass the code (the CLI can
  set the UI password) and read the master key.
