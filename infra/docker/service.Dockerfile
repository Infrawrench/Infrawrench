# Shared Dockerfile for the three backend services (web, poller, github-watcher).
# Parametrized by build args so CI builds all images from one file:
#   PACKAGE  — workspace package name, e.g. @infrawrench/web
#   APP_DIR  — package path in the repo, e.g. app/packages/web
#
# Build from the REPO ROOT:
#   docker build -f infra/docker/service.Dockerfile \
#     --build-arg PACKAGE=@infrawrench/web --build-arg APP_DIR=app/packages/web .
#
# The services bundle with esbuild but keep dependencies external (web uses
# --packages=external), so the runtime image needs a real node_modules tree.
# `turbo prune --docker` shrinks the workspace to just the target package and
# its workspace dependencies before installing.

ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV CI=true \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
# corepack picks up the pinned pnpm from the root package.json packageManager field
RUN corepack enable
WORKDIR /repo

# --- Prune the monorepo down to the target package's dependency subtree -----
FROM base AS pruner
ARG PACKAGE
COPY . .
RUN pnpm dlx turbo@2 prune "${PACKAGE}" --docker

# --- Install + build ---------------------------------------------------------
FROM base AS builder
ARG PACKAGE
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
RUN pnpm exec turbo run build --filter="${PACKAGE}"

# Drop devDependencies in place; dist/ and built native artifacts survive.
# --ignore-scripts is safe here: every native dep either shipped a prebuilt
# binary or already built in the full install above.
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

# --- Runtime ------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runner
ARG APP_DIR
ENV NODE_ENV=production
COPY --from=builder --chown=node:node /repo /app
WORKDIR /app/${APP_DIR}
USER node
# Every service package defines a `start` script (node dist/*.mjs)
CMD ["npm", "run", "start"]
