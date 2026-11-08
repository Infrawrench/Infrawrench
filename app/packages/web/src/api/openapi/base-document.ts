/**
 * The parts of the OpenAPI document no endpoint describes: `info`, the
 * advertised servers, the security schemes, and the tag list with each tag's
 * description. Plain data; every operation and component comes from an
 * HttpApi domain (`http/openapi.ts`), the plugin registry (`./dynamic.ts`) or
 * the event catalog (`./event-webhooks.ts`).
 */

/** A security scheme, as `components.securitySchemes` holds it. */
export type SecurityScheme =
  | {
      readonly type: "apiKey";
      readonly in: "cookie" | "header" | "query";
      readonly name: string;
      readonly description: string;
    }
  | {
      readonly type: "http";
      readonly scheme: "bearer";
      readonly bearerFormat: string;
      readonly description: string;
    };

export interface OpenApiTag {
  readonly name: string;
  readonly description?: string;
}

export const API_INFO_TITLE = "Infrawrench API";

export const API_INFO_DESCRIPTION =
  "REST API for the Infrawrench cloud SaaS. Plugin and resource type IDs are enumerated from the live plugin registry at spec-build time, so this document always matches what the running server actually accepts.";

export const API_LICENSE = { name: "BUSL-1.1", url: "https://mariadb.com/bsl11/" } as const;

export const SECURITY_SCHEMES: Readonly<Record<string, SecurityScheme>> = {
  sessionCookie: {
    type: "apiKey",
    in: "cookie",
    name: "wos-session",
    description:
      "WorkOS-issued sealed session cookie (httpOnly, set by `/callback`). Used by browser clients.",
  },
  bearerAuth: {
    type: "http",
    scheme: "bearer",
    bearerFormat: "JWT",
    description: "WorkOS access token (JWT) or Infrawrench API key. Used by programmatic clients.",
  },
  // The `/api/agent-link` operations (`http/domains/agent-link-platform/`) name it.
  agentLinkCredential: {
    type: "http",
    scheme: "bearer",
    bearerFormat: "iwl_",
    description: "An agent link credential, collected once from the device flow's token poll.",
  },
};

/** What an operation with no `security` of its own accepts: the cookie or a bearer credential. */
export const DEFAULT_SECURITY: ReadonlyArray<Readonly<Record<string, readonly string[]>>> = [
  { sessionCookie: [] },
  { bearerAuth: [] },
];

/**
 * Every tag, in the order the docs sidebar lists them. A domain's group names
 * its tag (`OpenApi.Title`); a tag a domain introduces that is missing here is
 * appended after these, with the description the group gave it.
 */
export const TAGS: readonly OpenApiTag[] = [
  { name: "Auth", description: "Session and identity." },
  {
    name: "Profile",
    description:
      "The signed-in user's own account: name, password reset, two-factor factors, and active sessions.",
  },
  { name: "Organizations", description: "Org creation and membership." },
  { name: "Invitations", description: "Accepting team invites." },
  { name: "Accounts", description: "Provider connections (cloud accounts)." },
  { name: "Dashboards", description: "Pinned resources, custom dashboards." },
  {
    name: "Custom graphs",
    description: "Script-defined dashboard charts run in a server-side sandbox.",
  },
  {
    name: "Costs",
    description:
      "Actual spend, collected from provider billing APIs into daily rows and queried by " +
      "dimension, plus pushed rows for systems without a plugin. Totals are net (credits, " +
      "refunds and tax included) unless a charge-type filter narrows them.",
  },
  {
    name: "Commitments",
    description:
      "Reserved instances, savings plans and committed-use discounts: what was purchased, how much of the usage bill it covers (a range, not a single figure), utilization over days with collected cost data, and a planner that sizes new commitments at the p10 floor of uncovered spend. Read-only: nothing here purchases.",
  },
  {
    name: "AI attribution",
    description:
      "Splits billed AI spend by caller (team, user, feature, customer, or any request-metadata key) by joining per-request logs (Bedrock invocation logs, Cloudflare AI Gateway logs, LiteLLM spend logs, custom JSONL in S3) to provider bills. Requests are priced at list rates and scaled to the billed amount, with an explicit `(unattributed)` remainder. Caller dimensions appear in cost reports as the tag keys `caller:<dimension>`.",
  },
  {
    name: "Network flows",
    description:
      "Priced source-to-destination attribution of egress and cross-zone traffic: which two things are talking, across which billing boundary, and what it costs. Everything is an estimate: flow logs sample, and prices are published list rates with no free tier, volume tier or negotiated discount. Collection is off until an organization enables it, because the queries are billed to its own cloud account.",
  },
  {
    name: "Cost reports",
    description:
      "Named, addressable saved cost graphs. A report owns its config as an org object, so " +
      "dashboards can reference it by id (the `cost_report` widget kind) and it can be run " +
      "by id without the caller reassembling the query.",
  },
  {
    name: "Cost forecasts",
    description:
      "Named forecasts on a cost report: the automatic trend forecast, or a driver business " +
      "metric's forecasted values times the projected unit cost, with scenario models applied " +
      "in priority order. Every forecast carries a low/expected/high band from the " +
      "least-squares prediction interval.",
  },
  {
    name: "Cost canvases",
    description:
      "Reports built from a plain-language description by the chat agent: a saved, " +
      "strictly validated spec of KPI tiles, charts, tables, budgets, anomalies and short " +
      "narrative. The spec stores queries, not numbers, so running a canvas re-executes " +
      "them with no model call; edits proposed in chat are approved against a diff.",
  },
  {
    name: "Kubernetes efficiency reports",
    description:
      "Saved views over Kubernetes clusters' derived cost: per cluster, namespace, workload, " +
      "label, node pool or cost category, how much of the money bought capacity that was " +
      "used, requested but unused, unmeasured, idle, or overhead, with an efficiency " +
      "percentage on a total or allocated basis. Filed in cost-report folders and shared " +
      "like cost reports; every read is narrowed to the caller's cost visibility scope.",
  },
  {
    name: "Cost annotations",
    description:
      'Dated notes drawn over cost charts, such as "we migrated to Graviton here". A note has a start day and an optional end day. Without a report id it appears on every cost chart; with one, only on that report. Annotations never change a series, total or axis.',
  },
  {
    name: "Scenario models",
    description:
      "Named, reusable sets of adjustments overlaid on a cost forecast, for known future cost such as a purchase next quarter or a team starting in September. Applying one never replaces the trend: queries return both lines and recorded history is untouched. Budgets opt in per budget.",
  },
  {
    name: "Billing Rules",
    description:
      "The organization's own adjustments to collected spend: a markup that recovers shared overhead, a negotiated discount, a fixed charge per period, or a reallocation that moves a shared cluster's cost onto the teams that use it.\n\nAdjustments are applied **at query time and never written into stored cost data**, so collected spend still reconciles against an invoice. Adjusted answers carry the collected totals beside the adjusted ones and name the rules that moved them. Anything that pages a human (budgets, anomaly detection, change alerts, the digest) measures collected spend unless it opts in per object; cost exports are always raw.\n\nPercentage rules compose (two 10% markups are 21%, not 20%) while reallocation is first-match-wins, so a row moves exactly once and total spend is conserved.",
  },
  {
    name: "Business metrics",
    description:
      "The denominators unit costs divide by (customers, requests, GB processed, revenue), reported by the organization, plus the query that divides spend by them. Unit cost is a summed numerator over a summed denominator at the requested bucket, a period with no value is an explicit gap rather than zero, and currencies are never merged. Margin is offered only for revenue-shaped metrics, in their own currency.",
  },
  {
    name: "Cost alerts",
    description:
      "Change-based cost alerts: fire when spend on a chosen scope moves more than a " +
      "configured percent and/or amount versus the prior period, on a daily, weekly or " +
      "monthly cadence. The third alert family; budgets watch an absolute monthly total, " +
      "anomaly detection watches statistical outliers against a learned baseline, and these " +
      "watch a configured relative change.",
  },
  {
    name: "Cost exports",
    description:
      "Recurring dumps of raw cost rows to S3-compatible storage or an HTTPS endpoint, one object per period at a deterministic key. Provider spend is restated for days after the fact, so each run also re-writes periods inside a trailing restatement window and stamps rows with the collection watermark.",
  },
  {
    name: "Workflows",
    description:
      "Workflow (runbook) surface exposed over HTTP; the approval requests " +
      "raised by infra.waitForApproval(...) inside runs, and the cron-schedule " +
      "sub-resource. Full workflow CRUD is managed in the app.",
  },
  {
    name: "Chat",
    description:
      "Hosted AI chat; conversation CRUD, the SSE agent stream, pending-action " +
      "approval, secure secret handoff, and structured answers to agent questions.",
  },
  {
    name: "Resources",
    description: "CRUD, manifest, logs, secrets, metrics; all dispatched to plugins.",
  },
  {
    name: "Changes",
    description:
      "Change timeline / drift feed; resources that appeared, changed, or disappeared between polls.",
  },
  {
    name: "Connections",
    description: "SQL / KV / Docker / SFTP / Storage operations against live resources.",
  },
  { name: "Associations", description: "Output-reference wiring between resources." },
  { name: "Search", description: "Cross-account resource search." },
  {
    name: "Orphans",
    description:
      "Likely-orphaned and idle resources flagged by plugin heuristics, with best-effort cost.",
  },
  {
    name: "Seats",
    description:
      "Paid SaaS seats (Copilot, Cursor, GitLab, Okta...) with inactive, duplicate and downgrade findings.",
  },
  {
    name: "DNS",
    description:
      "Cross-provider DNS inventory; every synced zone and record, with dangling targets flagged as subdomain-takeover candidates.",
  },
  {
    name: "Sleep schedules",
    description:
      "Weekly off-at/on-at windows on resources whose plugin declares start/stop actions; the poller runs due transitions server-side.",
  },
  {
    name: "Resource leases",
    description:
      'Optional TTLs on resources ("a test cluster for 3 days"). Auto-delete leases are announced twice, then deleted at expiry by the poller, deferring during change freezes.',
  },
  {
    name: "Ephemeral environments",
    description:
      "Capture existing resources as a parameterised template, stamp out copies in dependency order with a mandatory TTL, and tear them down. Expiry runs through the resource-lease pass, so every copy deletes itself.",
  },
  {
    name: "Credit burndown",
    description:
      "Prepaid credit balances with a burn rate measured from the server's own readings and a runway bounded by both the burn and the credit's expiry. Only providers that expose a balance appear.",
  },
  {
    name: "Credential hygiene",
    description:
      "Unused API keys, unreferenced SSH keys, and members holding write permissions they never exercise, derived from the audit log and credential tables with no provider call. Only writes are audit-logged, so read permissions are not assessed.",
  },
  {
    name: "Break-glass access",
    description:
      "Time-boxed permission elevation: request specific permissions for a number of minutes with a reason, someone else approves, and it lapses on its own. Grants apply to every surface at once and are excluded from API keys.",
  },
  {
    name: "Session recordings",
    description:
      "Replayable asciicasts of SSH sessions opened through the cloud, downloadable in asciinema's format. Opt-in per organization, with a per-organization retention window.",
  },
  {
    name: "Shared consoles",
    description:
      "Pair-on-prod: share a live cloud SSH session with invited colleagues, with exactly one holding the keyboard. The invite link is only a locator; joining needs org membership and the same `resources:execute` a direct terminal needs. Joins, leaves, role changes, handovers and revocations are audit-logged.",
  },
  {
    name: "Synthetic probes",
    description:
      "HTTP uptime/latency checks run on an interval from an edge proxy outside the cluster; results land in the shared metric store and alert after N consecutive failures.",
  },
  {
    name: "SLOs",
    description:
      "Service-level objectives measured from the metric store (probe availability, probe latency, or a resource metric against a threshold) over a rolling 7, 28 or 30 day window, with error budget remaining and multiwindow burn-rate alerting routed through the org's alert rules.",
  },
  {
    name: "Quota radar",
    description:
      "How close each account is to its provider-enforced limits, with a trend fitted over recent readings. Used and limit both come from the provider, never from published defaults. A provider with no quota API contributes nothing rather than zero.",
  },
  {
    name: "Compliance",
    description:
      "Evidence Infrawrench already collects (access review, just-in-time access, the audit log, posture, vulnerabilities, backups and restore drills, the change timeline and freezes, session recordings, incidents) mapped to SOC 2 and ISO/IEC 27001:2022 Annex A controls, with a status and an owner per control, and downloadable or scheduled evidence packs.",
  },
  {
    name: "Vulnerabilities",
    description:
      "CVE findings read from each connected provider's own scanner and joined to what is actually running: a finding in an image names the pods, tasks and functions running that digest. Marked against the CISA Known Exploited Vulnerabilities catalog. A provider with no scanner contributes nothing rather than a clean result.",
  },
  {
    name: "Incidents",
    description:
      "Incidents the organization declares itself (not the provider status incidents under Resources). Declaring records the incident and can open a change freeze, pin the moment, announce through alert routing and post a status-page update; each side effect is recorded as an artefact, and a failure is stored rather than thrown. The timeline is assembled on read, and the postmortem export pre-fills everything except the judgement.",
  },
  {
    name: "Wallboard",
    description:
      "One screen for a wall display. It shows only what is true right now and worth crossing a room for: no history, trends or breakdowns. A source that fails is named on screen and turns the wall amber rather than showing green.",
  },
  {
    name: "Operations calendar",
    description:
      "One time axis over change freezes, sleep/wake schedules, declared deadlines, commitment term ends, cron-triggered workflow runs and declared incidents. Nothing on it is a new record; it is recomputed on every read, and a failing source costs only its own kind. Subscriptions mint an unauthenticated iCalendar URL whose 32-byte token is the sole credential and which carries scheduling facts only.",
  },
  {
    name: "Runbooks",
    description:
      "Runnable checklists: ordered steps, each a manual tick, a link, or a button that records which workflow run was started. A run snapshots every step's title, concurrent ticks do not overwrite each other, and closing a run leaves outstanding steps unsettled. Reading and performing take `resources:read`; editing takes `org:settings:write`.",
  },
  {
    name: "On-call",
    description:
      "Who to wake. A rotation is a list of people, a shift length and a handover time in a named zone; a routing rule's `on-call` destination resolves to one person at delivery time. Shift boundaries are calendar-day arithmetic in the rotation's zone, so daylight-saving changes do not drift. Covers override the rotation for their window and are audit-logged.",
  },
  {
    name: "Paging providers",
    description:
      "PagerDuty, incident.io and any plugin with the paging capability. A routing rule's `paging-provider` destination opens an alert on a provider target under a stable dedup key, so the alert's own recovery and an Infrawrench acknowledgement reach the same upstream alert; `provider-on-call` resolves whoever is on call upstream to members by email. Provider incidents can be mirrored into Infrawrench (by signed webhook and a reconcile pass) and acknowledged or resolved from here.",
  },
  {
    name: "Query monitors",
    description:
      "A SQL query on a schedule, with a threshold and an alert, for what the data itself says (a table stopped growing, a dead-letter queue filling). Only a single read-only statement is allowed, checked on every execution. A failed run is `unknown`, not `ok`, and the alert fires on the run that reaches the consecutive-breach threshold, not on every run after.",
  },
  {
    name: "Price catalog",
    description:
      "Published list prices for every catalog provider, normalized: products with specs (vCPU, memory, GPU, storage) and prices per region, unit and rate type (on-demand, spot, reserved and savings-plan terms where published). Search and compare equivalent instances across providers. These are list prices, never an org's negotiated rates. Providers whose price API needs credentials use one of the org's accounts on that plugin and report `no-account` without one.",
  },
  {
    name: "Instance pricing",
    description:
      "Read-only SQL over public instance price lists: every instance type's specs and every on-demand, committed and spot price in every region, with history, for twelve AWS services, RunPod GPU and CPU pods, Alibaba Cloud ECS, Azure virtual machines, Google Cloud Compute Engine, Hetzner cloud servers and Server Auction listings, OVHcloud Public Cloud and eco servers, Oracle Cloud compute and IBM Cloud Virtual Servers for VPC. The data behind instances.infrawrench.com, refreshed as each provider publishes. Any bearer credential can use it, with no scope. The older `/api/v1/aws-pricing` paths are deprecated aliases.",
  },
  {
    name: "Carbon",
    description:
      "Estimated operational carbon beside the cost, with every assumption on the response. A resource whose provider, region or size cannot be matched to a published figure gets no estimate rather than a guess. Coefficients come from the Cloud Carbon Footprint project and are not measured by us; storage, network and embodied emissions are excluded.",
  },
  {
    name: "Status pages",
    description:
      "Public, unauthenticated views of chosen synthetic probes. A page is created unpublished and reachable only via an unguessable slug; the public payload carries labels, states and uptime history, never probe URLs, resource ids or account names.",
  },
  {
    name: "Ownership",
    description:
      "Owner, purpose and authorizing ticket on any resource. The orphan finder annotates every flagged resource with its owner and counts the unowned ones; resource-scoped alerts are additionally delivered to the owning person.",
  },
  {
    name: "Log workspaces",
    description:
      "Saved multi-resource log tails: a named set of log streams plus a search expression, optionally alert-evaluated server-side.",
  },
  { name: "Connect", description: "Helpers for shipping credentials into other services." },
  { name: "Storage", description: "Object storage helpers (uploads via API key)." },
  { name: "SFTP", description: "SFTP helpers (uploads via API key)." },
  { name: "SSH keys", description: "Org SSH keys for tunnel/SSH access." },
  {
    name: "Linux applications",
    description:
      "Whether a Linux host can run graphical applications, and installing what it cannot. " +
      "The application session itself is a WebSocket and is not described here.",
  },
  { name: "SSH tunnels", description: "Server-side SSH tunnel lifecycle." },
  {
    name: "SSH fan-out",
    description: "Run one command across many SSH hosts, with saved snippets.",
  },
  {
    name: "Bastions",
    description:
      "Per-account egress agents; register a bastion, run the agent container on your infra, and bind accounts to it so cloud control-plane traffic exits from your IP.",
  },
  { name: "Agents", description: "Agent VM defaults, sessions, and reconciliation helpers." },
  { name: "Team", description: "Members and invitations." },
  { name: "Billing", description: "Stripe checkout and portal." },
  { name: "Audit", description: "Audit log access." },
  {
    name: "Change Freezes",
    description:
      "Org-level change freeze windows. While one is in effect, destructive actions are blocked (423) unless explicitly overridden by an admin.",
  },
  {
    name: "Currency",
    description:
      "Opt-in conversion of mixed-currency spend into one display currency, at exchange " +
      "rates the organization states itself with an effective date. Nothing is converted " +
      "until a display currency is set, no live FX is ever fetched, and a currency with no " +
      "configured rate is reported unconverted rather than dropped from the total.",
  },
  { name: "API keys", description: "Programmatic access tokens." },
  {
    name: "Agent auth",
    description:
      "Anonymous agent registration, the 24-hour trial workspace it opens, and the claim " +
      "ceremony that binds it to a person. See /auth.md for the agent-facing guide.",
  },
  {
    name: "Agent links",
    description:
      "Linking a platform (such as Nibblets) to an organization with a device flow, and the " +
      "scoped agents the linked platform creates, edits and revokes with its `iwl_` credential.",
  },
  { name: "WebSocket", description: "Auth tokens for the WebSocket gateway." },
  { name: "Sync", description: "Bi-directional resource sync (used by the desktop app)." },
  { name: "Webhooks", description: "Inbound webhooks from third parties." },
  {
    name: "Admin",
    description:
      "Platform-operator surface (INFRAWRENCH_PLATFORM_ADMIN_EMAILS allowlist), e.g. complimentary orgs.",
  },
  {
    name: "Pages",
    description:
      "On-call alerts raised by your own systems, fanned out over the org's SMS, push, Slack, and Teams transports.",
  },
  { name: "Push", description: "Mobile push notification devices and preferences." },
  {
    name: "Alerts",
    description:
      "Ordered alert routing rules (which alerts reach which destinations, with quiet hours and escalation) plus the held and awaiting-acknowledgement delivery queue.",
  },
  {
    name: "Slack",
    description:
      "Slack workspace connection and the channels alert rules can name as destinations.",
  },
  {
    name: "Microsoft Teams",
    description:
      "Microsoft Teams webhook connections and the channels alert rules can name as destinations.",
  },
  {
    name: "Leaked credentials",
    description:
      "Secrets a scanner account (GitHub secret scanning, GitLab secret detection) found committed to code, matched by keyed fingerprint to the account or stored secret they belong to, and rotated from here.",
  },
  {
    name: "Event subscriptions",
    description:
      "Outbound delivery of Infrawrench's own events (cost anomalies, budget thresholds, posture findings, drift, incidents, just-in-time access, SLO and metric alerts, sync failures) to a signed HTTPS webhook, an AWS EventBridge bus or a GCP Pub/Sub topic. The payload of every event type is described under `webhooks`.",
  },
  {
    name: "Jira",
    description:
      "Jira Cloud connection, project and issue-type pickers, and filing a finding " +
      "(cost anomaly, orphan, oversized resource, posture finding, expiring credential, " +
      "failed probe, extended-support finding) as a tracked issue.",
  },
  {
    name: "Linear",
    description:
      "Linear workspace connection, team picker, and filing a finding (cost anomaly, " +
      "orphan, oversized resource, posture finding, expiring credential, failed probe, " +
      "extended-support finding) as a tracked issue.",
  },
  {
    name: "GitHub issues",
    description:
      "Filing findings as GitHub issues through the organization's GitHub App " +
      "installation: repository routing by cost centre or tag, label and assignee " +
      "pickers, dedupe by finding fingerprint, and pull requests editing Terraform for " +
      "IaC-managed findings.",
  },
];
