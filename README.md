# Infrawrench

Infrastructure management for the cloud and your servers — desktop app and web SaaS, sharing one plugin system.

- **Desktop** (Electron + React, local SQLite) — works offline, runs SSH terminals, SQL editors, K8s exec and SFTP browsers locally.
- **CLI** (`infrawrench …`) — the desktop app doubles as a terminal tool: an interactive TUI dashboard with charts, plus scriptable `--json`/text output over the same local accounts, cloud session, and organizations.
- **Web** (Hono + Vite/React + Neon Postgres + WorkOS) — same plugins server-side, with SSH/SQL/K8s proxied through a WebSocket server.
- **Plugins** — one self-contained package per provider. Currently: AWS, Azure, GCP, DigitalOcean, Hetzner, Scaleway, Fly, Vercel, Netlify, Cloudflare, Cloudinary, Databricks, Neon, Turso, PlanetScale, Kubernetes, Docker, Postgres, MySQL, Redis, Memcached, ClickHouse, SSH.

The Electron and Hono hosts are deliberately generic — all provider-specific logic (API calls, field shapes, SQL strings, credentials) lives in the plugin packages under `plugin-architecture/packages/`.

## Repo layout

```
infrawrench/
├── plugin-architecture/packages/   # plugin-base + per-provider plugins
└── app/packages/
    ├── desktop/        # Electron app
    ├── web/            # Hono + Vite/React SaaS
    ├── server-core/    # db, schema, plugin loader, sync (shared by web + poller)
    ├── poller/         # background resource poller
    ├── ui/             # shared React components
    └── website/        # Astro landing site + docs
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
pnpm format       # prettier --write .
```

To run a single app:

```bash
pnpm --filter @infrawrench/desktop dev
pnpm --filter @infrawrench/web dev
pnpm --filter @infrawrench/website dev
```

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

## Documentation

User-facing docs live in `app/packages/website/src/content/docs/` and are published with the website. Architecture, conventions and gotchas for contributors are in [`KNOWLEDGE.md`](./KNOWLEDGE.md); hard rules for code changes are in [`CLAUDE.md`](./CLAUDE.md).

## License

[Business Source License 1.1](./LICENSE).
