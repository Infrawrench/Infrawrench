# Infrawrench

Infrastructure management for the cloud and your servers — desktop, web, mobile and CLI, sharing one plugin system.

- **Desktop** (Electron + React, local SQLite) — works offline, runs SSH terminals, SQL editors, K8s exec and SFTP browsers locally.
- **Web** (Hono + Vite/React + Neon Postgres + WorkOS) — same plugins server-side, with SSH/SQL/K8s proxied through a WebSocket server.
- **Mobile** (Expo + expo-router, iOS/Android) — a cloud companion against the same HTTP API: dashboards, resource browser, AI chat, SSH terminal, push notifications.
- **CLI** (`infrawrench …`) — the desktop app doubles as a terminal tool: an interactive TUI dashboard with charts, plus scriptable `--json`/text output over the same local accounts, cloud session, and organizations.

## What it does

Connect provider accounts once, then browse and edit every resource behind them from one place — with the things a provider console makes you leave for:

- **Consoles** — SSH terminals and jumpboxes, SQL editors, Redis/Memcached KV consoles, SFTP and object-storage file browsers, Docker controls.
- **Costs** — cross-provider spend, budgets and threshold alerts.
- **Dashboards** — resource metrics and charts, on the desktop, web and mobile.
- **AI** — chat and agents over your infrastructure, plus a hosted [MCP server](./app/packages/website/src/content/docs/features/mcp.md) at `/api/mcp` for Claude Desktop, Cursor, or any other MCP client.
- **Workflows** — TypeScript automations run in a QuickJS-WASM sandbox, triggered on a cron, a git push, or by hand.
- **Alerts** — mobile push, Slack, and phone paging on sync failures, budget breaches and workflow pages.

## Plugins

One self-contained package per provider, 152 of them, loaded in full by both the desktop app and the server (mobile renders what the cloud sends it):

Aiven, Algolia, Alibaba Cloud, Amazon Web Services, Anthropic, Anyscale, AssemblyAI, Auth0, Axiom, Backblaze B2, Baseten, Better Stack, Bitbucket, Buildkite, bunny.net, Cartesia, Cerebras, Checkly, Chronosphere, CircleCI, Civo, Clerk, ClickHouse, Cloudflare, Cloudinary, CockroachDB Cloud, Cohere, Confluent Cloud, Convex, Coralogix, CoreWeave, Couchbase Capella, Crusoe Cloud, Cursor, Databricks, Datadog, DataStax Astra, Deepgram, DeepSeek, Depot, Devin, DigitalOcean, Docker, Docker Hub, Doppler, Dynatrace, Elastic Cloud, ElevenLabs, Exoscale, fal, Fastly, Fireworks AI, Fly.io, GitHub, GitLab, Gladia, Google Cloud, Google Gemini, Grafana Cloud, Groq, HashiCorp Consul, HashiCorp Nomad, HashiCorp Vault, HCP Terraform, Heroku, Hetzner Cloud, Honeycomb, Hugging Face, IBM Cloud, incident.io, Infisical, InfluxDB Cloud, JFrog, Kafka, Koyeb, Kubernetes, Lambda Cloud, Linode (Akamai Cloud), Mailgun, Memcached, Metronome, Microsoft Azure, Mistral AI, Modal, MongoDB, MongoDB Atlas, MySQL, NATS, Neon, Netlify, New Relic, Northflank, Okta, OpenAI, OpenRouter, OpenSearch, OpenStack, Oracle Cloud, OVHcloud, PagerDuty, Paperspace, Perplexity, Pinecone, PlanetScale, PostgreSQL, PostHog, Postmark, Prometheus, Proxmox VE, Pulumi Cloud, Qdrant Cloud, RabbitMQ, Railway, Redis, Redis Cloud, Render, Replicate, Resend, Rev AI, Runpod, S3-Compatible Storage, SambaNova, Scaleway, SendGrid, Sentry, Snowflake, Spacelift, Speechmatics, Splunk Observability Cloud, SQL Server, SSH, Stripe, Supabase, Tailscale, Temporal Cloud, Tiger Cloud, Together AI, Turso, Twilio, UpCloud, UploadThing, Upstash, Vast.ai, Vercel, VMware vSphere, Voyage AI, Vultr, Wasabi, Weaviate Cloud, WorkOS, xAI, Xata.

The Electron and Hono hosts are deliberately generic — all provider-specific logic (API calls, field shapes, SQL strings, credentials) lives in the plugin packages under `plugin-architecture/packages/`. Plugins return schema data; the hosts render it.

## Repo layout

```
infrawrench/
├── plugin-architecture/packages/   # plugin-base + 28 provider plugins,
│                                   # plus shared sftp-host and ssh-tunnel-core
├── app/packages/
│   ├── desktop/            # Electron app (and the `infrawrench` CLI)
│   ├── web/                # Hono + Vite/React SaaS
│   ├── mobile/             # Expo iOS/Android app
│   ├── ui/                 # shared React components (web + desktop)
│   ├── client-core/        # host-agnostic cloud client — tokens, fetch, SSE, chat, push
│   ├── server-core/        # db, schema, plugin loader, sync (shared by the backend services)
│   ├── workflow-runtime/   # QuickJS-WASM workflow sandbox and host bridge
│   ├── poller/             # background resource poller
│   ├── github-watcher/     # polls GitHub App installs, fires git-triggered workflows
│   ├── bastion-agent/      # self-hosted agent that dials out, so calls exit your own IP
│   ├── egress-proxy/       # Cloudflare Worker running workflow fetch() off-cluster
│   ├── telemetry/          # Cloudflare Worker for anonymous desktop pings
│   └── website/            # Astro landing site + docs
├── infra/                  # Terraform, k8s manifests, service Dockerfile, container registry
└── patches/                # pnpm patchedDependencies
```

pnpm workspaces + Turborepo. All cross-package references use `workspace:*`.

## Getting started

Requirements: Node >= 20, pnpm >= 9.

```bash
pnpm install
pnpm dev          # run all apps in dev
pnpm build        # build everything
pnpm typecheck
pnpm test
pnpm lint
pnpm format       # prettier --write .
```

To run a single app:

```bash
pnpm --filter @infrawrench/desktop dev
pnpm --filter @infrawrench/web dev
pnpm --filter @infrawrench/mobile dev      # Expo; add ios / android to build natively
pnpm --filter @infrawrench/website dev
```

### Cloud stack in Docker Compose

The whole server-side stack (web, poller, github-watcher, Postgres, ClickHouse, [WorkOS emulator](https://github.com/workos/emulate)) can run containerized with hot reload — no WorkOS account or `.env` needed:

```bash
docker compose -f docker-compose.dev.yml watch
```

Then open http://localhost:3000 and log in as `dev@infrawrench.local` / `devpassword1!` (seeded in `infra/docker/workos-emulate/seed.yaml`). Migrations run automatically on `up`. Source edits sync into the containers and hot-reload; dependency changes (`pnpm-lock.yaml`) trigger an image rebuild.

Stripe uses a real **test-mode** account: put `STRIPE_SECRET_KEY=sk_test_...` (plus `STRIPE_PRICE_ID`, and `STRIPE_WEBHOOK_SECRET` from `stripe listen --print-secret`) in a gitignored `.env` at the repo root, and optionally forward webhooks with `docker compose -f docker-compose.dev.yml --profile stripe up stripe-cli`. Details in the header of `docker-compose.dev.yml`.

## CLI

The desktop app installs an `infrawrench` shell command (**Install shell command** in the app's sidebar footer, or `infrawrench cli install`). It launches the app headlessly and shares its data — local accounts, cloud session, all orgs.

```bash
infrawrench                # interactive TUI dashboard
infrawrench accounts       # local + every org
infrawrench resources -a prod --json
infrawrench metrics <resource-id> --last 6h
infrawrench costs --group-by provider
```

Docs: [`features/cli.md`](./app/packages/website/src/content/docs/features/cli.md). Implementation: `app/packages/desktop/electron/cli/`.

## HTTP API and SDKs

The cloud API is described by `app/packages/web/openapi.json`, generated from Zod route definitions in `app/packages/web/src/api/openapi/`. Client SDKs for nine languages — TypeScript, Python, Go, Rust, Ruby, PHP, Java, C#, Swift — are generated from that spec and published on release.

`API_VERSION` in `src/api/openapi/version.ts` is the single version number for all of it; bump it in the same change as any user-visible API change, then run `pnpm --filter @infrawrench/web generate:openapi`. Nothing publishes until that number changes.

## Documentation

User-facing docs live in `app/packages/website/src/content/docs/` and are published with the website. Architecture, conventions and gotchas for contributors are in [`KNOWLEDGE.md`](./KNOWLEDGE.md); hard rules for code changes are in [`CLAUDE.md`](./CLAUDE.md).

## License

[Business Source License 1.1](./LICENSE).
