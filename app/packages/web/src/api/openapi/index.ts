import { OpenAPIRegistry, OpenApiGeneratorV31 } from "@asteasolutions/zod-to-openapi";
import { injectSdkCodeSamples } from "../../../scripts/sdk/code-samples";
import { buildDynamicEnums } from "./dynamic";
import { injectInternalMarkers, toPublicDocument } from "./public-spec";
import { API_VERSION } from "./version";
import type { BuildContext } from "./context";

type OpenAPIObject = ReturnType<OpenApiGeneratorV31["generateDocument"]>;

import { registerAuthPaths } from "./paths/auth";
import { registerProfilePaths } from "./paths/profile";
import { registerOrgPaths } from "./paths/orgs";
import { registerInvitationPaths } from "./paths/invitations";
import { registerAccountPaths } from "./paths/accounts";
import { registerDashboardPaths } from "./paths/dashboards";
import { registerCostPaths } from "./paths/costs";
import { registerCostAnomalyFeedbackPaths } from "./paths/cost-anomaly-feedback";
import { registerCostReportPaths } from "./paths/cost-reports";
import { registerCostCanvasPaths } from "./paths/cost-canvases";
import { registerCostReportNotificationPaths } from "./paths/cost-report-notifications";
import { registerDashboardNotificationPaths } from "./paths/dashboard-notifications";
import { registerCostReportFolderPaths } from "./paths/cost-report-folders";
import { registerCostAnnotationPaths } from "./paths/cost-annotations";
import { registerCostExportPaths } from "./paths/cost-exports";
import { registerCostAlertPaths } from "./paths/cost-alerts";
import { registerSavedFilterPaths } from "./paths/saved-filters";
import { registerCostScenarioPaths } from "./paths/cost-scenarios";
import { registerBusinessMetricPaths } from "./paths/business-metrics";
import { registerOrphanPaths } from "./paths/orphans";
import { registerEnvironmentDiffPaths } from "./paths/environment-diff";
import { registerRightsizingPaths } from "./paths/rightsizing";
import { registerExtendedSupportPaths } from "./paths/extended-support";
import { registerBudgetPaths } from "./paths/budgets";
import { registerMetricAlertPaths } from "./paths/metric-alerts";
import { registerChangeFreezePaths } from "./paths/change-freezes";
import { registerTagPolicyPaths } from "./paths/tag-policy";
import { registerTagKeyPaths } from "./paths/tag-keys";
import { registerCurrencyPaths } from "./paths/currency";
import { registerCostCentrePaths } from "./paths/cost-centres";
import { registerCustomCostSourcePaths } from "./paths/custom-cost-sources";
import { registerBillingRulePaths } from "./paths/billing-rules";
import { registerVirtualTagPaths } from "./paths/virtual-tags";
import { registerInvoicePaths } from "./paths/invoices";
import { registerCustomGraphPaths } from "./paths/custom-graphs";
import { registerOrgConfigPaths } from "./paths/org-config";
import { registerWorkflowApprovalPaths } from "./paths/workflow-approvals";
import { registerWorkflowPaths } from "./paths/workflows";
import { registerWorkflowSecretPaths } from "./paths/workflow-secrets";
import { registerChatPaths } from "./paths/chat";
import { registerDeploymentPaths } from "./paths/deployments";
import { registerPagePaths } from "./paths/pages";
import { registerResourcePaths } from "./paths/resources";
import { registerResourceChangePaths } from "./paths/resource-changes";
import { registerChangeCostImpactPaths } from "./paths/change-cost-impact";
import { registerStatusIncidentPaths } from "./paths/status-incidents";
import { registerExpiringPaths } from "./paths/expiring";
import { registerQuotaPaths } from "./paths/quotas";
import { registerPosturePaths } from "./paths/posture";
import { registerAccessReviewPaths } from "./paths/access-review";
import { registerBackupPaths } from "./paths/backups";
import { registerWallboardPaths } from "./paths/wallboard";
import { registerCalendarPaths } from "./paths/calendar";
import { registerRunbookPaths } from "./paths/runbooks";
import { registerOnCallPaths } from "./paths/on-call";
import { registerPagingProviderPaths } from "./paths/paging-providers";
import { registerQueryMonitorPaths } from "./paths/query-monitors";
import { registerCarbonPaths } from "./paths/carbon";
import { registerPriceCatalogPaths } from "./paths/price-catalog";
import { registerDnsPaths } from "./paths/dns";
import { registerMomentPaths } from "./paths/moment";
import { registerSchedulePaths } from "./paths/schedules";
import { registerLeasePaths } from "./paths/leases";
import { registerEnvironmentPaths } from "./paths/environments";
import { registerSessionRecordingPaths } from "./paths/session-recordings";
import { registerSharedConsolePaths } from "./paths/shared-consoles";
import { registerAccessRequestPaths } from "./paths/access-requests";
import { registerJitAccessPaths } from "./paths/jit-access";
import { registerCredentialHygienePaths } from "./paths/credential-hygiene";
import { registerCreditPaths } from "./paths/credits";
import { registerCostVisibilityPaths } from "./paths/cost-visibility";
import { registerCommitmentPaths } from "./paths/commitments";
import { registerSavingsPaths } from "./paths/savings";
import { registerNetworkFlowPaths } from "./paths/network-flows";
import { registerAiAttributionPaths } from "./paths/ai-attribution";
import { registerProbePaths } from "./paths/probes";
import { registerSloPaths } from "./paths/slos";
import { registerIncidentPaths } from "./paths/incidents";
import { registerStatusPagePaths } from "./paths/status-pages";
import { registerOwnershipPaths } from "./paths/ownership";
import { registerIacPaths } from "./paths/iac";
import { registerLogWorkspacePaths } from "./paths/log-workspaces";
import { registerConnectionFeaturePaths } from "./paths/connection-features";
import { registerAssociationPaths } from "./paths/associations";
import { registerDependencyGraphPaths } from "./paths/dependency-graph";
import { registerBlastRadiusPaths } from "./paths/blast-radius";
import { registerSearchPaths } from "./paths/search";
import { registerConnectPaths } from "./paths/connect";
import { registerStorageUploadPaths } from "./paths/storage-upload";
import { registerSftpUploadPaths } from "./paths/sftp-upload";
import { registerAppsPaths } from "./paths/apps";
import { registerSshKeyPaths } from "./paths/ssh-keys";
import { registerSshTunnelPaths } from "./paths/ssh-tunnels";
import { registerSshFanoutPaths } from "./paths/ssh-fanout";
import { registerBastionPaths } from "./paths/bastions";
import { registerAgentPaths } from "./paths/agents";
import { registerTeamPaths } from "./paths/team";
import { registerBillingPaths } from "./paths/billing";
import { registerAuditPaths } from "./paths/audit";
import { registerApiKeyPaths } from "./paths/api-keys";
import { registerAgentAuthPaths } from "./paths/agent-auth";
import { registerWsTokenPaths } from "./paths/ws-token";
import { registerSyncPaths } from "./paths/sync";
import { registerWebhookPaths } from "./paths/webhooks";
import { registerAdminPaths } from "./paths/admin";
import { registerPushPaths } from "./paths/push";
import { registerAlertRulePaths } from "./paths/alert-rules";
import { registerAlertEmailPaths } from "./paths/alert-email";
import { registerSlackPaths } from "./paths/slack";
import { registerMsTeamsPaths } from "./paths/msteams";
import { registerJiraPaths } from "./paths/jira";
import { registerLinearPaths } from "./paths/linear";
import { registerGithubIssuesPaths } from "./paths/github-issues";
import { registerDigestPaths } from "./paths/digest";
import { REQUIRED_PERMISSION, normalizePathForPermissionLookup } from "./required-permissions";

interface BuildOptions {
  /** Server URL(s) to advertise in the spec. */
  servers?: Array<{ url: string; description?: string }>;
  /** Override the spec version (defaults to `API_VERSION`). */
  version?: string;
}

/**
 * Servers to advertise when the caller doesn't specify. A deployment knows its
 * own origin (`APP_URL` / `PUBLIC_BASE_URL`, set in prod), so serve that alone,
 * otherwise Scalar picks the first entry and every "try it" request and code
 * snippet on the production docs points at `localhost:3000`.
 */
function defaultServers(): Array<{ url: string; description?: string }> {
  const explicit = process.env["PUBLIC_BASE_URL"] ?? process.env["APP_URL"];
  if (explicit) return [{ url: explicit.replace(/\/$/, ""), description: "This deployment" }];
  return [{ url: "http://localhost:3000", description: "Local dev" }];
}

export async function buildOpenApiDocument(opts: BuildOptions = {}): Promise<OpenAPIObject> {
  const registry = new OpenAPIRegistry();

  registry.registerComponent("securitySchemes", "sessionCookie", {
    type: "apiKey",
    in: "cookie",
    name: "wos-session",
    description:
      "WorkOS-issued sealed session cookie (httpOnly, set by `/callback`). Used by browser clients.",
  });
  registry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
    bearerFormat: "JWT",
    description: "WorkOS access token (JWT) or Infrawrench API key. Used by programmatic clients.",
  });

  const enums = await buildDynamicEnums();
  const ctx: BuildContext = { registry, enums };

  registerAuthPaths(ctx);
  registerProfilePaths(ctx);
  registerOrgPaths(ctx);
  registerInvitationPaths(ctx);
  registerAccountPaths(ctx);
  registerDashboardPaths(ctx);
  registerCostPaths(ctx);
  registerCostAnomalyFeedbackPaths(ctx);
  registerCostReportPaths(ctx);
  registerCostCanvasPaths(ctx);
  registerCostReportNotificationPaths(ctx);
  registerDashboardNotificationPaths(ctx);
  registerCostReportFolderPaths(ctx);
  registerCostAnnotationPaths(ctx);
  registerCostExportPaths(ctx);
  registerCostAlertPaths(ctx);
  registerSavedFilterPaths(ctx);
  registerCostScenarioPaths(ctx);
  registerBusinessMetricPaths(ctx);
  registerOrphanPaths(ctx);
  registerRightsizingPaths(ctx);
  registerExtendedSupportPaths(ctx);
  registerBudgetPaths(ctx);
  registerMetricAlertPaths(ctx);
  registerChangeFreezePaths(ctx);
  registerTagPolicyPaths(ctx);
  registerTagKeyPaths(ctx);
  registerCurrencyPaths(ctx);
  registerCostCentrePaths(ctx);
  registerCustomCostSourcePaths(ctx);
  registerBillingRulePaths(ctx);
  registerVirtualTagPaths(ctx);
  registerInvoicePaths(ctx);
  registerCustomGraphPaths(ctx);
  registerOrgConfigPaths(ctx);
  registerWorkflowApprovalPaths(ctx);
  registerWorkflowPaths(ctx);
  registerWorkflowSecretPaths(ctx);
  registerChatPaths(ctx);
  registerDeploymentPaths(ctx);
  registerPagePaths(ctx);
  registerResourcePaths(ctx);
  registerResourceChangePaths(ctx);
  registerChangeCostImpactPaths(ctx);
  registerStatusIncidentPaths(ctx);
  registerExpiringPaths(ctx);
  registerQuotaPaths(ctx);
  registerPosturePaths(ctx);
  registerAccessReviewPaths(ctx);
  registerBackupPaths(ctx);
  registerWallboardPaths(ctx);
  registerCalendarPaths(ctx);
  registerRunbookPaths(ctx);
  registerOnCallPaths(ctx);
  registerPagingProviderPaths(ctx);
  registerQueryMonitorPaths(ctx);
  registerCarbonPaths(ctx);
  registerPriceCatalogPaths(ctx);
  registerDnsPaths(ctx);
  registerEnvironmentDiffPaths(ctx);
  registerMomentPaths(ctx);
  registerSchedulePaths(ctx);
  registerLeasePaths(ctx);
  registerEnvironmentPaths(ctx);
  registerSessionRecordingPaths(ctx);
  registerSharedConsolePaths(ctx);
  registerAccessRequestPaths(ctx);
  registerJitAccessPaths(ctx);
  registerCredentialHygienePaths(ctx);
  registerCreditPaths(ctx);
  registerCostVisibilityPaths(ctx);
  registerCommitmentPaths(ctx);
  registerSavingsPaths(ctx);
  registerNetworkFlowPaths(ctx);
  registerAiAttributionPaths(ctx);
  registerProbePaths(ctx);
  registerSloPaths(ctx);
  registerIncidentPaths(ctx);
  registerStatusPagePaths(ctx);
  registerOwnershipPaths(ctx);
  registerIacPaths(ctx);
  registerLogWorkspacePaths(ctx);
  registerConnectionFeaturePaths(ctx);
  registerAssociationPaths(ctx);
  registerDependencyGraphPaths(ctx);
  registerBlastRadiusPaths(ctx);
  registerSearchPaths(ctx);
  registerConnectPaths(ctx);
  registerStorageUploadPaths(ctx);
  registerSftpUploadPaths(ctx);
  registerAppsPaths(ctx);
  registerSshKeyPaths(ctx);
  registerSshTunnelPaths(ctx);
  registerSshFanoutPaths(ctx);
  registerBastionPaths(ctx);
  registerAgentPaths(ctx);
  registerTeamPaths(ctx);
  registerBillingPaths(ctx);
  registerAuditPaths(ctx);
  registerApiKeyPaths(ctx);
  registerAgentAuthPaths(ctx);
  registerWsTokenPaths(ctx);
  registerSyncPaths(ctx);
  registerWebhookPaths(ctx);
  registerAdminPaths(ctx);
  registerPushPaths(ctx);
  registerAlertRulePaths(ctx);
  registerAlertEmailPaths(ctx);
  registerSlackPaths(ctx);
  registerMsTeamsPaths(ctx);
  registerJiraPaths(ctx);
  registerLinearPaths(ctx);
  registerGithubIssuesPaths(ctx);
  registerDigestPaths(ctx);

  const generator = new OpenApiGeneratorV31(registry.definitions);

  const doc = generator.generateDocument({
    openapi: "3.1.0",
    info: {
      title: "Infrawrench API",
      version: opts.version ?? API_VERSION,
      description:
        "REST API for the Infrawrench cloud SaaS. Plugin and resource type IDs are enumerated from the live plugin registry at spec-build time, so this document always matches what the running server actually accepts.",
      license: { name: "BUSL-1.1", url: "https://mariadb.com/bsl11/" },
    },
    servers: opts.servers ?? defaultServers(),
    security: [{ sessionCookie: [] }, { bearerAuth: [] }],
    tags: [
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
        name: "Cost canvases",
        description:
          "Reports built from a plain-language description by the chat agent: a saved, " +
          "strictly validated spec of KPI tiles, charts, tables, budgets, anomalies and short " +
          "narrative. The spec stores queries, not numbers, so running a canvas re-executes " +
          "them with no model call; edits proposed in chat are approved against a diff.",
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
    ],
  });

  injectOperationIds(doc);
  injectRequiredPermissions(doc);
  injectInternalMarkers(doc);
  return doc;
}

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "options", "head"] as const;

/**
 * Auto-derive `operationId` from method + path so generated SDKs have stable
 * function names. e.g. `POST /api/org/{orgId}/sql/query` → `postOrgSqlQuery`.
 */
function injectOperationIds(doc: { paths?: Record<string, unknown> }) {
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    if (!item || typeof item !== "object") continue;
    const pathItem = item as Record<string, { operationId?: string }>;
    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op || op.operationId) continue;
      op.operationId = deriveOperationId(method, path);
    }
  }
}

function injectRequiredPermissions(doc: { paths?: Record<string, unknown> }) {
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    if (!item || typeof item !== "object") continue;
    const pathItem = item as Record<string, Record<string, unknown> | undefined>;
    const lookupPath = normalizePathForPermissionLookup(path);
    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op) continue;
      const key = `${method.toUpperCase()} ${lookupPath}`;
      if (!(key in REQUIRED_PERMISSION)) continue;
      const required = REQUIRED_PERMISSION[key];
      if (required === null || required === undefined) continue;
      op["x-required-permission"] = required;
      const existingDesc = typeof op["description"] === "string" ? op["description"] : "";
      const note = `_Requires permission: \`${required}\`._`;
      op["description"] = existingDesc ? `${existingDesc}\n\n${note}` : note;
    }
  }
}

function deriveOperationId(method: string, path: string): string {
  const segments = path
    .replace(/^\/api\//, "")
    .replace(/^v1\//, "v1-")
    .split("/")
    .filter(Boolean)
    .map((seg) => seg.replace(/[{}]/g, ""))
    .map((seg, i) => {
      const camel = seg.replace(/[-_](.)/g, (_, c: string) => c.toUpperCase());
      return i === 0 ? camel : camel.charAt(0).toUpperCase() + camel.slice(1);
    });
  return method + segments.map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join("");
}

/** Cached documents; safe to call repeatedly from request handlers. */
let _cached: OpenAPIObject | null = null;
let _cachedPublic: OpenAPIObject | null = null;

/** The full spec, internal routes included. Used by `generate:openapi`. */
async function getOpenApiDocument(opts: BuildOptions = {}): Promise<OpenAPIObject> {
  if (_cached) return _cached;
  _cached = await buildOpenApiDocument(opts);
  return _cached;
}

/**
 * The spec we publish: the same document with `x-internal` operations, the
 * `sessionCookie` scheme, and the tags/schemas only they used removed. This is
 * what `/openapi.json` serves and what `/docs` renders. See `./public-spec.ts`.
 *
 * Every published operation additionally carries `x-codeSamples` showing the
 * call as each generated SDK spells it, so the `/docs` client picker offers
 * the real clients instead of only generic HTTP snippets. The samples are
 * derived from the same IR the SDK generator consumes (which is why this
 * reaches into `scripts/sdk`); they exist only on the served document: the
 * committed `openapi.json` stays snippet-free so its diffs show surface
 * changes.
 */
export async function getPublicOpenApiDocument(opts: BuildOptions = {}): Promise<OpenAPIObject> {
  if (_cachedPublic) return _cachedPublic;
  const doc = toPublicDocument(await getOpenApiDocument(opts));
  injectSdkCodeSamples(doc);
  _cachedPublic = doc;
  return _cachedPublic;
}
