# Deployment

Target: the Hermes VPS (Ubuntu, 3 vCPU, ~7 GB RAM), rootless Podman, Tailscale. Hermes runs on
the host as user `admin`; the poster runs in one container and binds `127.0.0.1:8787`.

## 1. Host prerequisites

```bash
# Podman, rootless
sudo apt install -y podman uidmap slirp4netns passt
grep "^$USER:" /etc/subuid /etc/subgid || sudo usermod --add-subuids 100000-165535 --add-subgids 100000-165535 $USER
loginctl enable-linger $USER                 # Quadlet units start at boot

# Tailscale
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh                     # optional: Tailscale SSH, then close public 22
```

Tailscale ACLs: allow only your own devices (a tag or your user) to reach the VPS on 443.
Host firewall: default deny inbound except the Tailscale UDP port (and SSH until you move it).

SimpleX daemon: set the files folder explicitly so every attachment lands in one place:

```
/home/admin/.simplex/files
```

Hermes (`~/.hermes/.env`):

```
SIMPLEX_ALLOWED_USERS=<your contactId>      # REQUIRED, see docs/security.md
WEBHOOK_ENABLED=true
WEBHOOK_PORT=8644
WEBHOOK_SECRET=<openssl rand -hex 32>
```

Bind the webhook adapter to loopback. Rootless Podman with pasta maps the host loopback as
`host.containers.internal` (the Quadlet unit adds `host-gateway`). If the container cannot reach
`http://host.containers.internal:8644/health`, bind the adapter to the Podman gateway address
instead and set that URL in Settings → Hermes.

## 2. Master key and image

```bash
openssl rand -hex 32 | podman secret create poster_master_key -
# Keep a copy of that key somewhere safe and separate from the backups.

git clone https://github.com/Roman-24/hermes-social-poster && cd hermes-social-poster
podman build -f Containerfile -t localhost/hermes-social-poster:latest .
```

(CI also publishes `ghcr.io/roman-24/hermes-social-poster:latest`; pin a digest in the unit file
if you use it.)

## 3. Quadlet unit

```bash
mkdir -p ~/.config/containers/systemd
cp deploy/social-poster.container ~/.config/containers/systemd/
# Edit: Image=, the /inbox host path, POSTER_ALLOWED_HOSTS / POSTER_PUBLIC_URL
systemctl --user daemon-reload
systemctl --user enable --now social-poster
journalctl --user -u social-poster -f
```

The unit mounts `poster-data:/data` (SQLite, media, browser profiles, debug screenshots,
backups) and the SimpleX files folder read-only at `/inbox`. Root FS is read-only, all
capabilities dropped, `no-new-privileges`. Chromium runs **without** its own sandbox
(`--no-sandbox`, Playwright's default); see the Chromium note in `docs/security.md`.

## 4. First login

```bash
podman exec -it social-poster poster set-password
podman exec -it social-poster poster gen-token mcp      # prints spm_… once
tailscale serve --bg --https=443 http://127.0.0.1:8787
```

Open `https://poster.<tailnet>.ts.net`, log in, then in **Settings**:

- Allowed hosts: `poster.<tailnet>.ts.net` (also `POSTER_ALLOWED_HOSTS` in the unit).
- Hermes: webhook base URL `http://host.containers.internal:8644`, direct route `poster-direct`,
  webhook secret (same as `WEBHOOK_SECRET`), optional agent route `poster-agent`. Click
  **Send test**.
- Nostr relays, Blossom servers, default time zone, retention.
- LinkedIn client id + secret (from your LinkedIn developer app; redirect URL
  `https://poster.<tailnet>.ts.net/api/v1/accounts/linkedin/callback`).
- Optional TOTP.

Until the direct route works, no confirmation code is sent to Hermes at all: the System card shows
that drafts can only be confirmed in the UI (Confirm button on the post). If you prefer the old
**soft mode**, where the code is returned to Hermes in the tool result and the agent can confirm
posts without you, switch it on under Settings → Hermes. It is off by default.

Run Hermes under a different OS account from the one that runs the Podman container; see
Known residual risks in `docs/security.md`.

## 5. Hermes

Add to `~/.hermes/config.yaml` (see `deploy/hermes-config.example.yaml`):

```yaml
mcp_servers:
  social_poster:
    url: 'http://127.0.0.1:8787/mcp'
    headers:
      Authorization: 'Bearer ${SOCIAL_POSTER_MCP_TOKEN}'
```

and the `poster-direct` (`deliver_only: true`, `deliver: simplex`, `deliver_extra.chat_id` =
your contactId) and optional `poster-agent` webhook routes. Run `/reload-mcp`.

## 6. Connect accounts (UI → Accounts)

- **Nostr**: paste `nsec` (or hex). The UI only ever shows the `npub` afterwards. Add relays in
  Settings first; a note counts as published once `minRelays` (default 2) relays return OK.
- **Bluesky**: handle + app password (Settings → App passwords in Bluesky, never the main
  password). The card shows whether your email is verified (needed for video).
- **LinkedIn**: Connect → LinkedIn OAuth → back to Accounts. Scopes `openid profile w_member_social`.
  Posts as your personal profile. Reconnect when the ~60-day token warning appears.
- **X**: Connect opens the remote browser view (a live Chromium streamed to a canvas). Log in as
  usual, including 2FA, then click **Save login**. The app captures `auth_token`/`ct0`/`twid` and
  feeds them to rettiwt-api. If X challenges logins from the datacenter IP, set a per-account
  proxy to a Tailscale exit node at home (`PUT /api/v1/accounts/x/proxy`, e.g. `socks5://100.x.y.z:1055`).
- **Farcaster**: same remote browser view at farcaster.xyz; approve the login in the Farcaster app
  on your phone, then **Save login**. The session lives in the persistent Chromium profile.

## First-use checklist

- [ ] `poster status` shows every account `connected`.
- [ ] **Run self-test** on X and Farcaster (checks every composer selector without posting). If
      it reports missing selectors, update `packages/adapters/src/x/x.selectors.ts` or
      `farcaster/farcaster.selectors.ts`; the UI changes without notice.
- [ ] **Test post to self** on Nostr and Bluesky.
- [ ] Create a draft via Hermes with `schedule: "now"` to one network; confirm with the code that
      arrived in SimpleX; check the `published` message arrives too.
- [ ] Settings → Hermes → **Send test** returns ok.

## Operations

| Task                 | Command                                                                                                                                                                           |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Logs                 | `journalctl --user -u social-poster -f` (JSON, secrets redacted)                                                                                                                  |
| Metrics              | `GET /metrics` (UI session or API token) — posts by status, publish latency, failures by network/code, scheduler lag                                                              |
| Backup               | `podman exec social-poster poster backup` → `/data/backups/poster-backup-<ts>.tar.gz.enc` (AES-256-GCM with a key derived from the master key; back the master key up separately) |
| Restore              | stop the unit, `poster restore <file>`, start it again                                                                                                                            |
| Rotate master key    | `openssl rand -hex 32 > new.key`; `podman exec -i social-poster poster rotate-key /dev/stdin < new.key`; replace the Podman secret; restart                                       |
| Rotate MCP/API token | Settings → Tokens, or `poster gen-token mcp`                                                                                                                                      |
| Update               | `podman auto-update` (unit has `AutoUpdate=registry`) or rebuild and restart                                                                                                      |

Retention: media files and debug screenshots are deleted 30 days (Settings) after their post is
final; post and audit rows are kept. Browser profiles plus media need roughly 2–5 GB.

## Local development without Podman

See the README quick start. `POSTER_FAKE_ADAPTERS=1` swaps every network for an in-memory fake;
`POSTER_DEV_AUTOKEY=1` generates a dev master key under `DATA_DIR`. `pnpm dev:web` runs Vite with
a proxy to `127.0.0.1:8787`.
