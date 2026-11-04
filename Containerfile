# syntax=docker/dockerfile:1.7
#
# Social Poster for Hermes — multi-stage build on the official Playwright image (Chromium + deps
# preinstalled). Final image: non-root (uid 1000), read-only root FS friendly (writes only to
# /data and /tmp), ffmpeg/ffprobe included.
#
# Pin the digest of the base image before production use:
#   podman pull mcr.microsoft.com/playwright:v1.64.1-noble && podman inspect --format '{{.Digest}}' ...
ARG PLAYWRIGHT_IMAGE=mcr.microsoft.com/playwright:v1.64.1-noble

# ---------------------------------------------------------------------------
# 1. Build: install all deps, build core → adapters → web → server
# ---------------------------------------------------------------------------
FROM ${PLAYWRIGHT_IMAGE} AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm install -g pnpm@10.28.0
WORKDIR /src

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/adapters/package.json packages/adapters/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

COPY . .
RUN pnpm --filter @poster/core build \
 && pnpm --filter @poster/adapters build \
 && pnpm --filter @poster/web build \
 && pnpm --filter @poster/server build

# Production node_modules only (native modules already compiled above).
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm --filter @poster/server --prod deploy --legacy /out/server \
 && cp -r apps/server/drizzle /out/server/drizzle \
 && cp -r apps/server/public /out/server/public

# ---------------------------------------------------------------------------
# 2. Runtime
# ---------------------------------------------------------------------------
FROM ${PLAYWRIGHT_IMAGE} AS runtime
ENV NODE_ENV=production \
    DATA_DIR=/data \
    INBOX_DIR=/inbox \
    MASTER_KEY_FILE=/run/secrets/poster_master_key \
    PUBLIC_DIR=/app/public \
    HOST=0.0.0.0 \
    PORT=8787 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg tini \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -g 1000 poster 2>/dev/null || true \
 && (id -u 1000 >/dev/null 2>&1 || useradd -u 1000 -g 1000 -m -s /usr/sbin/nologin poster) \
 && mkdir -p /data /inbox /app && chown -R 1000:1000 /data /app

WORKDIR /app
COPY --from=build --chown=1000:1000 /out/server/ /app/
# `poster` CLI: podman exec social-poster poster <cmd>
RUN printf '#!/bin/sh\nexec node /app/dist/cli.js "$@"\n' > /usr/local/bin/poster && chmod +x /usr/local/bin/poster

USER 1000
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/app/dist/main.js"]
