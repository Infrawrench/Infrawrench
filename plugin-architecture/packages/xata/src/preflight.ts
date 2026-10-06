/**
 * Credential preflight. Organization API keys act as an Admin limited by
 * their scopes (`project:read`, `branch:write`, `credentials:read`,
 * `metrics:read`, `logs:read`, `keys:read`…); user keys act with the member's
 * role. Nothing reports a key's scopes, so each capability is one cheap read
 * and a 401/403 reads as missing.
 */
import type {
  PreflightCapabilityCheck,
  PreflightDeclaration,
  PreflightPermission,
  PreflightResult,
} from "@infrawrench/plugin-base";
import { statusOf, xata } from "./api.js";
import type { XataClient } from "./client.js";

const KEYS_URL = "https://console.xata.io";

const P = {
  org: { id: "org:read", label: "org:read" },
  project: { id: "project:read", label: "project:read" },
  branch: { id: "branch:read", label: "branch:read" },
  credentials: { id: "credentials:read", label: "credentials:read" },
  metrics: { id: "metrics:read", label: "metrics:read and logs:read" },
  keys: { id: "keys:read", label: "keys:read" },
} satisfies Record<string, PreflightPermission>;

export const XATA_PREFLIGHT: PreflightDeclaration = {
  capabilities: [
    {
      id: "inventory",
      label: "List organizations, projects and branches",
      requiredPermissions: [P.org, P.project, P.branch],
      essential: true,
    },
    {
      id: "connect",
      label: "Connection strings and SQL",
      description: "Branch credentials, the PostgreSQL tab and the SQL editor.",
      requiredPermissions: [P.credentials],
    },
    {
      id: "observability",
      label: "Metrics and logs",
      requiredPermissions: [P.metrics],
    },
    {
      id: "keys",
      label: "API keys",
      description: "List and manage the organization's API keys.",
      requiredPermissions: [P.keys],
    },
  ],
};

async function probe(
  id: string,
  perms: PreflightPermission[],
  call: () => Promise<unknown>,
): Promise<PreflightCapabilityCheck> {
  try {
    await call();
    return { capabilityId: id, status: "ok" };
  } catch (err) {
    const status = statusOf(err);
    if (status === 401 || status === 403) {
      return {
        capabilityId: id,
        status: "missing",
        missingPermissions: perms,
        helpLink: { label: "Xata API keys", url: KEYS_URL },
      };
    }
    return {
      capabilityId: id,
      status: "unknown",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function verifyXataCredentials(client: XataClient): Promise<PreflightResult> {
  let target: { org: string; project: string; branch: string } | undefined;
  let orgId = "";
  const inventory = await probe("inventory", [P.org, P.project, P.branch], async () => {
    const orgs = await client.orgs();
    orgId = orgs[0]?.id ?? "";
    for (const o of orgs) {
      for (const p of await client.projects(o.id)) {
        const b = (await client.branchSummaries(o.id, p.id))[0];
        if (b) {
          target = { org: o.id, project: p.id, branch: b.id };
          return;
        }
      }
    }
  });
  const ctx = client.ctx;
  const unknown = (id: string): PreflightCapabilityCheck => ({
    capabilityId: id,
    status: "unknown",
    message: "No branch to test against.",
  });
  const t = target;
  const path = t ? `/organizations/${t.org}/projects/${t.project}/branches/${t.branch}` : "";
  const now = Date.now();
  const checks = await Promise.all([
    t
      ? probe("connect", [P.credentials], () => xata(ctx, "GET", `${path}/credentials`))
      : unknown("connect"),
    t
      ? probe("observability", [P.metrics], () =>
          xata(ctx, "POST", `${path}/metrics`, {
            start: new Date(now - 600_000).toISOString(),
            end: new Date(now).toISOString(),
            metrics: ["cpu"],
            aggregations: ["avg"],
          }),
        )
      : unknown("observability"),
    orgId
      ? probe("keys", [P.keys], () => xata(ctx, "GET", `/organizations/${orgId}/api-keys`))
      : unknown("keys"),
  ]);
  return { checks: [inventory, ...checks] };
}
