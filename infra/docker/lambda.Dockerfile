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
# to production dependencies), but every stage is the AWS Lambda Node.js base
# image rather than Debian: it is Amazon Linux 2023, and native addons built
# on a newer glibc than the one they run on fail to load. It also carries the
# runtime interface client, which is what provides `awslambda.streamifyResponse`
# to the web handler.

ARG NODE_VERSION=22

FROM public.ecr.aws/lambda/nodejs:${NODE_VERSION} AS base
ENV CI=true \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
# corepack picks up the pinned pnpm from the root package.json packageManager field
RUN corepack enable
WORKDIR /repo

# --- Prune the monorepo down to both packages' dependency subtrees ----------
FROM base AS pruner
COPY . .
RUN pnpm dlx turbo@2 prune @infrawrench/web @infrawrench/poller --docker

# --- Install + build ---------------------------------------------------------
FROM base AS builder
# Toolchain for native modules (ssh2's optional cpu-features, etc.). The
# Lambda base image ships microdnf as `dnf`.
RUN dnf install -y python3 make gcc-c++ tar gzip && dnf clean all

COPY --from=pruner /repo/out/json/ .
RUN pnpm install --frozen-lockfile

COPY --from=pruner /repo/out/full/ .
COPY tsconfig.base.json .
RUN pnpm exec turbo run build --filter=@infrawrench/web --filter=@infrawrench/poller

# Drop devDependencies in place; dist/ and built native artifacts survive.
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

# --- Runtime ------------------------------------------------------------------
FROM public.ecr.aws/lambda/nodejs:${NODE_VERSION} AS runner
ENV NODE_ENV=production
# The whole pruned workspace, so the bundles' externals (ssh2, dockerode, the
# Kubernetes client, libsql) resolve through each package's own node_modules
# exactly as they do in the service images. Lambda mounts it read-only; the
# server code writes only under os.tmpdir(), which is Lambda's /tmp.
COPY --from=builder /repo ${LAMBDA_TASK_ROOT}
# Overridden per function by lambda.tf; this default is the web gateway.
CMD ["app/packages/web/dist/lambda.handler"]
