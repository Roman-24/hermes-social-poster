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

| Client           | Mechanism                                                                                                                                                                                       | Can                                                                                                        |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Hermes (MCP)     | Static bearer token (`spm_…`, 32 random bytes), SHA-256 at rest, constant-time compare                                                                                                          | draft, preview, confirm **with a code**, cancel, reschedule (→ new code), read posts, register inbox media |
| Scripts (REST)   | Separate `spa_…` token, read-only or write                                                                                                                                                      | same as MCP plus REST reads; cannot confirm without a code, cannot reschedule                              |
| UI               | argon2id password + optional TOTP; `HttpOnly Secure SameSite=Strict` signed cookie, 12 h; `X-CSRF-Token` (HMAC of the session id with the master key) on every mutation; login limited to 5/min | everything, including settings, account connections, tokens, confirm without code                          |
| Webhook → Hermes | `X-Webhook-Signature: sha256=<HMAC-SHA256(body)>` with the shared `WEBHOOK_SECRET`                                                                                                              | —                                                                                                          |

The MCP token cannot change settings, connect accounts or read secrets. Those are UI-only.

## The confirmation code

- 6 characters from an alphabet without `0/O/1/I`, argon2id-hashed, 30 min TTL (Settings), one
  use, 5 wrong guesses invalidate it, any `update_draft`/`reschedule_post` issues a new one.
- Delivered through a Hermes webhook route with `deliver_only: true`, so the agent process never
  sees it. If no direct route is configured, the app falls back to returning the code in the tool
  result (**soft mode**), shown as a warning in the UI and in `GET /api/v1/system`.
- Rescheduling requires a fresh confirmation; cancelling does not.
- A hard daily cap (`maxPostsPerDay`, default 3) and a per-network minimum gap bound the blast
  radius of a runaway agent.

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
`--cap-drop=ALL`, `--security-opt=no-new-privileges`, default seccomp. Chromium keeps its own
sandbox (user namespaces are available in rootless Podman; do not add `--no-sandbox`). `/inbox` is
mounted read-only. Pin the base image digest; CI runs `pnpm audit`.

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
- Soft mode (no direct route) lets the agent see the code. Configure the direct route.
