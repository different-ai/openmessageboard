# syntax=docker/dockerfile:1.7
#
# OpenMessageBoard server image: one Node process serving the API, MCP endpoint and web client,
# with its SQLite database on the /data volume.
#
#   docker build -t openmessageboard .
#   docker run -p 8787:8787 -v omb-data:/data -e OMB_PUBLIC_URL=http://localhost:8787 openmessageboard
#
# Build and runtime use the same Debian bookworm base so better-sqlite3's native addon,
# compiled (or fetched prebuilt) in the build stage, matches the runtime's glibc and Node ABI.

ARG NODE_IMAGE=node:24-bookworm-slim
ARG LITESTREAM_IMAGE=litestream/litestream:0.3.13

# Litestream's static binary, for single-container hosts (Render) that can't run a backup sidecar.
FROM ${LITESTREAM_IMAGE} AS litestream

# ---------- build ----------
FROM ${NODE_IMAGE} AS build

# Compilers are only a fallback for better-sqlite3 when no prebuilt binary matches.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

ENV CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

WORKDIR /src

# Fill the pnpm store from the lockfile alone, so dependency downloads are cached across source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=omb-pnpm-store,target=/pnpm/store \
    pnpm fetch --store-dir=/pnpm/store

COPY . .
RUN --mount=type=cache,id=omb-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prefer-offline --store-dir=/pnpm/store

# protocol first: server and sdk type-check against its dist/ output.
RUN pnpm --filter @openmessageboard/protocol run build \
 && pnpm --filter @openmessageboard/sdk run build \
 && pnpm --filter @openmessageboard/server run build \
 && pnpm --filter @openmessageboard/web run build

# A self-contained server directory with production dependencies only. The workspace protocol package is
# copied in as a regular dependency (its dist/ is what Node resolves without the "source" condition).
RUN --mount=type=cache,id=omb-pnpm-store,target=/pnpm/store \
    pnpm --filter @openmessageboard/server deploy --prod --legacy --store-dir=/pnpm/store /out/server \
 && rm -rf /out/server/dist /out/server/src /out/server/test \
 && cp -R server/dist /out/server/dist \
 && mkdir -p /out/web \
 && cp -R web/dist /out/web/dist \
 && test -f /out/server/dist/cli.js \
 && test -f /out/web/dist/index.html \
 && cd /out/server \
 && node -e "new (require('better-sqlite3'))(':memory:').close(); import('@openmessageboard/protocol').then(() => console.log('runtime dependencies load'))"

# ---------- runtime ----------
FROM ${NODE_IMAGE} AS runtime

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps \
    OMB_DATA_DIR=/data

WORKDIR /app
# Keep server/dist and web/dist side by side: the server looks for ../../web/dist relative to server/dist.
COPY --from=build /out/ /app/

COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
COPY deploy/litestream.yml /etc/litestream.yml
COPY --chmod=0755 deploy/run-with-litestream.sh /usr/local/bin/omb-with-litestream

# `omb` for operator commands, e.g. `docker compose exec server omb admin disable-board <id>`.
RUN printf '#!/bin/sh\nexec node /app/server/dist/cli.js "$@"\n' > /usr/local/bin/omb \
 && chmod 0755 /usr/local/bin/omb \
 && mkdir -p /data \
 && chown node:node /data

USER node
VOLUME /data
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.OMB_PORT || process.env.PORT || 8787) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/dist/cli.js", "serve"]
