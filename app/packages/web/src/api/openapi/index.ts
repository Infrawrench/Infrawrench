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
import { registerOrphanPaths } from "./paths/orphans";
import { registerEnvironmentDiffPaths } from "./paths/environment-diff";
import { registerRightsizingPaths } from "./paths/rightsizing";
import { registerBudgetPaths } from "./paths/budgets";
import { registerMetricAlertPaths } from "./paths/metric-alerts";
import { registerChangeFreezePaths } from "./paths/change-freezes";
import { registerTagPolicyPaths } from "./paths/tag-policy";
import { registerCostCentrePaths } from "./paths/cost-centres";
import { registerCustomGraphPaths } from "./paths/custom-graphs";
import { registerOrgConfigPaths } from "./paths/org-config";
import { registerWorkflowApprovalPaths } from "./paths/workflow-approvals";
import { registerWorkflowPaths } from "./paths/workflows";
import { registerDeploymentPaths } from "./paths/deployments";
import { registerPagePaths } from "./paths/pages";
import { registerResourcePaths } from "./paths/resources";
import { registerResourceChangePaths } from "./paths/resource-changes";
import { registerStatusIncidentPaths } from "./paths/status-incidents";
import { registerExpiringPaths } from "./paths/expiring";
import { registerPosturePaths } from "./paths/posture";
import { registerDnsPaths } from "./paths/dns";
import { registerMomentPaths } from "./paths/moment";
import { registerSchedulePaths } from "./paths/schedules";
import { registerLeasePaths } from "./paths/leases";
import { registerSessionRecordingPaths } from "./paths/session-recordings";
import { registerAccessRequestPaths } from "./paths/access-requests";
import { registerCredentialHygienePaths } from "./paths/credential-hygiene";
import { registerCreditPaths } from "./paths/credits";
import { registerProbePaths } from "./paths/probes";
import { registerStatusPagePaths } from "./paths/status-pages";
import { registerOwnershipPaths } from "./paths/ownership";
import { registerLogWorkspacePaths } from "./paths/log-workspaces";
import { registerConnectionFeaturePaths } from "./paths/connection-features";
import { registerAssociationPaths } from "./paths/associations";
import { registerDependencyGraphPaths } from "./paths/dependency-graph";
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
import { registerWsTokenPaths } from "./paths/ws-token";
import { registerSyncPaths } from "./paths/sync";
import { registerWebhookPaths } from "./paths/webhooks";
import { registerAdminPaths } from "./paths/admin";
import { registerPushPaths } from "./paths/push";
import { registerAlertRulePaths } from "./paths/alert-rules";
import { registerSlackPaths } from "./paths/slack";
import { registerMsTeamsPaths } from "./paths/msteams";
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
  registerOrphanPaths(ctx);
  registerRightsizingPaths(ctx);
  registerBudgetPaths(ctx);
  registerMetricAlertPaths(ctx);
  registerChangeFreezePaths(ctx);
  registerTagPolicyPaths(ctx);
  registerCostCentrePaths(ctx);
  registerCustomGraphPaths(ctx);
  registerOrgConfigPaths(ctx);
  registerWorkflowApprovalPaths(ctx);
  registerWorkflowPaths(ctx);
  registerDeploymentPaths(ctx);
  registerPagePaths(ctx);
  registerResourcePaths(ctx);
  registerResourceChangePaths(ctx);
  registerStatusIncidentPaths(ctx);
  registerExpiringPaths(ctx);
  registerPosturePaths(ctx);
  registerDnsPaths(ctx);
  registerEnvironmentDiffPaths(ctx);
  registerMomentPaths(ctx);
  registerSchedulePaths(ctx);
  registerLeasePaths(ctx);
  registerSessionRecordingPaths(ctx);
  registerAccessRequestPaths(ctx);
  registerCredentialHygienePaths(ctx);
  registerCreditPaths(ctx);
  registerProbePaths(ctx);
  registerStatusPagePaths(ctx);
  registerOwnershipPaths(ctx);
  registerLogWorkspacePaths(ctx);
  registerConnectionFeaturePaths(ctx);
  registerAssociationPaths(ctx);
  registerDependencyGraphPaths(ctx);
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
  registerWsTokenPaths(ctx);
  registerSyncPaths(ctx);
  registerWebhookPaths(ctx);
  registerAdminPaths(ctx);
  registerPushPaths(ctx);
  registerAlertRulePaths(ctx);
  registerSlackPaths(ctx);
  registerMsTeamsPaths(ctx);
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
        name: "Workflows",
        description:
          "Workflow (runbook) surface exposed over HTTP — the approval requests " +
          "raised by infra.waitForApproval(...) inside runs, and the cron-schedule " +
          "sub-resource. Full workflow CRUD is managed in the app.",
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
        name: "Synthetic probes",
        description:
          "HTTP uptime/latency checks run on an interval from an edge proxy outside the cluster; results land in the shared metric store and alert after N consecutive failures.",
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
      { name: "API keys", description: "Programmatic access tokens." },
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
  "GET /accounts/{id}/detail": "accounts:read",
  "POST /accounts/{id}/sync-type/{typeId}": "resources:read",
  // deployments
  "GET /deployments/repos": "deployments:read",
  "POST /deployments/envs": "deployments:read",
  "POST /deployments/plan": "deployments:plan",
  "GET /deployments/runs": "deployments:read",
  "GET /deployments/runs/{id}": "deployments:read",
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
  // workflows (share the dashboards permissions, like custom graphs)
  "GET /workflows/{id}/schedule": "dashboards:read",
  "PUT /workflows/{id}/schedule": "dashboards:write",
  "DELETE /workflows/{id}/schedule": "dashboards:write",
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
  "GET /posture": "resources:read",
  "POST /posture/dismissals": "resources:write",
  "DELETE /posture/dismissals": "resources:write",
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
  "GET /credential-hygiene": "audit:read",
  "GET /access-requests": "access:read",
  "GET /access-requests/catalog": "access:read",
  "POST /access-requests": "access:request",
  "POST /access-requests/{requestId}/approve": "access:approve",
  "POST /access-requests/{requestId}/deny": "access:approve",
  "POST /access-requests/{requestId}/withdraw": "access:request",
  "GET /session-recordings": "session-recordings:read",
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
  // cost centres & allocation rules
  "GET /cost-centres": "costs:read",
  "POST /cost-centres": "costs:write",
  "PUT /cost-centres/{id}": "costs:write",
  "DELETE /cost-centres/{id}": "costs:write",
  "GET /cost-centres/rules": "costs:read",
  "POST /cost-centres/rules": "costs:write",
  "POST /cost-centres/rules/swap": "costs:write",
  "PUT /cost-centres/rules/{id}": "costs:write",
  "DELETE /cost-centres/rules/{id}": "costs:write",
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
  "POST /costs/rows": "costs:write",
  // pages
  "POST /pages": "pages:write",
  "DELETE /pages": "pages:write",
  // associations
  "POST /associations": "secrets:write",
  "POST /associations/literal": "secrets:write",
  "GET /dependency-graph": "resources:read",
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
export async function getOpenApiDocument(opts: BuildOptions = {}): Promise<OpenAPIObject> {
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
