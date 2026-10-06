/**
 * Credential preflight. A classic personal access token can do everything its
 * owner can; a scoped token carries Management API scopes such as
 * `projects:read`, `secrets:read`, `database:write` and `analytics:read`
 * (the `x-oauth-scope` of each operation in the OpenAPI document). There is
 * no endpoint that reports a token's scopes, so this probes one cheap,
 * read-only call per capability and reads 401/403 as "missing".
 */
import type {
  PreflightCapabilityCheck,
  PreflightDeclaration,
  PreflightPermission,
  PreflightResult,
} from "@infrawrench/plugin-base";
import type { SupabaseContext } from "./api.js";
import { enc, sbFetch, statusOf } from "./api.js";
import { fetchProjects, isRunning } from "./listers.js";
import type { SbProject } from "./types.js";

const TOKENS_URL = "https://supabase.com/dashboard/account/tokens";

const P = {
  orgs: { id: "organizations:read", label: "organizations:read" },
  projects: { id: "projects:read", label: "projects:read" },
  secrets: { id: "secrets:read", label: "secrets:read (API keys)" },
  database: { id: "database:read", label: "database:read / database:write" },
  analytics: { id: "analytics:read", label: "analytics:read (logs and metrics)" },
  functions: { id: "edge_functions:read", label: "edge_functions:read" },
} satisfies Record<string, PreflightPermission>;

export const SUPABASE_PREFLIGHT: PreflightDeclaration = {
  capabilities: [
    {
      id: "inventory",
      label: "List organizations and projects",
      description: "Organizations, projects, branches, backups and configuration.",
      requiredPermissions: [P.orgs, P.projects],
      essential: true,
    },
    {
      id: "keys",
      label: "API keys and Storage",
      description:
        "Project API keys (and the connection outputs built from them), and buckets through the Storage API.",
      requiredPermissions: [P.secrets],
    },
    {
      id: "functions",
      label: "Edge Functions",
      description: "List, deploy and configure Edge Functions.",
      requiredPermissions: [P.functions],
    },
    {
      id: "database",
      label: "SQL editor and database settings",
      description: "Run SQL through the Management API and edit Postgres and pooler settings.",
      requiredPermissions: [P.database],
    },
    {
      id: "observability",
      label: "Logs and metrics",
      description: "Unified logs, request counts and the Prometheus metrics endpoint.",
      requiredPermissions: [P.analytics],
    },
  ],
};

async function probe(
  capabilityId: string,
  perms: PreflightPermission[],
  call: () => Promise<unknown>,
): Promise<PreflightCapabilityCheck> {
  try {
    await call();
    return { capabilityId, status: "ok" };
  } catch (err) {
    const status = statusOf(err);
    if (status === 401 || status === 403) {
      return {
        capabilityId,
        status: "missing",
        missingPermissions: perms,
        helpLink: { label: "Access tokens", url: TOKENS_URL },
      };
    }
    return {
      capabilityId,
      status: "unknown",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function verifySupabaseCredentials(ctx: SupabaseContext): Promise<PreflightResult> {
  let projects: SbProject[] = [];
  const inventory = await probe("inventory", [P.orgs, P.projects], async () => {
    await sbFetch(ctx, "GET", "/v1/organizations");
    projects = await fetchProjects(ctx);
  });
  const target = projects.find(isRunning);
  const skip = (capabilityId: string): PreflightCapabilityCheck => ({
    capabilityId,
    status: "unknown",
    message: "No running project to test against.",
  });
  if (!target) {
    return {
      checks: [inventory, skip("keys"), skip("functions"), skip("database"), skip("observability")],
    };
  }
  const base = `/v1/projects/${enc(target.ref)}`;
  const checks = await Promise.all([
    probe("keys", [P.secrets], () => sbFetch(ctx, "GET", `${base}/api-keys`)),
    probe("functions", [P.functions], () => sbFetch(ctx, "GET", `${base}/functions`)),
    probe("database", [P.database], () => sbFetch(ctx, "GET", `${base}/config/database/pooler`)),
    probe("observability", [P.analytics], () =>
      sbFetch(ctx, "GET", `${base}/analytics/endpoints/usage.api-requests-count`),
    ),
  ]);
  return { checks: [inventory, ...checks], identity: `${projects.length} project(s)` };
}
