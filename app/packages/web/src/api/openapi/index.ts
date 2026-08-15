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
import { registerCostReportPaths } from "./paths/cost-reports";
import { registerCostReportNotificationPaths } from "./paths/cost-report-notifications";
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
import { registerBudgetPaths } from "./paths/budgets";
import { registerMetricAlertPaths } from "./paths/metric-alerts";
import { registerChangeFreezePaths } from "./paths/change-freezes";
import { registerTagPolicyPaths } from "./paths/tag-policy";
import { registerCurrencyPaths } from "./paths/currency";
import { registerCostCentrePaths } from "./paths/cost-centres";
import { registerBillingRulePaths } from "./paths/billing-rules";
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
import { registerDnsPaths } from "./paths/dns";
import { registerMomentPaths } from "./paths/moment";
import { registerSchedulePaths } from "./paths/schedules";
import { registerLeasePaths } from "./paths/leases";
import { registerEnvironmentPaths } from "./paths/environments";
import { registerSessionRecordingPaths } from "./paths/session-recordings";
import { registerSharedConsolePaths } from "./paths/shared-consoles";
import { registerAccessRequestPaths } from "./paths/access-requests";
import { registerCredentialHygienePaths } from "./paths/credential-hygiene";
import { registerCreditPaths } from "./paths/credits";
import { registerCommitmentPaths } from "./paths/commitments";
import { registerNetworkFlowPaths } from "./paths/network-flows";
import { registerProbePaths } from "./paths/probes";
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
import { registerSlackPaths } from "./paths/slack";
import { registerMsTeamsPaths } from "./paths/msteams";
import { registerJiraPaths } from "./paths/jira";
import { registerLinearPaths } from "./paths/linear";
import { registerDigestPaths } from "./paths/digest";

interface BuildOptions {
  /** Server URL(s) to advertise in the spec. */
  servers?: Array<{ url: string; description?: string }>;
  /** Override the spec version (defaults to `API_VERSION`). */
  version?: string;
}

/**
 * Servers to advertise when the caller doesn't specify. A deployment knows its
 * own origin (`APP_URL` / `PUBLIC_BASE_URL`, set in prod), so serve that alone —
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
  registerCostReportPaths(ctx);
  registerCostReportNotificationPaths(ctx);
  registerCostReportFolderPaths(ctx);
  registerCostAnnotationPaths(ctx);
  registerCostExportPaths(ctx);
  registerCostAlertPaths(ctx);
  registerSavedFilterPaths(ctx);
  registerCostScenarioPaths(ctx);
  registerBusinessMetricPaths(ctx);
  registerOrphanPaths(ctx);
  registerRightsizingPaths(ctx);
  registerBudgetPaths(ctx);
  registerMetricAlertPaths(ctx);
  registerChangeFreezePaths(ctx);
  registerTagPolicyPaths(ctx);
  registerCurrencyPaths(ctx);
  registerCostCentrePaths(ctx);
  registerBillingRulePaths(ctx);
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
  registerDnsPaths(ctx);
  registerEnvironmentDiffPaths(ctx);
  registerMomentPaths(ctx);
  registerSchedulePaths(ctx);
  registerLeasePaths(ctx);
  registerEnvironmentPaths(ctx);
  registerSessionRecordingPaths(ctx);
  registerSharedConsolePaths(ctx);
  registerAccessRequestPaths(ctx);
  registerCredentialHygienePaths(ctx);
  registerCreditPaths(ctx);
  registerCommitmentPaths(ctx);
  registerNetworkFlowPaths(ctx);
  registerProbePaths(ctx);
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
  registerSlackPaths(ctx);
  registerMsTeamsPaths(ctx);
  registerJiraPaths(ctx);
  registerLinearPaths(ctx);
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
          "dimension, plus pushed rows for systems without a plugin. Totals are net — credits, " +
          "refunds and tax included — unless a charge-type filter narrows them.",
      },
      {
        name: "Commitments",
        description:
          "Reserved instances, savings plans and committed-use discounts: the inventory of what " +
          "was purchased, how much of the usage bill it covers (reported as a range — there is " +
          "no single honest denominator), utilization measured only over days with collected " +
          "cost data, and a planner that recommends commitment sizes at the p10 floor of " +
          "uncovered spend. Read-only: nothing here ever purchases.",
      },
      {
        name: "Network flows",
        description:
          "Priced source\u2192destination attribution of egress and cross-zone traffic \u2014 which two " +
          "things are talking, across which billing boundary, and what that costs. It exists " +
          "because every cost dimension describes one side of a transfer while a network charge " +
          "describes a pair, so the total is visible in the cost surface and the cause is not. " +
          "Everything here is an estimate: flow logs sample, and prices are published list " +
          "rates with no free tier, volume tier or negotiated discount applied. Collection is " +
          "off until an organization enables it, because the queries are billed to the " +
          "customer's own cloud account.",
      },
      {
        name: "Cost reports",
        description:
          "Named, addressable saved cost graphs. A report owns its config as an org object, so " +
          "dashboards can reference it by id (the `cost_report` widget kind) and it can be run " +
          "by id without the caller reassembling the query.",
      },
      {
        name: "Cost annotations",
        description:
          'Dated notes drawn over cost charts — "we migrated to Graviton here". A note carries ' +
          "a start day and an optional end day, because a deploy is a moment and a migration is " +
          "a week. With no report id it is org-wide and appears on every cost chart; with one it " +
          "belongs to that report alone. Annotations are an overlay: they never change a series, " +
          "a total, or an axis.",
      },
      {
        name: "Scenario models",
        description:
          "Named, reusable sets of adjustments overlaid on a cost forecast. A trend fit can " +
          "only extrapolate what already happened; a scenario is where an organization writes " +
          "down what it already knows is coming — a purchase next quarter, a team starting in " +
          "September, a migration that takes a fifth off compute. Applying one never replaces " +
          "the trend: the query returns both, the adjusted line is labelled with the model's " +
          "name, and recorded history is never touched. Budgets opt in per budget, never " +
          "globally, so a hypothesis cannot silently change when people get paged.",
      },
      {
        name: "Billing Rules",
        description:
          "The organization's own adjustments to collected spend: a markup that recovers " +
          "shared overhead, a discount negotiated outside the provider's pricing, a fixed " +
          "charge per period, or a reallocation that moves a shared cluster's cost onto the " +
          "teams that use it.\n\n" +
          "Adjustments are applied **at query time and never written into stored cost data**, " +
          "so collected spend remains exactly what the provider reported and can still be " +
          "reconciled against an invoice. Every adjusted answer carries the collected totals " +
          "beside the adjusted ones and names the rules that moved them, so an adjusted figure " +
          "can never be read without knowing it is adjusted. Anything that pages a human " +
          "(budgets, anomaly detection, change alerts, the digest) measures collected spend " +
          "unless it opts in per object; cost exports are always raw, because they are the " +
          "audit trail.\n\n" +
          "Percentage rules compose — two 10% markups are 21%, not 20% — while reallocation is " +
          "first-match-wins, so a row moves exactly once and total spend is conserved.",
      },
      {
        name: "Business metrics",
        description:
          "The denominators unit costs divide by — customers, requests, GB processed, revenue — " +
          "reported by the organization itself, plus the query that divides spend by them. A " +
          "unit cost is computed at the bucket asked for from a summed numerator and a summed " +
          "denominator (a daily ratio averaged over a month is not the monthly ratio), a period " +
          "with no reported value comes back as an explicit gap rather than as zero, and " +
          "currencies are never merged. Margin is offered only for a metric declared " +
          "revenue-shaped, in its own currency.",
      },
      {
        name: "Cost alerts",
        description:
          "Change-based cost alerts: fire when spend on a chosen scope moves more than a " +
          "configured percent and/or amount versus the prior period, on a daily, weekly or " +
          "monthly cadence. The third alert family — budgets watch an absolute monthly total, " +
          "anomaly detection watches statistical outliers against a learned baseline, and these " +
          "watch a configured relative change.",
      },
      {
        name: "Cost exports",
        description:
          "Recurring dumps of raw cost rows into a warehouse or object store. A run streams " +
          "the org's cost rows out of storage and writes one object per period at a " +
          "deterministic key, to S3-compatible storage or an HTTPS endpoint. Because provider " +
          "spend is restated for days after the fact, every run also re-writes the periods " +
          "inside a trailing restatement window and stamps each row with the collection " +
          "watermark, so a consumer can tell a settled period from a still-moving one.",
      },
      {
        name: "Workflows",
        description:
          "Workflow (runbook) surface exposed over HTTP — the approval requests " +
          "raised by infra.waitForApproval(...) inside runs, and the cron-schedule " +
          "sub-resource. Full workflow CRUD is managed in the app.",
      },
      {
        name: "Chat",
        description:
          "Hosted AI chat — conversation CRUD, the SSE agent stream, pending-action " +
          "approval, secure secret handoff, and structured answers to agent questions.",
      },
      {
        name: "Resources",
        description: "CRUD, manifest, logs, secrets, metrics — all dispatched to plugins.",
      },
      {
        name: "Changes",
        description:
          "Change timeline / drift feed — resources that appeared, changed, or disappeared between polls.",
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
          "Cross-provider DNS inventory — every synced zone and record, with dangling targets flagged as subdomain-takeover candidates.",
      },
      {
        name: "Sleep schedules",
        description:
          "Off-at/on-at weekly windows on resources whose plugin declares lifecycle start/stop actions; the poller executes due transitions server-side.",
      },
      {
        name: "Resource leases",
        description:
          "Optional TTLs on resources ('a test cluster for 3 days'). Active leases ride the expiry radar; auto-delete leases are announced twice and then deleted at expiry by the poller, deferring during change freezes.",
      },
      {
        name: "Ephemeral environments",
        description:
          "Capture a set of existing resources as a parameterised template built from each plugin's own create-field metadata, stamp copies of it out in dependency order with a mandatory TTL, and tear them down. Expiry runs through the existing resource-lease pass, so every copy deletes itself.",
      },
      {
        name: "Credit burndown",
        description:
          "Prepaid credit balances with a burn rate measured from the server's own series of readings and a runway bounded by both the burn and the credit's own expiry. Only providers that expose a balance appear; most bill in arrears and have no pot to burn down.",
      },
      {
        name: "Credential hygiene",
        description:
          "Unused API keys, unreferenced SSH keys, and members holding write permissions they never exercise — derived from the audit log and the credential tables, with no provider call. Only writes are audit-logged, so the report deliberately draws no conclusion about read permissions.",
      },
      {
        name: "Break-glass access",
        description:
          "Time-boxed permission elevation: ask for specific permissions for a specific number of minutes with a reason, someone else approves, the elevation lapses on its own. Grants are unioned into the requester's permissions at resolution time, so they reach every surface at once — and are deliberately excluded from API keys, which are not people.",
      },
      {
        name: "Session recordings",
        description:
          "Replayable asciicasts of SSH sessions opened through the cloud. Cloud SSH is already proxied server-side, so recording tees a stream the server holds rather than needing an agent on the host; casts download in asciinema's own format. Opt-in per organization, retained on a per-organization window.",
      },
      {
        name: "Shared consoles",
        description:
          "Pair-on-prod: fan a live cloud SSH session out to invited colleagues, with exactly one of them holding the keyboard. The invite link is a locator, never a capability — joining needs live org membership and the same `resources:execute` a direct terminal to that resource needs, re-derived on join, on attach and on a sweep while attached. Every join, leave, role change, handover and revocation is audit-logged, and participants are attributed in the session recording's metadata and on its timeline.",
      },
      {
        name: "Synthetic probes",
        description:
          "HTTP uptime/latency checks run on an interval from an edge proxy outside the cluster; results land in the shared metric store and alert after N consecutive failures.",
      },
      {
        name: "Quota radar",
        description:
          "How close each account is to the limits its provider enforces, with the trend fitted over recent readings. Both halves of every row come from the provider — nothing is filled in from published defaults, because an account with an approved increase would otherwise read as exhausted while it has headroom. A provider with no quota API contributes nothing rather than zero.",
      },
      {
        name: "Incidents",
        description:
          "Incidents the organization declares itself \u2014 not to be confused with the provider status incidents under Resources, which are somebody else's outage. Declaring records the incident and, optionally, opens a change freeze, pins the moment, announces through the org's alert routing rules and posts a public status-page update; each side effect is recorded as an artefact whose failure is stored rather than thrown, so nothing an integration does can lose the declaration. The timeline is assembled on read by joining feeds that already exist, and the postmortem export pre-fills everything except the judgement.",
      },
      {
        name: "Status pages",
        description:
          "Public, unauthenticated views of a chosen set of synthetic probes. A page is created unpublished and reachable only via an unguessable slug; the public payload carries labels, states and uptime history — never probe URLs, resource ids or account names.",
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
      { name: "SSH tunnels", description: "Server-side SSH tunnel lifecycle." },
      {
        name: "SSH fan-out",
        description: "Run one command across many SSH hosts, with saved snippets.",
      },
      {
        name: "Bastions",
        description:
          "Per-account egress agents — register a bastion, run the agent container on your infra, and bind accounts to it so cloud control-plane traffic exits from your IP.",
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
          "Ordered alert routing rules — which alerts reach which destinations, with quiet hours and escalation — plus the held and awaiting-acknowledgement delivery queue.",
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
          "failed probe) as a tracked issue.",
      },
      {
        name: "Linear",
        description:
          "Linear workspace connection, team picker, and filing a finding (cost anomaly, " +
          "orphan, oversized resource, posture finding, expiring credential, failed probe) " +
          "as a tracked issue.",
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

/**
 * Map of `METHOD /path-suffix` → required permission, mirroring the
 * `requirePermission` calls in route handlers. Path suffixes are matched
 * against the part of the URL after `/api/org/{orgId}/` (or the matching
 * unscoped prefix for sync/webhooks). Add new entries here when adding new
 * routes — `pnpm --filter @infrawrench/web generate:openapi` will pick them up.
 */
const REQUIRED_PERMISSION: Record<string, string | null> = {
  // accounts
  "GET /accounts/plugins": "accounts:read",
  "GET /accounts/plugins/{pluginId}/policy-template": "accounts:read",
  "POST /accounts/preflight": "accounts:write",
  "POST /accounts/{id}/preflight": "accounts:write",
  "GET /accounts": "accounts:read",
  "POST /accounts": "accounts:write",
  "DELETE /accounts/{id}": "accounts:delete",
  "PATCH /accounts/{id}": "accounts:write",
  "GET /accounts/{id}/credentials": "secrets:read",
  "PUT /accounts/{id}/credentials": "secrets:write",
  "GET /accounts/{id}/resources": "resources:read",
  "POST /accounts/{id}/sync": "resources:read",
  "GET /accounts/{id}/export-terraform": "resources:read",
  "GET /accounts/{id}/detail": "accounts:read",
  "POST /accounts/{id}/sync-type/{typeId}": "resources:read",
  // deployments
  "GET /deployments/repos": "deployments:read",
  "POST /deployments/envs": "deployments:read",
  "POST /deployments/plan": "deployments:plan",
  "GET /deployments/runs": "deployments:read",
  "GET /deployments/runs/{id}": "deployments:read",
  // cost per deploy — same rule as the change feed's: deployments:read for the
  // run, costs:read for the spend it moved.
  "GET /deployments/runs/{id}/cost-impact": "costs:read",
  "POST /deployments/runs": "deployments:write",
  "POST /deployments/runs/{id}/rollback": "deployments:write",
  "GET /deployments/triggers": "deployments:read",
  "POST /deployments/triggers": "deployments:write",
  "PATCH /deployments/triggers/{id}": "deployments:write",
  "DELETE /deployments/triggers/{id}": "deployments:write",
  // dashboards
  "GET /dashboards": "dashboards:read",
  "POST /dashboards": "dashboards:write",
  "GET /dashboards/{id}": "dashboards:read",
  "GET /dashboards/default/full": "dashboards:read",
  "POST /dashboards/{id}/rename": "dashboards:write",
  "DELETE /dashboards/{id}": "dashboards:write",
  "POST /dashboards/pin": "dashboards:write",
  "POST /dashboards/{id}/reorder": "dashboards:write",
  "POST /dashboards/unpin": "dashboards:write",
  "POST /dashboards/validate-tabs": "dashboards:read",
  "GET /dashboards/pin/{pinId}": "dashboards:read",
  "POST /dashboards/probe": "dashboards:read",

  // workflow approvals — listing rides on the same permission as the Workflows
  // tab; deciding is its own trust level (see routes/workflow-approvals.ts).
  "GET /workflow-approvals": "workflows:read",
  "POST /workflow-approvals/{id}/approve": "workflows:approve",
  "POST /workflow-approvals/{id}/deny": "workflows:approve",
  // custom graphs — genuinely dashboard content, so they keep the dashboards
  // permissions the workflows routes have moved off.
  "GET /custom-graphs": "dashboards:read",
  "POST /custom-graphs": "dashboards:write",
  "GET /custom-graphs/typings": "dashboards:read",
  "POST /custom-graphs/check": "dashboards:read",
  "GET /custom-graphs/{id}": "dashboards:read",
  "PUT /custom-graphs/{id}": "dashboards:write",
  "DELETE /custom-graphs/{id}": "dashboards:write",
  "POST /custom-graphs/{id}/render": "dashboards:read",
  // workflows — typings rides workflows:read (same as the editor/tool path);
  // the schedule sub-resource still shares the dashboards permissions used when
  // it was documented (CI managing when a UI-created workflow runs).
  "GET /workflows/{id}/typings": "workflows:read",
  "GET /workflows/{id}/secrets": "secrets:read",
  "PUT /workflows/{id}/secrets": "workflows:write",
  "GET /workflows/{id}/schedule": "dashboards:read",
  "PUT /workflows/{id}/schedule": "dashboards:write",
  "DELETE /workflows/{id}/schedule": "dashboards:write",
  "GET /workflow-secrets": "secrets:read",
  "POST /workflow-secrets": "secrets:write",
  "PATCH /workflow-secrets/{id}": "secrets:write",
  "PUT /workflow-secrets/{id}/value": "secrets:write",
  "DELETE /workflow-secrets/{id}": "secrets:write",
  "POST /chat/conversations/{conversationId}/pending/{pendingId}/answer": "chat:write",
  // agents
  "GET /agents/accounts": "accounts:read",
  "GET /agents/settings": "accounts:read",
  "PUT /agents/settings": "accounts:write",
  "GET /agents/sessions": "resources:read",
  "POST /agents/sessions": "resources:write",
  "POST /agents/sessions/{id}/open": "resources:execute",
  "POST /agents/sessions/{id}/reconcile": "resources:execute",
  "DELETE /agents/sessions/{id}": "resources:delete",
  // change timeline
  "GET /changes": "resources:read",
  "GET /changes/resource": "resources:read",
  // cost per change — the response is money, so it takes the cost read scope
  // on top of the resource one the feed itself needs.
  "POST /changes/cost-impacts": "costs:read",
  // provider status correlation — reads the same resource set the incidents
  // are matched against, so it rides the resources read scope
  "GET /status-incidents": "resources:read",
  // expiry radar — the feed is a read over the org's resource set; the alert
  // settings decide what the org's channels hear, the same trust level as the
  // drift alert settings
  "GET /expiring": "resources:read",
  // The moment union spans six read scopes; `resources:read` is the floor —
  // feeds needing more (costs, workflows, deployments, audit, freezes) are
  // omitted per-feed rather than gating the whole endpoint.
  "GET /moment": "resources:read",
  "GET /expiring/settings": "org:settings:write",
  "PUT /expiring/settings": "org:settings:write",
  // quota radar — the feed is a read over already-collected readings; the
  // threshold decides what the org's channels hear, the same trust level as
  // the expiry alert settings next door
  "GET /quotas": "resources:read",
  "GET /quotas/settings": "org:settings:write",
  "PUT /quotas/settings": "org:settings:write",
  "GET /posture": "resources:read",
  "POST /posture/dismissals": "resources:write",
  "DELETE /posture/dismissals": "resources:write",
  // cross-cloud access review — the posture stance exactly: the review and its
  // export are reads over the org's resource set, and accepting a finding is a
  // statement about one resource at the same trust level as changing it. There
  // is no settings route: the findings ride the posture alert window, so
  // /posture/settings is the one switch.
  "GET /access-review": "resources:read",
  "GET /access-review/export": "resources:read",
  "POST /access-review/dismissals": "resources:write",
  "DELETE /access-review/dismissals": "resources:write",
  "GET /dns": "resources:read",
  // Environment diff — pure read over two accounts' already-synced inventories.
  "GET /environment-diff": "resources:read",
  "GET /posture/settings": "org:settings:write",
  "PUT /posture/settings": "org:settings:write",
  // sleep/wake schedules — reads ride the resource read scope (the list is
  // derived from the org's resource set, like orphans); mutations are a
  // standing instruction to invoke the same actions `resources:write` already
  // gates on /resources/invoke-action
  "GET /schedules": "resources:read",
  "POST /schedules": "resources:write",
  "POST /schedules/preview": "resources:read",
  "PUT /schedules/{scheduleId}": "resources:write",
  "DELETE /schedules/{scheduleId}": "resources:write",
  // resource leases — the schedules stance: reads are a view over the org's
  // resource set; mutations are resources:write. Setting autoDelete: true
  // additionally requires resources:delete (checked in the handler — the
  // lease becomes a standing deletion), which this one-permission-per-route
  // map cannot express.
  // ephemeral environments — the leases stance: reads are a view over the org's
  // own resources, template edits are writes, teardown is a delete, and
  // instantiation needs both (every instance carries a standing auto-delete).
  // The TTL ceiling is org settings, not a resource edit.
  "GET /environments/settings": "resources:read",
  "PUT /environments/settings": "org:settings:write",
  "POST /environments/capture": "resources:read",
  "GET /environments/templates": "resources:read",
  "POST /environments/templates": "resources:write",
  "GET /environments/templates/{templateId}": "resources:read",
  "PUT /environments/templates/{templateId}": "resources:write",
  "DELETE /environments/templates/{templateId}": "resources:write",
  "POST /environments/templates/{templateId}/estimate": "resources:read",
  "POST /environments/templates/{templateId}/instantiate": "resources:write",
  "GET /environments/instances": "resources:read",
  "GET /environments/instances/{instanceId}": "resources:read",
  "POST /environments/instances/{instanceId}/teardown": "resources:delete",
  "DELETE /environments/instances/{instanceId}": "resources:write",
  "GET /leases": "resources:read",
  "GET /leases/resource": "resources:read",
  "POST /leases": "resources:write",
  "PUT /leases/{leaseId}": "resources:write",
  "POST /leases/{leaseId}/cancel": "resources:write",
  "DELETE /leases/{leaseId}": "resources:write",
  // session recordings — their own permission family rather than `audit:read`
  // or `ssh-keys:*`: watching a colleague's terminal back is a sharper
  // capability than either, and the people who should hold it (compliance,
  // security) are often not the people who administer keys. Deliberately
  // absent from the `member` system role — recording exists to watch
  // operators, so handing every operator the ability to watch defeats it.
  // break-glass access — three verbs held by genuinely different people.
  // `access:approve` is deliberately not implied by `team:role:write`: granting
  // a role is a considered change, approving an elevation happens mid-incident.
  // `revoke` has no entry because its permission depends on who is calling —
  // the holder may always end their own grant — which this one-permission-per
  // -route map cannot express; the handler owns it.
  // credential hygiene — `audit:read`, not a family of its own. Every fact in
  // the report is already reachable by anyone who can read the audit log, so a
  // separate permission would only mean granting two things to get one view.
  // credit burndown — `costs:read`. A prepaid balance is spend information,
  // and the permission that already governs "what is this costing us" is the
  // one that should govern "how much is left".
  "GET /credits": "costs:read",
  "GET /commitments": "costs:read",
  "GET /network-flows": "costs:read",
  "GET /network-flows/settings": "costs:read",
  // Not `costs:write`: enabling collection spends the organization's money in
  // its own cloud account every day until somebody turns it off, which is a
  // governance act rather than an edit to a cost object.
  "PUT /network-flows/settings": "org:settings:write",
  "GET /credential-hygiene": "audit:read",
  "GET /access-requests": "access:read",
  "GET /access-requests/catalog": "access:read",
  "POST /access-requests": "access:request",
  "POST /access-requests/{requestId}/approve": "access:approve",
  "POST /access-requests/{requestId}/deny": "access:approve",
  "POST /access-requests/{requestId}/withdraw": "access:request",
  "GET /session-recordings": "session-recordings:read",
  // shared consoles — deliberately no permission family of their own. A share
  // hands over no capability the guest did not already hold: joining requires
  // the same `resources:execute` a direct terminal to that resource requires,
  // so the invite link is a locator and never an authorisation. Inventing a
  // `shared-consoles:*` family would imply a share is a lesser thing than a
  // shell, and it is not — a guest can be handed the keyboard.
  "GET /shared-consoles": "resources:execute",
  "POST /shared-consoles": "resources:execute",
  "GET /shared-consoles/invites/{token}": "resources:execute",
  "GET /shared-consoles/{consoleId}": "resources:execute",
  "POST /shared-consoles/{consoleId}/join": "resources:execute",
  "POST /shared-consoles/{consoleId}/handover": "resources:execute",
  "POST /shared-consoles/{consoleId}/request-driver": "resources:execute",
  // The routes that *take access away* — leave, revoke, eject, withdraw an
  // invite — carry no permission on purpose. Gating them on still holding
  // `resources:execute` would lock an owner whose role was narrowed
  // mid-incident out of closing the session they opened. They are gated in the
  // handler instead, on being the sharer or holding `org:settings:write`,
  // which the one-permission-per-route map cannot express (the `leases`
  // autoDelete precedent).
  "POST /shared-consoles/{consoleId}/leave": null,
  "DELETE /shared-consoles/{consoleId}": null,
  "POST /shared-consoles/{consoleId}/invites": null,
  "DELETE /shared-consoles/{consoleId}/invites": null,
  "DELETE /shared-consoles/{consoleId}/participants/{participantId}": null,
  "GET /session-recordings/settings": "session-recordings:read",
  "PUT /session-recordings/settings": "session-recordings:write",
  "GET /session-recordings/{recordingId}": "session-recordings:read",
  "GET /session-recordings/{recordingId}/cast": "session-recordings:read",
  "DELETE /session-recordings/{recordingId}": "session-recordings:write",
  // synthetic probes — the schedules stance: reads (list, suggestions mined
  // from resource outputs, recorded series) ride the resource read scope;
  // mutations are resources:write
  "GET /probes": "resources:read",
  "GET /probes/suggestions": "resources:read",
  "GET /probes/{probeId}/metrics": "resources:read",
  "POST /probes": "resources:write",
  "PUT /probes/{probeId}": "resources:write",
  "DELETE /probes/{probeId}": "resources:write",
  // incident mode — the declared kind. `incidents:write` is held by members
  // as well as admins on purpose (see the permission catalog); what a
  // declaration may *do* keeps its own gates, so requesting a change freeze
  // still needs freezes:write.
  "GET /incidents": "incidents:read",
  "GET /incidents/{incidentId}": "incidents:read",
  "GET /incidents/{incidentId}/timeline": "incidents:read",
  "GET /incidents/{incidentId}/postmortem": "incidents:read",
  "POST /incidents": "incidents:write",
  "PATCH /incidents/{incidentId}": "incidents:write",
  "DELETE /incidents/{incidentId}": "incidents:write",
  "POST /incidents/{incidentId}/retry-artifacts": "incidents:write",
  "POST /incidents/{incidentId}/notes": "incidents:write",
  "DELETE /incidents/{incidentId}/notes/{noteId}": "incidents:write",
  // status pages — a page is a view over probes, so it rides the probe stance:
  // whoever may create the monitoring may decide what of it is public.
  // GET /api/status/{slug} is deliberately absent: it is mounted outside the
  // org tree and takes no credentials at all.
  "GET /status-pages": "resources:read",
  "POST /status-pages": "resources:write",
  "PUT /status-pages/{id}": "resources:write",
  "POST /status-pages/{id}/rotate-slug": "resources:write",
  "DELETE /status-pages/{id}": "resources:write",
  // resource ownership — the leases stance. Note /ownership/members is
  // resources:read, not team:read: the person who can create a resource must
  // be able to say it is theirs.
  "GET /ownership": "resources:read",
  "GET /ownership/members": "resources:read",
  "GET /ownership/resource": "resources:read",
  "PUT /ownership": "resources:write",
  "DELETE /ownership": "resources:write",
  // log workspace saved queries — the schedules stance: reads are a view over
  // the org's resource logs (which resources:read already gates via
  // /resources/{pluginId}/{typeId}/logs); mutations are resources:write
  "GET /log-workspaces": "resources:read",
  "GET /log-workspaces/resources": "resources:read",
  "POST /log-workspaces": "resources:write",
  "PUT /log-workspaces/{queryId}": "resources:write",
  "DELETE /log-workspaces/{queryId}": "resources:write",
  // tag policy & showback — policy is org settings; compliance/untagged ride
  // the resource/cost read scopes their data is computed over
  "GET /tag-policy": "resources:read",
  "PUT /tag-policy": "org:settings:write",
  "GET /tag-policy/compliance": "resources:read",
  "GET /costs/untagged": "costs:read",
  "GET /costs/showback": "costs:read",
  // currency — reads ride costs:read because a converted total is unauditable
  // without the rate that produced it; writes are org:settings:write because
  // stating a rate restates every total the org reports, in digests and in the
  // budget alerts that page people. Finance governance, not a user preference.
  "GET /currency": "costs:read",
  "PUT /currency": "org:settings:write",
  "PUT /currency/rates": "org:settings:write",
  "DELETE /currency/rates/{rateId}": "org:settings:write",
  // cost centres & allocation rules
  // billing rules — the org's own adjustments to collected spend.
  //
  // Reads ride `costs:read` like every other cost surface: a rule is part of
  // the explanation for a number, and hiding it from the people who read the
  // number would make every adjusted figure unauditable.
  //
  // Writes are `org:settings:write`, deliberately **not** `costs:write`.
  // `costs:write` is the "name a report, define a cost centre, save a filter"
  // scope — acts that add a view of the org's spend. A billing rule is not a
  // view: a markup changes what every internal figure in the organisation
  // says, including an opted-in budget's thresholds and the chargeback
  // statements finance sends to other departments. Same reasoning as
  // `PUT /currency` (stating a rate restates every total) and
  // `POST /cost-exports` (standing authorisation to ship the billing history),
  // which puts all three "this changes the org's money story" acts behind one
  // scope.
  "GET /billing-rules": "costs:read",
  "GET /billing-rules/{id}": "costs:read",
  "POST /billing-rules": "org:settings:write",
  "PUT /billing-rules/{id}": "org:settings:write",
  "DELETE /billing-rules/{id}": "org:settings:write",
  // managed accounts & invoices — the managed-service-provider surface.
  //
  // Its own family rather than more `costs:*`. Every other cost surface is the
  // organisation looking at its own spend; a managed account holds a customer's
  // contact details and the price that customer was quoted, which is commercial
  // information about a third party — so reads are `invoices:read`, not
  // `costs:read`.
  //
  // Writes split two ways because generating and issuing are different risks.
  // `invoices:write` prepares (add a customer, raise a draft, edit a period,
  // delete a draft) and is entirely revisable. `invoices:issue` is the
  // irreversible half: approving freezes the numbers a customer will be sent,
  // sending states that they have them, voiding withdraws a document already in
  // their hands. The split is what makes maker-checker expressible — a billing
  // clerk prepares the month, a finance lead issues it.
  //
  // Deliberately not `org:settings:write` (where billing rules and exchange
  // rates ride): those restate the org's own figures once, while raising
  // invoices is monthly operational work that must not require handing someone
  // SSO, seats and the org's whole money story.
  "GET /managed-accounts": "invoices:read",
  "GET /managed-accounts/{id}": "invoices:read",
  "POST /managed-accounts": "invoices:write",
  "PUT /managed-accounts/{id}": "invoices:write",
  "DELETE /managed-accounts/{id}": "invoices:write",
  "GET /invoices": "invoices:read",
  "GET /invoices/{id}": "invoices:read",
  "GET /invoices/{id}/export": "invoices:read",
  "POST /invoices": "invoices:write",
  "PUT /invoices/{id}": "invoices:write",
  "DELETE /invoices/{id}": "invoices:write",
  "POST /invoices/{id}/approve": "invoices:issue",
  "POST /invoices/{id}/send": "invoices:issue",
  "POST /invoices/{id}/void": "invoices:issue",
  "GET /cost-centres": "costs:read",
  "POST /cost-centres": "costs:write",
  "PUT /cost-centres/{id}": "costs:write",
  "DELETE /cost-centres/{id}": "costs:write",
  "GET /cost-centres/rules": "costs:read",
  "POST /cost-centres/rules": "costs:write",
  "POST /cost-centres/rules/swap": "costs:write",
  "PUT /cost-centres/rules/{id}": "costs:write",
  "DELETE /cost-centres/rules/{id}": "costs:write",
  // jira — read covers the redacted connection, the pickers, and the
  // finding→issue links a list view needs; write covers configuring the
  // credential and filing.
  "GET /jira": "jira:read",
  "PUT /jira": "jira:write",
  "DELETE /jira": "jira:write",
  "POST /jira/verify": "jira:write",
  "GET /jira/projects": "jira:read",
  "GET /jira/projects/{key}/issue-types": "jira:read",
  "POST /jira/issues": "jira:write",
  "GET /jira/links": "jira:read",
  // linear — the same split as jira, for the same reasons: read covers the
  // redacted connection, the team picker, and the finding→issue links; write
  // covers configuring the API key and filing.
  "GET /linear": "linear:read",
  "PUT /linear": "linear:write",
  "DELETE /linear": "linear:write",
  "POST /linear/verify": "linear:write",
  "GET /linear/teams": "linear:read",
  "POST /linear/issues": "linear:write",
  "GET /linear/links": "linear:read",
  // resources
  "GET /resources/{pluginId}/{typeId}/detail": "resources:read",
  "GET /resources/{pluginId}/{typeId}/manifest": "resources:read",
  "POST /resources/{pluginId}/{typeId}/manifest": "resources:write",
  "POST /resources/{pluginId}/import-yaml": "resources:write",
  "POST /resources/{pluginId}/{typeId}/describe": "resources:read",
  "POST /resources/{pluginId}/{typeId}/logs": "resources:read",
  "GET /resources/{pluginId}/{typeId}/secret-versions": "secrets:read",
  "POST /resources/{pluginId}/{typeId}/secret-versions/access": "secrets:read",
  "POST /resources/{pluginId}/{typeId}/secret-versions/add": "secrets:write",
  "POST /resources/{pluginId}/{typeId}/secret-versions/modify": "secrets:write",
  "DELETE /resources/{pluginId}/{typeId}": "resources:delete",
  "POST /resources/invoke-action": "resources:write",
  "POST /resources/nosql-command": "resources:execute",
  "POST /resources/attach": "resources:write",
  "POST /resources/{pluginId}/{typeId}/export-credential": "secrets:read",
  "POST /resources/{pluginId}/{typeId}/export-terraform": "resources:read",
  "POST /resources/create": "resources:write",
  "POST /resources/create-config": "resources:write",
  "POST /resources/picker-resources": "resources:read",
  "POST /resources/create-pricing": "resources:read",
  "POST /resources/cost-estimate": "resources:read",
  "POST /resources/{pluginId}/{typeId}/peer-panes": "resources:read",
  "POST /resources/{pluginId}/{typeId}/metrics": "resources:read",
  // costs
  "POST /costs/query": "costs:read",
  "GET /costs/dimensions": "costs:read",
  "GET /costs/status": "costs:read",
  "GET /costs/anomalies": "costs:read",
  "GET /costs/anomaly-settings": "costs:read",
  // Retuning detection changes what the org's whole cost feed alerts on, so it
  // rides the cost write scope rather than the budget one.
  "PUT /costs/anomaly-settings": "costs:write",
  // efficiency alerts — commitment expiry, idle commitments, unit-cost
  // regression. Same split as anomaly settings and for the same reason:
  // reading what fired is cost data, retuning it changes what the org's whole
  // cost feed alerts on.
  "GET /costs/efficiency-alerts": "costs:read",
  "GET /costs/efficiency-alert-settings": "costs:read",
  "PUT /costs/efficiency-alert-settings": "costs:write",
  "POST /costs/rows": "costs:write",
  // cost reports — a report is cost data under a name, so it follows the cost
  // permissions rather than the dashboard ones. Running one is a read.
  "GET /cost-reports": "costs:read",
  "POST /cost-reports": "costs:write",
  "GET /cost-reports/{id}": "costs:read",
  "PUT /cost-reports/{id}": "costs:write",
  "DELETE /cost-reports/{id}": "costs:write",
  "POST /cost-reports/{id}/run": "costs:read",
  // report delivery schedules — reads ride costs:read (mobile shows them
  // read-only), but writes and "send now" are org:settings:write, the
  // cost-exports reasoning: a schedule is standing authorisation to ship org
  // spend to destinations the creator picks, and its email list is
  // arbitrary-address egress. One permission for all writes rather than one
  // per transport, so adding an email address can never be a silent
  // escalation of a costs:write schedule.
  "GET /cost-reports/{id}/notifications": "costs:read",
  "GET /cost-reports/{id}/notifications/targets": "org:settings:write",
  "POST /cost-reports/{id}/notifications": "org:settings:write",
  "PUT /cost-reports/{id}/notifications/{notificationId}": "org:settings:write",
  "DELETE /cost-reports/{id}/notifications/{notificationId}": "org:settings:write",
  "POST /cost-reports/{id}/notifications/{notificationId}/send": "org:settings:write",
  "GET /cost-report-notifications": "costs:read",
  // cost annotations — dated notes drawn over a chart. Reads ride costs:read
  // and writes costs:write, exactly as reports do: a note about spend is cost
  // data with words on it, not dashboard furniture.
  "GET /cost-annotations": "costs:read",
  "POST /cost-annotations": "costs:write",
  "POST /cost-annotations/change-impact": "costs:write",
  "PUT /cost-annotations/{id}": "costs:write",
  "DELETE /cost-annotations/{id}": "costs:write",
  // change-based cost alerts — a cost-scoped alert config, so it rides the
  // cost scopes the way reports do.
  "GET /cost-alerts": "costs:read",
  "POST /cost-alerts": "costs:write",
  "GET /cost-alerts/events": "costs:read",
  "GET /cost-alerts/{id}": "costs:read",
  "PUT /cost-alerts/{id}": "costs:write",
  "DELETE /cost-alerts/{id}": "costs:write",
  // saved cost filters — a named filter is a statement about cost data, so it
  // rides the cost scopes exactly as reports do. DELETE additionally answers
  // 409 while the filter is referenced; that is policy, not permission.
  "GET /saved-cost-filters": "costs:read",
  "POST /saved-cost-filters": "costs:write",
  "GET /saved-cost-filters/{id}": "costs:read",
  "PUT /saved-cost-filters/{id}": "costs:write",
  "DELETE /saved-cost-filters/{id}": "costs:write",
  "GET /saved-cost-filters/{id}/referents": "costs:read",
  "GET /cost-scenarios": "costs:read",
  "POST /cost-scenarios": "costs:write",
  "GET /cost-scenarios/{id}": "costs:read",
  "PUT /cost-scenarios/{id}": "costs:write",
  "DELETE /cost-scenarios/{id}": "costs:write",
  "GET /cost-scenarios/{id}/referents": "costs:read",
  // business metrics — the denominators unit costs divide by. Reads are
  // costs:read and writes costs:write, matching saved filters and the cost
  // push endpoint: a metric is a statement about cost data, not dashboard
  // furniture. The unit-cost query is a POST but computes nothing stored,
  // so it reads.
  "GET /business-metrics": "costs:read",
  "POST /business-metrics": "costs:write",
  "GET /business-metrics/{id}": "costs:read",
  "PUT /business-metrics/{id}": "costs:write",
  "DELETE /business-metrics/{id}": "costs:write",
  "GET /business-metrics/{id}/values": "costs:read",
  "POST /business-metrics/{id}/values": "costs:write",
  "POST /business-metrics/{id}/unit-costs": "costs:read",
  // cost-report folders organize the Reports list and nothing else, so they
  // ride the same scopes the reports do.
  "GET /cost-report-folders": "costs:read",
  "POST /cost-report-folders": "costs:write",
  "PUT /cost-report-folders/{id}": "costs:write",
  "DELETE /cost-report-folders/{id}": "costs:write",
  // cost exports — reads ride costs:read like every other cost surface, but
  // writes are org:settings:write rather than costs:write. Creating an export
  // is standing authorisation to ship the org's whole billing history to a
  // destination the creator chose, on a schedule, forever; costs:write is the
  // "name a report, define a cost centre" scope, not a data-egress one. Same
  // reasoning as PUT /currency. "Run now" is a write for the same reason: it
  // pushes spend out of the product.
  "GET /cost-exports": "costs:read",
  "POST /cost-exports": "org:settings:write",
  "GET /cost-exports/{id}": "costs:read",
  "PUT /cost-exports/{id}": "org:settings:write",
  "DELETE /cost-exports/{id}": "org:settings:write",
  "POST /cost-exports/{id}/run": "org:settings:write",
  // pages
  "POST /pages": "pages:write",
  "DELETE /pages": "pages:write",
  // associations
  "POST /associations": "secrets:write",
  "POST /associations/literal": "secrets:write",
  "GET /dependency-graph": "resources:read",
  "GET /blast-radius": "resources:read",
  // connection-features
  "POST /sql/query": "resources:execute",
  "POST /sql/execute": "resources:execute",
  "POST /sql/estimate": "resources:read",
  "POST /kv/command": "resources:execute",
  "POST /docker/command": "resources:execute",
  "POST /storage/list": "storage:read",
  "POST /storage/mkdir": "storage:write",
  "POST /storage/delete": "storage:write",
  "POST /artifacts/list": "storage:read",
  "POST /sftp/list": "storage:read",
  "POST /sftp/mkdir": "storage:write",
  "POST /sftp/delete": "storage:write",
  // connect
  "POST /connect/templates": "resources:read",
  "POST /connect/secret-export": "resources:write",
  "POST /connect/env-deploy": "resources:execute",
  // storage / sftp uploads & downloads
  "POST /v1/storage/upload": "storage:write",
  "GET /v1/storage/download": "storage:read",
  "POST /v1/sftp/upload": "storage:write",
  "GET /v1/sftp/download": "storage:read",
  // search
  "GET /search": "resources:read",
  // orphans
  "GET /orphans": "resources:read",
  // right-sizing — the list is derived from the org's resource set like
  // orphans; prices are provider catalog rates, not the org's billing data
  "GET /rightsizing": "resources:read",
  // ssh keys
  "GET /ssh-keys": "ssh-keys:read",
  "POST /ssh-keys": "ssh-keys:write",
  "POST /ssh-keys/import": "ssh-keys:write",
  "DELETE /ssh-keys/{id}": "ssh-keys:write",
  // ssh tunnels
  "POST /ssh-tunnels/create-account": "accounts:write",
  // ssh fan-out
  "GET /ssh-fanout/targets": "resources:read",
  "POST /ssh-fanout/run": "resources:execute",
  "GET /ssh-fanout/snippets": "resources:read",
  "POST /ssh-fanout/snippets": "resources:execute",
  "PUT /ssh-fanout/snippets/{id}": "resources:execute",
  "DELETE /ssh-fanout/snippets/{id}": "resources:execute",
  "POST /ssh-tunnels/open": "resources:execute",
  "POST /ssh-tunnels/close": "resources:execute",
  "GET /ssh-tunnels/active": "resources:execute",
  "POST /ssh-tunnels/exec": "resources:execute",
  // bastions
  "GET /bastions": "bastions:read",
  "POST /bastions": "bastions:write",
  "DELETE /bastions/{id}": "bastions:write",
  // ws-token
  "POST /ws-token": "resources:execute",
  // team & roles
  "GET /team/me": null,
  "GET /team/permissions": "team:read",
  "GET /team/roles": "team:read",
  "POST /team/roles": "team:role:write",
  "PATCH /team/roles/{id}": "team:role:write",
  "DELETE /team/roles/{id}": "team:role:write",
  "GET /team/members": "team:read",
  "GET /team/invitations": "team:read",
  "POST /team/invitations": "team:invite",
  "DELETE /team/members/{id}": "team:remove",
  "PATCH /team/members/{id}/role": "team:role:write",
  "DELETE /team/invitations/{id}": "team:invite",
  // billing
  "GET /billing/status": "billing:read",
  "POST /billing/checkout": "billing:write",
  "POST /billing/portal": "billing:write",
  // audit
  "GET /audit-logs": "audit:read",
  // change freezes
  "GET /change-freezes": "freezes:read",
  "GET /change-freezes/status": "freezes:read",
  "POST /change-freezes": "freezes:write",
  "PUT /change-freezes/{id}": "freezes:write",
  "POST /change-freezes/{id}/end": "freezes:write",
  "DELETE /change-freezes/{id}": "freezes:write",
  // api keys
  "POST /api-keys": "apikeys:write",
  "GET /api-keys": "apikeys:read",
  "POST /api-keys/{id}/revoke": "apikeys:write",
  "POST /api-keys/{id}/rotate": "apikeys:write",
  // config as code (each route additionally checks the per-section permission
  // of every section involved — see api/routes/org-config.ts)
  "GET /config/export": "config:read",
  "POST /config/plan": "config:read",
  "POST /config/apply": "config:write",
  // sync (bearer-auth, scopes mirror permissions)
  "POST /v1/sync/pull": "resources:read",
  "POST /v1/sync/push": "resources:write",
  "GET /v1/sync/status": "resources:read",
  // push (device routes are user-scoped; preference/test routes are
  // membership-only self-service — no permission beyond org membership)
  "POST /push/devices": null,
  "GET /push/devices": null,
  "DELETE /push/devices/{id}": null,
  "GET /push/preferences": null,
  "PUT /push/preferences": null,
  "GET /push/recipients": "org:settings:write",
  "POST /push/test": null,
};

/**
 * Strip the org-scoping prefix so the lookup key matches the table above.
 * `/api/org/{orgId}/foo` → `/foo`; `/api/v1/sync/pull` → `/v1/sync/pull`.
 */
function normalizePathForPermissionLookup(path: string): string {
  return path.replace(/^\/api\/org\/\{orgId\}/, "").replace(/^\/api/, "");
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
 * The spec we publish — the same document with `x-internal` operations, the
 * `sessionCookie` scheme, and the tags/schemas only they used removed. This is
 * what `/openapi.json` serves and what `/docs` renders. See `./public-spec.ts`.
 *
 * Every published operation additionally carries `x-codeSamples` showing the
 * call as each generated SDK spells it, so the `/docs` client picker offers
 * the real clients instead of only generic HTTP snippets. The samples are
 * derived from the same IR the SDK generator consumes (which is why this
 * reaches into `scripts/sdk`); they exist only on the served document — the
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
