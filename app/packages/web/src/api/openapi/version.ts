/**
 * The published API version.
 *
 * This one number drives the entire release pipeline. It is stamped into
 * `openapi.json`, becomes the version of all nine generated SDK packages, and
 * is what CI compares against the `sdk-v*` tags to decide whether to publish.
 * **Nothing ships until it changes.**
 *
 * Bump it in the same change as any user-visible API change: a new route, a
 * changed request or response shape, a new required field, a removed one.
 * Semver is against the HTTP surface, not the server's internals:
 *
 * - **patch**: additive fixes a client cannot observe as a break
 * - **minor**: new routes, new optional fields, new enum members
 * - **major**: anything an existing client could break on
 *
 * Adding or removing a plugin changes the `pluginId` / `resourceTypeId` enums,
 * which is a real change to the published surface; that counts.
 */
// 1.7.0: new `commitment_covered_usage` member on the CostChargeType enum
// (additive enum widening, on cost queries and cost exports).
// 1.8.0: the cost and FinOps completion pass; business metrics and unit
// costs, report annotations, nested cost centres, scenario models, billing
// rules, managed accounts and invoicing; plus API-key authentication across
// the org route tree and audit entries that name the key. All additive.
// 1.9.0: invoice delivery, and commitment-expiry, idle-commitment and
// unit-cost-regression alerts (new routes, new schemas, three new alert
// trigger enum members). All additive.
// 1.10.0: network flow cost attribution, anomaly acknowledgement, and the
// Kubernetes storage / load-balancer / control-plane allocation (new routes,
// new schemas, additive fields on CostAnomaly and CostAnnotation).
// 1.12.0: the quota & limit radar; provider quota utilisation, trend and an
// exhaustion alert (new /quotas routes and schemas, a new `quotaAlerts` alert
// trigger, and `quotas` on the TabTarget kind enum, without which a persisted
// Quotas tab is silently dropped on reload). All additive.
// 1.13.0: the blast-radius impact report; one new read route answering "what
// breaks if I delete this?" from the dependency graph, network flow
// attribution and the org objects that name a resource. Additive.
// 1.14.0: shared consoles; pair-on-prod for a live cloud SSH session. Eleven
// new routes under `/shared-consoles`, a `Shared consoles` tag, and two
// additive fields on SessionRecording (`sharedConsoleId`, `participants`) that
// attribute a shared session to everyone who was on it. All additive.
// 1.15.0: incident mode; declared operational incidents (`/incidents` CRUD,
// notes, the joined timeline and the postmortem export), the `incidents` tab
// kind on TabTarget, the `incidentAlerts` routing trigger, and `notices` on the
// public status-page payload. All additive.
// 1.16.0: the cross-cloud access review; the principals inside the customer's
// clouds (IAM users and roles, service accounts, app registrations, bindings,
// long-lived keys). Four new routes, a CSV/JSON evidence export, and a new
// "access-review" member on the workspace TabTarget enum. All additive.
// 1.17.0: reverting a change-timeline event; a dry-run plan and an apply on
// `/changes/{changeId}/revert`, plus an additive `revertedAt` on both change
// feed entry schemas. All additive.
// 1.18.0: cost per change / cost per deploy; a batched change-impact query,
// a per-deploy breakdown, and a route that pins either finding onto the cost
// charts as an annotation. Three new routes, no existing shape changed.
// 1.19.0: backup & restore coverage; the `/backups` feed and `/backups/policies`
// CRUD, plus a `backups` member on the TabTarget enum. All additive.
// 1.20.0: IaC reconciliation; the five `/iac/*` routes, the `iac:read` /
// `iac:write` permissions, and a new `iac` member on the workspace TabTarget
// kind enum. All additive.
// 1.21.0: ephemeral environments; capture a set of resources as a
// parameterised template, stamp copies out with a mandatory TTL, and tear them
// down (new `/environments` route family, new schemas, and a new
// `environments` member on the TabTarget kind enum). All additive.
// 1.22.0: `status-pages` on the TabTarget kind enum; status pages are their
// own workspace tab rather than a section of Probes, and without the enum
// member a persisted Status pages tab is silently dropped on reload. Additive.
// 1.23.0: workflow typings as a published route; GET
// `/workflows/{id}/typings` with an optional `enrich` query (static first paint
// vs live create-field unions). Additive.
// 1.24.0: reusable organization-level workflow secret metadata, write-only
// values, per-workflow assignment routes, and the human-only chat secret
// handoff endpoint. All additive.
// 1.25.0: chat `ask_question` answer route; the in-app agent can pause for a
// selection (with Other) or a textarea and resume once the user submits.
// 1.26.0: agent auth; anonymous registration (`POST /api/agent/identity`), the
// 24-hour trial workspace it opens, the claim ceremony (`/identity/claim` plus
// the session-authed `/api/agent/claim` and `/api/agent/claim/lookup`), and
// org-scoped registration listing and revocation. A new `Agent auth` tag, an
// unauthenticated route (the first in the public spec), and `iwa_` as a third
// bearer credential format. All additive: no existing route or shape changed.
// (Corrected before publication: the first cut of this spec described only the
// agent's half of the ceremony, and typed the revoke response as bare `Ok`
// when the route also returns `revoked`.)
// 1.28.0: the wallboard; one read (`GET /wallboard`) answering "is anything
// wrong right now" for a screen on a wall, plus a `wallboard` member on the
// workspace TabTarget kind enum. All additive.
// 1.29.0: the operations calendar; one dated view over freezes, sleep
// windows, deadlines, commitment terms, scheduled workflow runs and incidents
// (`/calendar`), revocable iCalendar subscriptions (`/calendar/subscriptions`),
// the unauthenticated `GET /api/calendar/{token}.ics` feed those mint, and a
// `calendar` member on the workspace TabTarget kind enum; without which a
// persisted Calendar tab is silently dropped on reload. All additive.
// 1.29.1: the wallboard drops its query-monitors source; it read a table
// whose migration had not shipped, so every wall named it as unreadable and
// sat amber. One fewer tile in `tiles`, which is an unenumerated list, and
// prose corrections either side of it; no route, shape or field changed.
// 1.30.0: the cloud as an SSH agent; POST `/ssh-keys/{id}/sign` produces one
// publickey-auth signature with a server-generated org key whose private half
// never leaves the cloud. What lets the desktop app stream Linux applications
// directly from a host using a cloud key. One new route, two new schemas and
// the SshSignAlgorithm enum. Additive.
// 1.31.0: Linux application host setup; `POST /apps/check` reports what a
// host is missing before applications can run there (gzip, xkb data, a session
// bus, fonts, software GL, an icon theme, and somewhere exec-capable to stage
// the app server), and `POST /apps/setup` installs it with the host's own
// package manager and re-probes. Two new routes, a `Linux applications` tag,
// and the first `application/x-ndjson` response in the document. All additive.
// 1.33.0: runbooks; the org's procedures as ordered steps (`/runbooks` CRUD),
// the runs performed against them with their per-step record of who did what
// (`/runbooks/{id}/runs`, `/runbooks/runs/*`), and a `runbooks` member on the
// workspace TabTarget kind enum, without which a persisted Runbooks tab is
// silently dropped on reload. All additive.
// 1.34.0: on-call rotations; `/on-call/schedules` CRUD, `/on-call/now`,
// shift previews and covers, plus a new `on-call` member on the
// AlertDestination union so a routing rule can name "whoever is on call"
// instead of a fixed channel. All additive.
// 1.35.0: status page custom domains; attach/refresh/detach a vanity
// subdomain via Cloudflare for SaaS, plus additive customHostname* fields on
// StatusPage. All additive.
// 1.36.0: restore drills; the record that somebody actually restored a
// backup, how long it took, and whether they checked what came back
// (`/backups/drills`, `/backups/drills/log`). Additive; the existing backup
// coverage shapes are unchanged.
// 1.37.0: query monitors; a read-only SQL query on a schedule with a
// threshold and an alert (`/query-monitors` CRUD plus `/query-monitors/test`,
// the editor's unsaved preview), and the wallboard's fourth source back, now
// that the table it reads exists. All additive.
// 1.38.0: withdraw the 1.35.0 status-page custom domain surface (the
// `custom-hostname` routes and `customHostname*` fields on StatusPage);
// rolled back pending an edge-routing fix; a reapply PR restores it. Strictly
// a removal, but versioned as a minor because the surface existed briefly and
// unannounced; treat 1.35–1.37 clients of those routes as unsupported.
// 1.39.0: query monitor targets; `/query-monitors/targets` lists what a
// monitor can run against: accounts with their own SQL driver plus the
// SQL-capable resources inside each (ClickHouse services, D1/Turso databases,
// Databricks warehouses, BigQuery datasets), which is what lets a monitor
// watch a database that is a resource rather than the account. Create/update
// now also validate a monitor's resource against the synced rows and fill
// `resourceTypeId` from the resource, so callers may omit it. All additive.
// 1.40.0: Tailscale plugin, cross-provider SSH service enrollment, and
// `supportsSshInstall` on resource detail, and agent service accounts plus
// T3 Code access over Tailscale. Additive.
// 1.41.0: new resource type ids on the `resourceTypeId` enum. Additive.
// 1.42.0: the carbon estimate; `GET /carbon`, estimated operational CO2e per
// resource, region, account and provider, with its assumptions and its
// unestimatable rows on the response. Carbon also rides beside every price:
// a `carbon` member on the `POST /resources/cost-estimate` response,
// `currentMonthlyKgCo2e`/`monthlyKgCo2eSaving` on OversizedResource,
// `monthlyKgCo2e`/`uncarbonedCount` on EnvironmentCostEstimate, and an
// optional `carbon` hint on the create-config response. All additive.
// 1.42.2: the Slack `install-url` now returns this server's
// `/api/slack/oauth/start` hop instead of a slack.com URL, and the state it
// carries expires after 30 minutes and only completes in the requesting
// user's own signed-in browser. Same response shape; open it the same way.
// 1.42.3: security fix. The workflow schedule sub-resource now requires
// `workflows:read` / `workflows:write` instead of the dashboard permissions,
// and PUT also needs `secrets:read` when the workflow has secrets assigned.
// Keys that held the dashboard permissions were granted the workflow ones by
// the earlier permission split, so existing clients keep working. Automated
// runs now act as the workflow's last editor rather than its creator.
// 1.43.0: Grafana Cloud and the October 2026 provider batch plugin IDs and resource type IDs. Additive.
// 1.44.0: cost visibility scopes and per-object sharing. Adds cost-visibility and sharing routes, costVisibility on /team/me, and sharing:override.
// 1.45.0: PDF export and scheduled dashboard delivery routes and schemas. Additive.
// 1.46.0: New Relic plugin and resource type IDs, plus provider-filled credential choices. Additive.
// 1.47.0: Datadog plugin; `datadog` on the `pluginId` enum and its resource type ids on the `resourceTypeId` enum. Additive.
// 1.48.0: the Anyscale plugin. Adds `anyscale` to the pluginId enum and its
// resource types (organization, cloud, project, workspace, job, service,
// compute-config, budget) to the resourceTypeId enum.
// 1.49.0: Baseten plugin; `baseten` on the `pluginId` enum and its resource
// type ids on the `resourceTypeId` enum. Additive.
// 1.50.0: FOCUS 1.3. Cost exports gain `schema` (`native` | `focus-1.3`;
// optional on input, where omitted keeps the stored value, and always present
// on CostExport), and `POST /costs/focus-export` downloads the rows a cost
// query selects as a FOCUS 1.3 CSV. Additive.
// 1.51.0: warehouse destinations for cost exports (Snowflake and Databricks
// tables): a `warehouse` branch on CostExportDestination, plus
// `GET /cost-exports/warehouse-sinks`, `POST /cost-exports/warehouse-options`
// and `POST /cost-exports/warehouse-setup`. Additive.
// 1.52.0: price catalog. `GET /price-catalog/providers`, `/search` and
// `/compare` (resources:read), and `price-catalog` on the TabTarget enum. Additive.
// 1.53.0: managed-account pricing. `tiered` and `expression` billing-rule kinds with
// `tiers`/`tierMode`/`tierScope`/`expression` and `managedAccountIds`; `pricing` on managed
// accounts (re-rating to public pricing, discount treatment); per-line `effects` and
// `effects`/`rerateCoverage`/`warnings`/`expressionFailures` on invoice derivations;
// `POST /billing-rules/preview` and `POST /billing-rules/reorder`. Additive.
// 1.54.0: GitHub issue filing (`/github-issues/*`), the `github-issues` alert routing destination, the `savingsFindings` trigger, the `savings_finding` push payload and the `github-issues:read`/`:write` permissions. Additive.
// 1.55.0: cost canvases (`/cost-canvases` CRUD, draft, preview, run, PDF and
// delivery schedules), a `cost_canvas` dashboard widget kind and sharing
// object type, `cost-canvases` on the TabTarget kind enum (with `canvasId`),
// and the `6m` relative date-range preset. All additive.
// 1.56.0: AI request attribution; /ai-attribution sources, dimensions, locations, stats, spend
// and reattribute routes. Caller dimensions surface as `caller:<key>` tag keys. Additive.
// 1.57.0: budget hierarchies, usage budgets and flexible periods. Budgets gain
// `measure`, `usageUnit`, `usageAmount`, `period` and `parentBudgetId`;
// `amountCents` becomes optional (a usage budget and an explicit period list
// do not use it); `BudgetWithStatus` gains the current period, its limit, the
// usage figures and the rollup fields; alert events gain the period bounds and
// usage figures; `GET /costs/dimensions` accepts `dimension=usage-units`; and
// `GET /budgets/{id}` is documented as the `BudgetWithStatus` it always
// returned. All additive.
export const API_VERSION = "1.57.0";
