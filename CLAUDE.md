Plugins should have all their logic encapsulated within them. The base should be as generic as possible, and then each plugin should handle everything. We don't want the electron code to have platform specific stuff. Update KNOWLEDGE.md as the project grows.

All code must be formatted with Prettier. Run `pnpm format` to format the entire project, or `pnpm format:check` to verify. The config is in `.prettierrc` at the root.

When you make changes to content that isn't specific to either web or desktop, make sure to implement on the other. Prefer sharing code where it makes sense to do so.

The desktop app doubles as the `infrawrench` CLI (`app/packages/desktop/electron/cli/`, entered via `--cli` in `electron/index.ts`). Keep `electron/cloud-tokens.ts` and `electron/db.ts` free of GUI side effects — the CLI depends on that. The CLI takes zero new runtime dependencies (hand-rolled ANSI output/charts, `node:util` parseArgs). When you add a user-facing data surface (new listing, metrics, costs-style feature), consider a CLI subcommand with `--json` + text output.

The mobile app (`app/packages/mobile`, Expo + expo-router) is a cloud companion that talks Bearer to the existing web API — it adds no server surface of its own. Platform-neutral client logic (fetch, tokens, SSE, chat contract, WS frames, push helpers) lives in `@infrawrench/client-core`, not in the mobile package; `@infrawrench/ui` re-exports the chat types from there, so shared contract changes go in client-core. Mobile can't use DOM libraries — give it a small native counterpart instead (e.g. `ChatMarkdown`). When you change a cloud feature the mobile app surfaces (chat, dashboards, resources, notifications), mirror the change there like you would between web and desktop; deliberate omissions (read-only billing, no editors) are listed in KNOWLEDGE.md. `assets/generated/terminal.html` is gitignored build output — `scripts/build-terminal-html.mjs` generates it, wired into `dev`/`android`/`ios`/`typecheck` and the `eas-build-post-install` hook; keep new generated assets on that pattern. Verify with `pnpm --filter @infrawrench/mobile typecheck`.

When you make code for providers remember that the user shouldn't have to know the API. If it needs a resource or a slug of some kind, add a picker. Also remember this replaces the cloud dash by in large and is not a replacement to it. If you add something, think about how the user can edit it if possible. Look online to verify API's, assume your memory is wrong. Make sure to include all possible metrics/side tools where possible. When you want a logo SVG, please also look online. You aren't good at freestyling logos.

## Workspace tabs

Org-level pages opened from the sidebar are **workspace-tab kinds, never plain routes** — a page outside the tab system leaves a stale active tab and a stale window title. The only exceptions are Moment and `/admin`, which get their titles from `plainRouteDocumentTitle` instead.

Adding a tab kind touches the whole chain, in one change:

- `ui/src/store/ui.store.ts` — the `WorkspaceTabTarget` union plus all three switches (`getWorkspaceTabId`, `getWorkspaceTabFallbackTitle`, `workspaceTabTargetsEqual`). For a single-instance tab with remembered state (Settings, Deploy), give it a fixed id but compare the state field in `workspaceTabTargetsEqual` — that is what makes the route sync record it and reactivation restore it.
- `ui/src/workspace-tabs.ts` — a target factory, exported from `ui/src/index.ts`.
- Both platforms' `lib/workspace-tabs.ts` — `getWorkspaceNavigateArgs` and `syncWorkspaceRouteFromPath` (desktop uses `?param=` search, web uses path segments).
- Both viewports' `renderPanel`, plus a no-op route stub per platform (tab content renders in the viewport, which keeps every open tab mounted).
- Desktop `__root.tsx` `validateWorkspaceTab` and the web `validate-tabs` kind list **and** the OpenAPI `TabTarget` enum — a kind missing there gets silently dropped on reload. The enum change means an `API_VERSION` minor bump.

Tests enumerate kinds in `{web,desktop}/src/lib/__tests__/workspace-tabs.test.ts`; the full conversion recipe with rationale is in KNOWLEDGE.md.

## Settings

The 14 settings sections are shared components in `ui/src/settings/`, rendered by web's thin `/org/:orgId/settings/*` route wrappers and by the desktop cloud-mode Settings tab (`DesktopSettingsPanel`). They get everything platform-specific — API transport, permissions, `openExternal`, cross-surface navigation — from `SettingsHostProvider` (`ui/src/settings/host.tsx`); never import `@/lib/api` or router primitives inside a section.

- **New section**: add it to `SETTINGS_SECTIONS` + `SettingsSectionBody`, a web route wrapper, and a docs page. Both platforms' navs derive from the registry.
- **New endpoint used by a section**: the desktop reaches the cloud through the single `cloud_settings_request` IPC channel, whose handler (`electron/cloud-data/settings.ts`) enforces a method+path allowlist. Add the new path there in the same change, or the section works on web and silently fails on desktop.
- Structured errors the sections branch on (seat limit, plan gate) live in `client-core/src/api-errors.ts` and must be thrown by both transports (web `apiFetch`, desktop `settings-client.ts`).

## Desktop changelog (git-cliff)

`include_paths` in `cliff.toml` limits the changelog to commits touching the desktop app or a workspace package it transitively depends on. When you add or remove a workspace dependency of `@infrawrench/desktop` (or of anything in its closure), recompute the closure and update the glob list in the same change. Currently that closure is `app/packages/{desktop,client-core,ui,workflow-runtime}` plus all of `plugin-architecture/` — a new desktop dep on e.g. `@infrawrench/telemetry` would need its path added, and a config key typo fails silently (it's `include_paths`, plural — the CLI flag is singular), so verify with `git-cliff --unreleased` against a commit that should be excluded.

## API versioning and SDK releases

`API_VERSION` in `app/packages/web/src/api/openapi/version.ts` is the single version number for the HTTP API. It is stamped into `openapi.json` and becomes the version of all nine generated client SDKs.

**Bump it in the same change as any user-visible API change.** That means a new or removed route, a changed request or response shape, a new required field, a new permission — and anything that alters the `pluginId` / `resourceTypeId` enums, which adding or removing a plugin does. Semver is against the HTTP surface, not the server's internals: patch for fixes a client cannot observe, minor for additive changes, major for anything an existing client could break on.

Nothing publishes until that number changes. `.github/workflows/publish-sdks.yml` regenerates the SDKs on every push that touches the spec, but only builds and publishes when the tag `sdk-v<API_VERSION>` does not already exist. Forgetting the bump means the spec ships and the clients silently do not.

After bumping, run `pnpm --filter @infrawrench/web generate:openapi` and commit the regenerated `openapi.json` — that command also refreshes the SDKs locally.

## Terraform provider

`terraform-provider-infrawrench/` at the repo root manages **Infrawrench's own configuration** as Terraform resources: cost allocation and reporting, monitoring, lifecycle governance, connected accounts and access control, and alert delivery (45 resources, 6 data sources). Its README carries the full design rationale; what follows is what binds changes made elsewhere in the repo.

Three unrelated features have "Terraform" in the name — **eject to Terraform** (`Plugin.terraformExport`, writes HCL describing _the user's cloud resources_), **org config as code** (`infrawrench config export/plan/apply`, whole-org JSON document), and **this provider** (per-object CRUD against the org-scoped routes). The provider deliberately does not wrap config as code: that document addresses entities by a name-derived `key` with no server id, so import is impossible and a rename becomes destroy-and-recreate. It also carries only a handful of the object types the provider manages.

- **It is outside every JS toolchain, on purpose.** Not in `pnpm-workspace.yaml`, not in `turbo.json`, not in `cliff.toml`'s `include_paths` (a standalone Go module is outside the desktop changelog's dependency closure). Build and test it on its own: `cd terraform-provider-infrawrench && gofmt -l . && go build ./... && go vet ./... && go test ./...`, Go 1.25+. `.github/workflows/terraform-provider.yml` runs exactly that and nothing else touches the module — `test.yml` is the pnpm workspace's CI and never reaches it. Its path filter covers the provider folder **and `app/packages/web/openapi.json`**, because the wire drift test reads the spec and a regeneration can break the module without touching a file in it.
- **Every URL and JSON body lives in `internal/iw/`** — `wire.go` (cost allocation and reporting) and `wire_platform.go` (everything else) for the structs, `endpoints.go` and `endpoints_platform.go` for typed per-object methods. Nothing under `internal/provider/` assembles a path or a body; the split across files is by domain and purely for readability, the package boundary is the invariant. These are hand-written rather than generated from the spec because the SDK generator collapses `discriminator` unions to `any` and drops `readOnly`/`default`, which are exactly the signals that decide whether an attribute is `Computed`.
- **A change to any route the provider covers is a change to the provider, in the same commit** — the same mirroring rule that holds between web, desktop and mobile. That is now most of the org-scoped configuration surface, not just cost: probes, metric alerts, status pages, schedules, freezes, custom graphs, log queries, accounts, bastions, roles, API keys, SSH keys, deploy triggers, workflow schedules, alert routing, Slack/Teams/Jira/Linear, the digest, and every `*/settings` singleton. `internal/iw/wire_spec_test.go` reads `app/packages/web/openapi.json` and fails when a schema property is neither decoded by a Go struct nor listed in that check's `ignored` list with a written reason. It runs one way only (extra Go fields are expected, since the checked-in spec lags the routes) and skips when the spec is absent, which keeps the module extractable to its own repository.
- **`schemasKnownAbsent` is empty as of the 1.9.0 spec regeneration**, which brought scenario models and billing rules into the document. Keep the list and `TestKnownAbsentSchemasAreStillAbsent`: the next object added ahead of a spec refresh goes there, and the test then says out loud when the refresh catches up.
- **Every resource must implement `ImportState` and `Configure`**; `provider_test.go` enforces both across the registry, because someone adopting the provider already has budgets and a resource without import would have to be deleted and recreated to come under management. Objects with no single-GET route (cost centres, allocation rules, report folders, probes, status pages, schedules, freezes, log queries, roles, SSH keys, bastions, API keys, snippets, accounts, deploy triggers, Slack channels, Teams webhooks, digest recipients, exchange rates, cost annotations, report notifications) are read by listing and filtering, and their `endpoints.go` wrapper synthesises the 404 itself so an out-of-band delete still surfaces as "needs recreating" rather than silent success. Bastions and API keys go further: DELETE only _revokes_, and the listing keeps returning revoked rows, so their wrappers treat a non-null `revokedAt` as a 404 or `terraform destroy` would silently no-op.
- **Adding a resource or data source** touches, in one change: `wire*.go` + `endpoints*.go`, the `internal/provider/resource_*.go` (or `datasource_*.go`) file, the registry in `provider.go`, `wantResources`/`wantDataSources` in `provider_test.go`, a `specChecks` entry when the spec describes the schema, the README's resource table, and `app/packages/website/src/content/docs/features/terraform-provider.md`. `documentation_test.go` checks the last two against the registry in both directions, so a forgotten row fails the build rather than shipping.
- **Adding a resource does not bump `API_VERSION`.** The provider is a client; it changes no HTTP surface. Changing a route it calls does.
- **Auth is Bearer**, from `INFRAWRENCH_API_KEY` / `INFRAWRENCH_ORG_ID` / `INFRAWRENCH_BASE_URL`. Only a WorkOS access token works today: the org-scoped tree's `sessionMiddleware` verifies the Bearer token as a JWT, so an `iwk_` API key 401s even when valid and correctly scoped. The provider detects that case and attaches an explanatory hint (`apiKeyAuthHint` in `internal/iw/errors.go`). Fixing it properly is a server-side change — moving those route groups onto `authenticateOrgRequest`, as chat and cost ingest already do — so if you make that change, delete the hint.
- Acceptance tests (`TF_ACC=1 go test ./...`) create and destroy real objects against a live org; they need credentials on top of `TF_ACC` and should only ever point at a scratch organization.

## Server environment variables

Every server-side variable read through `process.env` (web, poller, github-watcher) must be added to **both** places in the same change:

- `app/packages/web/.env.example` — local development.
- the `app_env` map in `infra/terraform/terraform.tfvars.example` — production.

There is no per-variable Terraform to write. `app_env` is a `map(string)` (`infra/terraform/variables.tf`) written wholesale into the `infrawrench-env` k8s secret that all three deployments `envFrom` (`infra/terraform/kubernetes.tf`), so a key added to the map is a key in the pods. The flip side is that nothing fails at plan time: a variable missing from the tfvars map is simply `undefined` in production, and the feature silently no-ops.

`terraform.tfvars` itself is gitignored — the example file is the only checked-in record of what the deployment expects, so treat it as documentation. Above each key say whether it is required or optional, what the value looks like or where to create it, and what degrades without it. Group related keys under one comment the way Slack, ClickHouse, and the GitHub App already are.

## Documentation

User-facing docs live in `app/packages/website/src/content/docs/`, organized by section:

- `getting-started/` — install, sign-up, first account
- `core-concepts/` — resources, accounts, output references, secret rerolls, desktop vs web
- `features/` — per-feature pages (SSH, SQL editor, KV console, dashboards, etc.)
- `plugins/` — one page per provider plugin
- `team-and-billing/` — org-level concerns (invites, roles, billing, audit log, SSH keys, API keys)

Each doc is a markdown file with frontmatter:

```yaml
---
title: Page title
description: One-line summary used for the doc index card and meta description.
sidebar_order: 3 # optional; lower numbers come first within a section
---
```

Internal links use relative paths with `.md` extensions (e.g. `[Add an account](./add-first-account.md)`, `[SSH](../features/ssh-terminal.md)`). The build strips `.md` so they resolve to the routed URLs.

When you change behavior the user can see, update the docs in the same change:

- **New plugin** — add `app/packages/website/src/content/docs/plugins/<plugin-id>.md`. Cover the auth method (PAT, OAuth, kubeconfig…), what resources it lists, and any quirks. Also update the plugin-count claims (see below).
- **Plugin count changed** (plugin added or removed) — the count is quoted in copy that goes stale silently. Update every claim in the same change; find them with `grep -rnE "[0-9]+\+? (plugins|providers)|All [0-9]+|and [0-9]+ more" app/packages/web/src app/packages/website/src`. Current locations: the docs plan table (`team-and-billing/billing-and-plans.md`, exact "All N"), the web onboarding plan card (`web/src/routes/onboarding.tsx`, exact "All N plugins"), and the marketing pages (`website/src/components/Hero.astro`, `website/src/data/feature-sections.ts` — which also has an "…and N more" bullet that must sum with its 8 named providers to the total — and the meta descriptions in `website/src/pages/index.astro`). Marketing copy uses a rounded-down "N+" (e.g. 47 plugins → "45+"); the docs table and onboarding card use the exact number. The count of `app/packages/website/src/content/docs/plugins/*.md` files should equal the registry in `app/packages/server-core/src/plugin-loader.ts` — that's the source of truth.
- **New feature or significant UX change** — update or add a page under `features/`.
- **Auth / cloud-sync / billing change** — update the relevant page under `getting-started/`, `core-concepts/`, or `team-and-billing/`.
- **Renamed UI string or moved menu item** — search docs for the old string (`grep -r "<old name>" app/packages/website/src/content/docs`) and update.
- **HTTP API change** (new/changed/removed route, new auth scope, changed request/response shape) — update the matching Zod schema in `app/packages/web/src/api/openapi/paths/`, run `pnpm --filter @infrawrench/web generate:openapi` to refresh `openapi.json`, and update `app/packages/website/src/content/docs/team-and-billing/openapi.md` if the change affects auth, scopes, generation workflow, or anything else covered there.

Screenshots are referenced inline as a one-line shorthand:

```
<insert [Brief description of the screenshot needed] here>
```

The build replaces these with a styled "Screenshot needed" placeholder. Put each `<insert ... here>` on its own line and describe what should be captured (which screen, what state, which data is highlighted). Don't fabricate images or commit binary screenshots without being asked — leave the placeholder so a human can capture the real thing.

After any docs change, verify the site still builds:

```
pnpm --filter @infrawrench/website build
```

### IMPORTANT: list new screenshots at the end of every response that touches docs

When you finish a response that adds or modifies docs, end the response with a clearly delimited section listing every screenshot placeholder you added or changed. Use this exact format so the user can scan it at a glance:

```
## 📸 Screenshots needed

- `app/packages/website/src/content/docs/<path>.md` — <description copied from the placeholder>
- `app/packages/website/src/content/docs/<path>.md` — <description copied from the placeholder>
```

NEVER EVER EVER add this into files.

Rules:

- **Always include this section, even if zero new screenshots were added** — in that case write `_None — no new screenshot placeholders in this change._` so the user knows you checked.
- Only list placeholders you **added or modified** in this change, not pre-existing ones in untouched files.
- One bullet per placeholder, in document order. If a single doc page has several, list them all.
- Quote the description verbatim from inside the `[ ]` brackets.
- Put this section at the very end of your response, after any other summary, so it is the last thing the user sees.
