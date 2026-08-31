# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 OpenMasjid-Solutions

# syntax=docker/dockerfile:1
#
# OpenMasjid Companion — multi-stage, multi-arch (amd64 + arm64).
# The JS build stages run on the native BUILD platform (fast, arch-independent
# output); only the runtime stage runs as the TARGET arch, where `npm ci` pulls the
# correct prebuilt native binaries (better-sqlite3) for that architecture.

# ---- Build the web app (musalli app + admin panel) → static files -----------
FROM --platform=$BUILDPLATFORM node:26-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ---- Compile the server (TypeScript → dist) ---------------------------------
FROM --platform=$BUILDPLATFORM node:26-slim AS server
WORKDIR /server
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/ ./
RUN npm run build

# ---- Runtime (target architecture) ------------------------------------------
FROM node:26-slim AS runtime
ENV NODE_ENV=production

LABEL org.opencontainers.image.title="OpenMasjid Companion" \
      org.opencontainers.image.description="Your masjid's prayer times and appeals, on every musalli's phone." \
      org.opencontainers.image.source="https://github.com/OpenMasjid-Solutions/OpenMasjidCompanion" \
      org.opencontainers.image.licenses="AGPL-3.0"

# ca-certificates: outbound HTTPS to the masjid's own Donations page (public campaign
# JSON) and to the browsers' push services. tini: reap children + forward signals so
# the container stops fast and tidily.
#
# No cloudflared here, deliberately. Remote access is the PLATFORM's job — OpenMasjidOS
# runs one Cloudflare tunnel for every app and we read our public address from
# /api/fabric/site. A second tunnel run from inside this container would be a competing
# public entrance to the same masjid that nobody in the dashboard can see or turn off.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# Production deps only — this resolves the per-arch prebuilt native binary
# (better-sqlite3) for the target architecture.
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

COPY --from=server /server/dist ./dist
COPY --from=web /web/dist ./public
# The release notes ship INSIDE the image so the account menu's "What's new" works with
# no internet. `.dockerignore` excludes *.md and then un-excludes this one.
COPY CHANGELOG.md ./CHANGELOG.md

# The data directory is created HERE, owned by the unprivileged user, and that is what
# makes `read_only: true` + `user: "1000:1000"` in the compose work: Docker copies the
# ownership and mode of the image's directory onto a FRESH named volume mounted over it.
# Create it before dropping to that user, or the volume comes up root-owned and the app
# cannot open its own database.
RUN mkdir -p /data && chown -R 1000:1000 /data /app

ENV PORT=8080 \
    DATA_DIR=/data \
    PUBLIC_DIR=/app/public
EXPOSE 8080
VOLUME ["/data"]

# uid 1000 is the `node` user in the official image. Named numerically so the compose's
# `user: "1000:1000"` and this line are obviously the same identity.
USER 1000:1000

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
