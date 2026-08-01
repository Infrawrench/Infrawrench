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
import { registerBudgetPaths } from "./paths/budgets";
import { registerChangeFreezePaths } from "./paths/change-freezes";
import { registerTagPolicyPaths } from "./paths/tag-policy";
import { registerCostCentrePaths } from "./paths/cost-centres";
import { registerCustomGraphPaths } from "./paths/custom-graphs";
import { registerWorkflowApprovalPaths } from "./paths/workflow-approvals";
import { registerWorkflowPaths } from "./paths/workflows";
import { registerDeploymentPaths } from "./paths/deployments";
import { registerPagePaths } from "./paths/pages";
import { registerResourcePaths } from "./paths/resources";
import { registerResourceChangePaths } from "./paths/resource-changes";
import { registerConnectionFeaturePaths } from "./paths/connection-features";
import { registerAssociationPaths } from "./paths/associations";
import { registerDependencyGraphPaths } from "./paths/dependency-graph";
import { registerSearchPaths } from "./paths/search";
import { registerConnectPaths } from "./paths/connect";
import { registerStorageUploadPaths } from "./paths/storage-upload";
import { registerSftpUploadPaths } from "./paths/sftp-upload";
import { registerSshKeyPaths } from "./paths/ssh-keys";
import { registerSshTunnelPaths } from "./paths/ssh-tunnels";
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
  registerBudgetPaths(ctx);
  registerChangeFreezePaths(ctx);
  registerTagPolicyPaths(ctx);
  registerCostCentrePaths(ctx);
  registerCustomGraphPaths(ctx);
  registerWorkflowApprovalPaths(ctx);
  registerWorkflowPaths(ctx);
  registerDeploymentPaths(ctx);
  registerPagePaths(ctx);
  registerResourcePaths(ctx);
  registerResourceChangePaths(ctx);
  registerConnectionFeaturePaths(ctx);
  registerAssociationPaths(ctx);
  registerDependencyGraphPaths(ctx);
  registerSearchPaths(ctx);
  registerConnectPaths(ctx);
  registerStorageUploadPaths(ctx);
  registerSftpUploadPaths(ctx);
  registerSshKeyPaths(ctx);
  registerSshTunnelPaths(ctx);
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
      { name: "Connect", description: "Helpers for shipping credentials into other services." },
      { name: "Storage", description: "Object storage helpers (uploads via API key)." },
      { name: "SFTP", description: "SFTP helpers (uploads via API key)." },
      { name: "SSH keys", description: "Org SSH keys for tunnel/SSH access." },
      { name: "SSH tunnels", description: "Server-side SSH tunnel lifecycle." },
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
      { name: "Slack", description: "Slack workspace connection and per-channel alert routing." },
      {
        name: "Microsoft Teams",
        description: "Microsoft Teams webhook connections and per-channel alert routing.",
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
  "POST /resources/create-cost-estimate": "resources:read",
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
  // ssh keys
  "GET /ssh-keys": "ssh-keys:read",
  "POST /ssh-keys": "ssh-keys:write",
  "POST /ssh-keys/import": "ssh-keys:write",
  "DELETE /ssh-keys/{id}": "ssh-keys:write",
  // ssh tunnels
  "POST /ssh-tunnels/create-account": "accounts:write",
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
