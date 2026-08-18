/**
 * The published API version.
 *
 * This one number drives the entire release pipeline. It is stamped into
 * `openapi.json`, becomes the version of all nine generated SDK packages, and
 * is what CI compares against the `sdk-v*` tags to decide whether to publish.
 * **Nothing ships until it changes.**
 *
 * Bump it in the same change as any user-visible API change — a new route, a
 * changed request or response shape, a new required field, a removed one.
 * Semver is against the HTTP surface, not the server's internals:
 *
 * - **patch** — additive fixes a client cannot observe as a break
 * - **minor** — new routes, new optional fields, new enum members
 * - **major** — anything an existing client could break on
 *
 * Adding or removing a plugin changes the `pluginId` / `resourceTypeId` enums,
 * which is a real change to the published surface — that counts.
 */
// 1.7.0: new `commitment_covered_usage` member on the CostChargeType enum
// (additive enum widening, on cost queries and cost exports).
// 1.8.0: the cost and FinOps completion pass — business metrics and unit
// costs, report annotations, nested cost centres, scenario models, billing
// rules, managed accounts and invoicing; plus API-key authentication across
// the org route tree and audit entries that name the key. All additive.
// 1.9.0: invoice delivery, and commitment-expiry, idle-commitment and
// unit-cost-regression alerts (new routes, new schemas, three new alert
// trigger enum members). All additive.
// 1.10.0: network flow cost attribution, anomaly acknowledgement, and the
// Kubernetes storage / load-balancer / control-plane allocation (new routes,
// new schemas, additive fields on CostAnomaly and CostAnnotation).
// 1.12.0: the quota & limit radar — provider quota utilisation, trend and an
// exhaustion alert (new /quotas routes and schemas, a new `quotaAlerts` alert
// trigger, and `quotas` on the TabTarget kind enum, without which a persisted
// Quotas tab is silently dropped on reload). All additive.
// 1.13.0: the blast-radius impact report — one new read route answering "what
// breaks if I delete this?" from the dependency graph, network flow
// attribution and the org objects that name a resource. Additive.
// 1.14.0: shared consoles — pair-on-prod for a live cloud SSH session. Eleven
// new routes under `/shared-consoles`, a `Shared consoles` tag, and two
// additive fields on SessionRecording (`sharedConsoleId`, `participants`) that
// attribute a shared session to everyone who was on it. All additive.
// 1.15.0: incident mode — declared operational incidents (`/incidents` CRUD,
// notes, the joined timeline and the postmortem export), the `incidents` tab
// kind on TabTarget, the `incidentAlerts` routing trigger, and `notices` on the
// public status-page payload. All additive.
// 1.16.0: the cross-cloud access review — the principals inside the customer's
// clouds (IAM users and roles, service accounts, app registrations, bindings,
// long-lived keys). Four new routes, a CSV/JSON evidence export, and a new
// "access-review" member on the workspace TabTarget enum. All additive.
// 1.17.0: reverting a change-timeline event — a dry-run plan and an apply on
// `/changes/{changeId}/revert`, plus an additive `revertedAt` on both change
// feed entry schemas. All additive.
// 1.18.0: cost per change / cost per deploy — a batched change-impact query,
// a per-deploy breakdown, and a route that pins either finding onto the cost
// charts as an annotation. Three new routes, no existing shape changed.
// 1.19.0: backup & restore coverage — the `/backups` feed and `/backups/policies`
// CRUD, plus a `backups` member on the TabTarget enum. All additive.
// 1.20.0: IaC reconciliation — the five `/iac/*` routes, the `iac:read` /
// `iac:write` permissions, and a new `iac` member on the workspace TabTarget
// kind enum. All additive.
// 1.21.0: ephemeral environments — capture a set of resources as a
// parameterised template, stamp copies out with a mandatory TTL, and tear them
// down (new `/environments` route family, new schemas, and a new
// `environments` member on the TabTarget kind enum). All additive.
// 1.22.0: `status-pages` on the TabTarget kind enum — status pages are their
// own workspace tab rather than a section of Probes, and without the enum
// member a persisted Status pages tab is silently dropped on reload. Additive.
// 1.23.0: workflow typings as a published route — GET
// `/workflows/{id}/typings` with an optional `enrich` query (static first paint
// vs live create-field unions). Additive.
// 1.24.0: reusable organization-level workflow secret metadata, write-only
// values, per-workflow assignment routes, and the human-only chat secret
// handoff endpoint. All additive.
// 1.25.0: chat `ask_question` answer route — the in-app agent can pause for a
// selection (with Other) or a textarea and resume once the user submits.
// 1.26.0: agent auth — anonymous registration (`POST /api/agent/identity`), the
// 24-hour trial workspace it opens, the claim ceremony (`/identity/claim` plus
// the session-authed `/api/agent/claim` and `/api/agent/claim/lookup`), and
// org-scoped registration listing and revocation. A new `Agent auth` tag, an
// unauthenticated route (the first in the public spec), and `iwa_` as a third
// bearer credential format. All additive — no existing route or shape changed.
// (Corrected before publication: the first cut of this spec described only the
// agent's half of the ceremony, and typed the revoke response as bare `Ok`
// when the route also returns `revoked`.)
// 1.28.0: the wallboard — one read (`GET /wallboard`) answering "is anything
// wrong right now" for a screen on a wall, plus a `wallboard` member on the
// workspace TabTarget kind enum. All additive.
// 1.29.0: the operations calendar — one dated view over freezes, sleep
// windows, deadlines, commitment terms, scheduled workflow runs and incidents
// (`/calendar`), revocable iCalendar subscriptions (`/calendar/subscriptions`),
// the unauthenticated `GET /api/calendar/{token}.ics` feed those mint, and a
// `calendar` member on the workspace TabTarget kind enum — without which a
// persisted Calendar tab is silently dropped on reload. All additive.
// 1.29.1: the wallboard drops its query-monitors source — it read a table
// whose migration had not shipped, so every wall named it as unreadable and
// sat amber. One fewer tile in `tiles`, which is an unenumerated list, and
// prose corrections either side of it; no route, shape or field changed.
export const API_VERSION = "1.29.1";
