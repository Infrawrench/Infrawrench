# Two-stage build keeps the runtime image tiny: build in a full Node toolchain,
# ship only the bundled JS + production node_modules.
FROM node:22-alpine AS builder
WORKDIR /build

# Copy package metadata first so dependency installs can be cached across rebuilds.
# --legacy-peer-deps: there is no lockfile here, and npm 10 crashes resolving
# vitest 4's optional @vitest/browser-* peers once their latest is 5.x
# ("Cannot read properties of null (reading 'edgesOut')"). The image only
# needs ws and esbuild, so skipping peer resolution loses nothing.
COPY package.json ./
RUN npm install --no-audit --no-fund --legacy-peer-deps

COPY tsconfig.json ./
COPY src ./src
RUN npx esbuild src/index.ts \
    --bundle \
    --platform=node \
    --target=node22 \
    --format=esm \
    --outfile=dist/index.mjs \
    --banner:js="import{createRequire}from'node:module';const require=createRequire(import.meta.url);"

FROM node:22-alpine
WORKDIR /app
LABEL org.opencontainers.image.title="Infrawrench Bastion Agent"
LABEL org.opencontainers.image.description="Outbound egress agent for Infrawrench accounts. Dials WSS to the backend; opens TCP streams on demand under an enforced allowlist."
LABEL org.opencontainers.image.source="https://github.com/Infrawrench/Infrawrench"
LABEL org.opencontainers.image.licenses="BUSL-1.1"

COPY --from=builder /build/dist/index.mjs /app/index.mjs

# Drop privileges — the agent only needs outbound network access.
USER node
ENTRYPOINT ["node", "/app/index.mjs"]
