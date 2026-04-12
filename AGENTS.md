## Cursor Cloud specific instructions

### Products

This is a pnpm + Turborepo monorepo with two products:

- **Web app** (`@infrawrench/web`) — Hono + Vite SPA on port 3000. Primary testable surface in cloud VMs.
- **Desktop app** (`@infrawrench/desktop`) — Electron app. Builds and unit tests work, but **cannot run** in cloud VMs (Electron's GPU process crashes without hardware acceleration). Test desktop changes via unit tests and the build only.

Shared: `@infrawrench/ui` (React component library), `@infrawrench/plugin-base` + 25 provider plugins.

### Required secrets (env vars)

The web app needs these secrets injected or placed in `app/packages/web/.env`:

- `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `WORKOS_REDIRECT_URI`, `WORKOS_COOKIE_PASSWORD` — WorkOS AuthKit auth
- `DATABASE_URL` — Neon PostgreSQL connection string
- `ENCRYPTION_MASTER_KEY` — AES-256-GCM key for credential encryption

### Key commands

See `package.json` scripts. Summary:

| Task | Command |
|---|---|
| Install deps | `pnpm install` |
| Build all | `pnpm build` |
| Dev (web) | `pnpm --filter @infrawrench/web dev` (port 3000) |
| Dev (desktop) | `pnpm --filter @infrawrench/desktop dev` (Electron) |
| Unit tests | `pnpm test` (vitest across all packages) |
| Typecheck | `pnpm typecheck` (tsgo across all packages) |
| Format check | `pnpm format:check` / `pnpm format` |
| DB migrations | `pnpm --filter @infrawrench/web db:migrate` |
| Integration tests | `pnpm test:integration` (needs provider API credentials) |

### Non-obvious caveats

- The web app's `server.ts` uses `tsx watch` — it auto-restarts on file changes. However, changes to workspace dependencies (plugin packages, `@infrawrench/ui`) require rebuilding those packages first (`pnpm --filter <pkg> build`) since the dev server loads them from `dist/`.
- `turbo dev` starts persistent dev servers for **all** packages. For web-only work, use `pnpm --filter @infrawrench/web dev` directly.
- The `.env` file for the web app must be at `app/packages/web/.env`. The custom `env-loader.mjs` reads it (not Vite's built-in dotenv). Environment variables already set in the shell take precedence over `.env` values.
- DB migrations (`db:migrate`) must be run before the web app can start if the database is fresh.
- `pnpm lint` currently has no configured lint scripts in individual packages — it's a no-op. Use `pnpm format:check` (Prettier) for style checks.
- Plugin-base must be built before any dependent plugin or app. `pnpm build` handles this via Turborepo's `dependsOn: ["^build"]`.
