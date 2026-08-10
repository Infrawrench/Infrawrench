# Dev image for docker-compose.dev.yml — one image runs web, poller and
# github-watcher via their tsx-watch `dev` scripts (compose overrides CMD per
# service). Source is baked in at build time and kept fresh at runtime by
# `docker compose watch` file sync, so this image trades size for a working
# in-container toolchain; it is never what ships (that is service.Dockerfile).

ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV CI=true \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
# corepack picks up the pinned pnpm from the root package.json packageManager field
RUN corepack enable
WORKDIR /repo

# --- Prune the monorepo down to the three services' dependency subtree -------
FROM base AS pruner
COPY . .
RUN pnpm dlx turbo@2 prune @infrawrench/web @infrawrench/poller @infrawrench/github-watcher --docker

# --- Install (with devDependencies — tsx, vite, drizzle-kit live there) ------
FROM base AS dev
# Toolchain for native modules (ssh2's optional cpu-features, etc.)
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Lockfile + package.json skeleton first so the install layer caches across
# source-only changes.
COPY --from=pruner /repo/out/json/ .
RUN pnpm install --frozen-lockfile

COPY --from=pruner /repo/out/full/ .
# turbo prune only carries package dirs; the shared tsconfig every package
# extends lives at the repo root.
COPY tsconfig.base.json .

# `turbo dev` dependsOn ^build, so warm the turbo cache for the workspace
# dependencies (ui, client-core, workflow-runtime, plugins…) now — container
# start then replays it instead of building 50+ packages on every `up`.
RUN pnpm exec turbo run build \
    --filter=@infrawrench/web^... \
    --filter=@infrawrench/poller^... \
    --filter=@infrawrench/github-watcher^...

ENV NODE_ENV=development
# Rebuild deps (turbo cache replay when nothing changed), then run the dev
# script DIRECTLY — not `turbo run dev`, whose strict env mode would strip
# undeclared variables (DATABASE_URL, WORKOS_*…) from the task process. Host
# dev never notices because env-loader reads web/.env inside the process; in
# these containers compose-provided env is the only source.
CMD ["sh", "-c", "pnpm exec turbo run build --filter=@infrawrench/web^... && pnpm --filter @infrawrench/web dev"]
