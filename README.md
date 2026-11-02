# Social Poster for Hermes

Single-user TypeScript service that publishes text, images and video to **X, Farcaster, LinkedIn,
Nostr and Bluesky**, on demand or at a scheduled time in any IANA time zone. [Hermes](https://hermes-agent.nousresearch.com)
drives it through MCP tools; nothing publishes until you confirm a preview in SimpleX with a
one-time code the agent never sees. Accounts and the queue are managed in a small web UI reached
only over Tailscale.

Running cost: zero. No paid APIs.

```
You (SimpleX) ──► Hermes ──MCP /mcp──► Social Poster ──► X · Farcaster · LinkedIn · Nostr · Bluesky
      ▲                                     │
      └──── confirmation code / results ◄───┘ (signed webhook, deliver_only route)
```

## How a post happens

1. You tell Hermes what to post, where, and when ("post this to X and Nostr tomorrow 9:00").
2. Hermes calls `create_draft`. The poster renders each network's version (overrides, thread
   split with `(1/n)` markers, media variants) and returns a preview with character counts and the
   resolved time in your zone and UTC.
3. A 6-character confirmation code goes **directly to you** in SimpleX through a `deliver_only`
   Hermes webhook route. The model never sees it.
4. You reply `yes ABC123` (or ask for changes, or `cancel`). Hermes calls `confirm_post`.
5. The scheduler publishes at the due time, one network at a time, retries transient failures
   (1, 5, 15 min), never retries ambiguous outcomes, and reports each result back to SimpleX.

## Networks

| Network   | Method                                                                                                                 | Login                                                                        |
| --------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| X         | [rettiwt-api](https://github.com/Rishikant181/Rettiwt-API) with your own session cookies; Playwright composer fallback | Once, in the remote browser view (2FA ok)                                    |
| Farcaster | Playwright drives the farcaster.xyz web composer                                                                       | Once, in the remote browser view; approve on your phone                      |
| LinkedIn  | Official REST API (`/rest/posts`, images, videos), OAuth 2.0 + PKCE, `w_member_social`                                 | Your own LinkedIn app; tokens last ~60 days, you get a warning 7 days before |
| Nostr     | nostr-tools, kind 1 notes, NIP-10 threads, media on Blossom (NIP-92 `imeta`)                                           | Paste your `nsec` once (stored encrypted)                                    |
| Bluesky   | `@atproto/api`, RichText facets, images/video, reply threads                                                           | Handle + app password                                                        |

Limits (280 weighted chars on X, 320 bytes on Farcaster, 3,000 chars on LinkedIn, 300 graphemes /
3,000 bytes on Bluesky, soft cap on Nostr) live in one file:
[`packages/core/src/limits.ts`](packages/core/src/limits.ts).

## Repository layout

```
apps/server      Fastify: MCP (Streamable HTTP) + REST /api/v1 + WebSockets + static UI,
                 scheduler, media pipeline (sharp, ffmpeg), vault, notifier, CLI
apps/web         React 19 + Vite + TanStack Router/Query + Tailwind UI
packages/core    Shared types, zod schemas, limits, thread splitter, time-zone rules
packages/adapters X, Farcaster, LinkedIn, Nostr, Bluesky adapters + shared browser manager
deploy/          Quadlet unit, Hermes config snippets
docs/            API reference, deployment, security
```

## Quick start (development)

Requirements: Node 22, pnpm 10, ffmpeg/ffprobe on PATH. Chromium is only needed for the X and
Farcaster adapters and their tests.

```bash
pnpm install
pnpm --filter @poster/core build && pnpm --filter @poster/adapters build
pnpm --filter @poster/web build        # writes apps/server/public
cp .env.example .env
set -a; . ./.env; set +a
mkdir -p data/inbox
pnpm dev                               # http://127.0.0.1:8787
```

With `POSTER_FAKE_ADAPTERS=1` every network is an in-memory fake, so you can exercise the whole
flow (draft → code → confirm → "publish") without any account. Open the UI, set a password, and
try the MCP endpoint with any MCP client using `Authorization: Bearer dev-mcp-token`.

Tests:

```bash
pnpm test
```

## Production

See [docs/deployment.md](docs/deployment.md) for the full VPS checklist. In short:

```bash
openssl rand -hex 32 | podman secret create poster_master_key -
podman build -f Containerfile -t localhost/hermes-social-poster .
cp deploy/social-poster.container ~/.config/containers/systemd/
systemctl --user daemon-reload && systemctl --user enable --now social-poster
podman exec -it social-poster poster set-password
podman exec -it social-poster poster gen-token mcp   # → Hermes config
tailscale serve --bg --https=443 http://127.0.0.1:8787
```

Then add the `mcp_servers.social_poster` entry and the two webhook routes from
[`deploy/hermes-config.example.yaml`](deploy/hermes-config.example.yaml) to Hermes, `/reload-mcp`,
and connect your accounts in the UI.

## MCP tools

`list_networks`, `create_draft`, `update_draft`, `confirm_post`, `cancel_post`,
`reschedule_post`, `get_post`, `list_posts`, `upload_media`. Inputs and outputs are zod schemas in
[`packages/core/src/api.ts`](packages/core/src/api.ts); the full REST and WebSocket surface is in
[docs/api.md](docs/api.md).

## Security model

- The container publishes one port on loopback only; the UI is reachable through
  `tailscale serve` (never `funnel`). Requests with an unexpected `Host` are rejected.
- MCP has its own bearer token and can only draft, confirm (with a code), cancel, reschedule and
  read. Settings, account connections and secrets are UI-only (password + optional TOTP, CSRF).
- Secrets are AES-256-GCM encrypted with a master key kept in a Podman secret file; the row id is
  the AAD so ciphertext cannot be moved between rows. `poster rotate-key` re-encrypts everything.
- Logs redact tokens, cookies and passwords; the audit log records every create, confirm, cancel,
  connect and publish.
- Draft text is data, never instructions. X automation types it as plain text.

Details, threat model and the VPS fixes you should apply first (notably `SIMPLEX_ALLOWED_USERS`)
are in [docs/security.md](docs/security.md).

## Status

Everything in the specification is implemented and unit/integration tested against mocks and the
fake adapter. The X and Farcaster browser flows and the LinkedIn/Bluesky video uploads are written
against the documented interfaces but have not been exercised against the live services from
this repository; run the nightly self-test and a test post from the Accounts screen before first
real use (see [docs/deployment.md](docs/deployment.md#first-use-checklist)).

## License

No license (all rights reserved by the repository owner).
