# The AWS Lambda image for the web gateway and the poller (see "Lambda
# gateway" in infra/README.md). One image, two functions: each picks its
# handler with the function's image command (infra/terraform/lambda.tf),
#   app/packages/web/dist/lambda.handler     the web gateway (function URL)
#   app/packages/poller/dist/lambda.handler  the poller (EventBridge Scheduler)
#
# Build from the REPO ROOT:
#   docker build -f infra/docker/lambda.Dockerfile --platform linux/amd64 .
#
# Same shape as service.Dockerfile (turbo prune, frozen install, build, prune
# to production dependencies), but every stage is the OS-only Lambda base
# image, `provided.al2023`, with Amazon Linux's own Node.js package:
#
# - The web function runs on SnapStart, so every environment is a copy of one
#   snapshot. AL2023's Node links the system OpenSSL, which in this image is
#   the snapshot-safe build that reseeds itself on restore; the Node.js base
#   image's Node carries its own OpenSSL, which does not.
# - There is no Node runtime client in this image; ours is
#   app/packages/web/dist/lambda-runtime.mjs (server-core's lambda-runtime.ts),
#   started by the bootstrap below. It provides `awslambda.streamifyResponse`
#   to the web handler and the SnapStart hooks.
# - Building in the same image keeps native addons on the glibc and the Node
#   ABI they run against.

ARG NODE_MAJOR=22

FROM public.ecr.aws/lambda/provided:al2023 AS base
ARG NODE_MAJOR
ENV CI=true \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
# The image ships microdnf as `dnf`. corepack is not in AL2023's Node
# package; it picks up the pinned pnpm from the root package.json
# packageManager field.
RUN dnf install -y nodejs${NODE_MAJOR} nodejs${NODE_MAJOR}-npm && dnf clean all \
    && npm install -g corepack@0.36.0 && corepack enable
WORKDIR /repo

# --- Prune the monorepo down to both packages' dependency subtrees ----------
FROM base AS pruner
COPY . .
RUN pnpm dlx turbo@2 prune @infrawrench/web @infrawrench/poller --docker

# --- Install + build ---------------------------------------------------------
FROM base AS builder
# Toolchain for native modules (ssh2's optional cpu-features, etc.).
RUN dnf install -y python3 make gcc-c++ tar gzip && dnf clean all

COPY --from=pruner /repo/out/json/ .
RUN pnpm install --frozen-lockfile

COPY --from=pruner /repo/out/full/ .
COPY tsconfig.base.json .
RUN pnpm exec turbo run build --filter=@infrawrench/web --filter=@infrawrench/poller

# Drop devDependencies in place; dist/ and built native artifacts survive.
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

# --- Runtime ------------------------------------------------------------------
FROM public.ecr.aws/lambda/provided:al2023 AS runner
ARG NODE_MAJOR
RUN dnf install -y nodejs${NODE_MAJOR} && dnf clean all
ENV NODE_ENV=production
# The whole pruned workspace, so the bundles' externals (ssh2, dockerode, the
# Kubernetes client, libsql) resolve through each package's own node_modules
# exactly as they do in the service images. Lambda mounts it read-only; the
# server code writes only under os.tmpdir(), which is Lambda's /tmp.
COPY --from=builder /repo ${LAMBDA_TASK_ROOT}
# The base image's entrypoint runs this with _HANDLER set to the command.
RUN printf '#!/bin/sh\nexec /usr/bin/node "${LAMBDA_TASK_ROOT}/app/packages/web/dist/lambda-runtime.mjs"\n' \
      > ${LAMBDA_RUNTIME_DIR}/bootstrap \
    && chmod 755 ${LAMBDA_RUNTIME_DIR}/bootstrap
# SnapStart is only safe while Node draws from the snapshot-safe OpenSSL: fail
# the build if it stops linking the system libcrypto, or that stops being the
# snapshot-safe package's.
RUN ldd "$(readlink -f /usr/bin/node)" | grep -q ' /lib64/libcrypto\.so\.3 ' \
    && rpm -qf "$(readlink -f /lib64/libcrypto.so.3)" | grep -q '^openssl-snapsafe-libs-'
# Overridden per function by lambda.tf; this default is the web gateway.
CMD ["app/packages/web/dist/lambda.handler"]
