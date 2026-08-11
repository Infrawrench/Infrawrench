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
# npm is only a launcher here (`start` is a bare `node dist/*.mjs`), but it
# still tries to mkdir a cache and a log dir under $HOME/.npm, which is not
# writable under the manifests' `readOnlyRootFilesystem: true`.
#
# This is belt-and-braces, not a fix for a crash: npm 11 `.catch()`es both
# mkdirs and wraps the log-file open in a try/catch explicitly commented "if
# the user has a readonly logdir…", so a read-only root costs a suppressed
# verbose line and nothing else. Pointing it at the scratch volume the
# Deployments mount just means we are not relying on that swallowing behaviour
# staying true across an npm major.
ENV NPM_CONFIG_CACHE=/tmp/.npm \
    NPM_CONFIG_UPDATE_NOTIFIER=false
COPY --from=builder --chown=node:node /repo /app
WORKDIR /app/${APP_DIR}
# uid/gid 1000, created by the official node image. The Deployments pin
# runAsUser/runAsGroup to the same numbers — `runAsNonRoot` alone only proves
# the id isn't 0, and the COPY above chowns to this user specifically.
USER node
# Every service package defines a `start` script (node dist/*.mjs)
CMD ["npm", "run", "start"]
