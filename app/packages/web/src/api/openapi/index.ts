import { OpenAPIRegistry, OpenApiGeneratorV31 } from "@asteasolutions/zod-to-openapi";
import { buildDynamicEnums } from "./dynamic";
import type { BuildContext } from "./context";

type OpenAPIObject = ReturnType<OpenApiGeneratorV31["generateDocument"]>;

import { registerAuthPaths } from "./paths/auth";
import { registerOrgPaths } from "./paths/orgs";
import { registerInvitationPaths } from "./paths/invitations";
import { registerAccountPaths } from "./paths/accounts";
import { registerDashboardPaths } from "./paths/dashboards";
import { registerCostPaths } from "./paths/costs";
import { registerBudgetPaths } from "./paths/budgets";
import { registerResourcePaths } from "./paths/resources";
import { registerConnectionFeaturePaths } from "./paths/connection-features";
import { registerAssociationPaths } from "./paths/associations";
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

interface BuildOptions {
  /** Server URL(s) to advertise in the spec. */
  servers?: Array<{ url: string; description?: string }>;
  /** Override the spec version (defaults to the package.json version). */
  version?: string;
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
  registerOrgPaths(ctx);
  registerInvitationPaths(ctx);
  registerAccountPaths(ctx);
  registerDashboardPaths(ctx);
  registerCostPaths(ctx);
  registerBudgetPaths(ctx);
  registerResourcePaths(ctx);
  registerConnectionFeaturePaths(ctx);
  registerAssociationPaths(ctx);
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

  const generator = new OpenApiGeneratorV31(registry.definitions);

  const doc = generator.generateDocument({
    openapi: "3.1.0",
    info: {
      title: "Infrawrench API",
      version: opts.version ?? "0.1.0",
      description:
        "REST API for the Infrawrench cloud SaaS. Plugin and resource type IDs are enumerated from the live plugin registry at spec-build time, so this document always matches what the running server actually accepts.",
      license: { name: "BUSL-1.1", url: "https://mariadb.com/bsl11/" },
    },
    servers: opts.servers ?? [
      { url: "http://localhost:3000", description: "Local dev" },
      { url: "https://app.infrawrench.com", description: "Production" },
    ],
    security: [{ sessionCookie: [] }, { bearerAuth: [] }],
    tags: [
      { name: "Auth", description: "Session and identity." },
      { name: "Organizations", description: "Org creation and membership." },
      { name: "Invitations", description: "Accepting team invites." },
      { name: "Accounts", description: "Provider connections (cloud accounts)." },
      { name: "Dashboards", description: "Pinned resources, custom dashboards." },
      {
        name: "Resources",
        description: "CRUD, manifest, logs, secrets, metrics — all dispatched to plugins.",
      },
      {
        name: "Connections",
        description: "SQL / KV / Docker / SFTP / Storage operations against live resources.",
      },
      { name: "Associations", description: "Output-reference wiring between resources." },
      { name: "Search", description: "Cross-account resource search." },
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
      { name: "API keys", description: "Programmatic access tokens." },
      { name: "WebSocket", description: "Auth tokens for the WebSocket gateway." },
      { name: "Sync", description: "Bi-directional resource sync (used by the desktop app)." },
      { name: "Webhooks", description: "Inbound webhooks from third parties." },
      {
        name: "Admin",
        description:
          "Platform-operator surface (INFRAWRENCH_PLATFORM_ADMIN_EMAILS allowlist), e.g. complimentary orgs.",
      },
    ],
  });

  injectOperationIds(doc);
  injectRequiredPermissions(doc);
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
  // agents
  "GET /agents/accounts": "accounts:read",
  "GET /agents/settings": "accounts:read",
  "PUT /agents/settings": "accounts:write",
  "GET /agents/sessions": "resources:read",
  "POST /agents/sessions": "resources:write",
  "POST /agents/sessions/{id}/open": "resources:execute",
  "POST /agents/sessions/{id}/reconcile": "resources:execute",
  "DELETE /agents/sessions/{id}": "resources:delete",
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
  // associations
  "POST /associations": "secrets:write",
  "POST /associations/literal": "secrets:write",
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
  // api keys
  "POST /api-keys": "apikeys:write",
  "GET /api-keys": "apikeys:read",
  "POST /api-keys/{id}/revoke": "apikeys:write",
  "POST /api-keys/{id}/rotate": "apikeys:write",
  // sync (bearer-auth, scopes mirror permissions)
  "POST /v1/sync/pull": "resources:read",
  "POST /v1/sync/push": "resources:write",
  "GET /v1/sync/status": "resources:read",
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

/** Cached document; safe to call repeatedly from request handlers. */
let _cached: OpenAPIObject | null = null;

export async function getOpenApiDocument(opts: BuildOptions = {}): Promise<OpenAPIObject> {
  if (_cached) return _cached;
  _cached = await buildOpenApiDocument(opts);
  return _cached;
}
