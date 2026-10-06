/**
 * Credential preflight. An API key carries its service account's roles
 * (ORG_ADMIN, CLUSTER_ADMIN, CLUSTER_OPERATOR_WRITER, BILLING_VIEWER…), and
 * the API has no "what can I do" call, so each capability is one read and a
 * 401/403 reads as missing.
 */
import type {
  PreflightCapabilityCheck,
  PreflightDeclaration,
  PreflightPermission,
  PreflightResult,
} from "@infrawrench/plugin-base";
import { crdb, statusOf } from "./api.js";
import type { CockroachClient } from "./client.js";

const HELP = "https://cockroachlabs.cloud/access";

const P = {
  member: { id: "ORG_MEMBER", label: "Any organization role (ORG_MEMBER)" },
  cluster: {
    id: "CLUSTER_ADMIN",
    label: "CLUSTER_ADMIN or CLUSTER_OPERATOR_WRITER (organization or folder scope)",
  },
  billing: { id: "BILLING_VIEWER", label: "BILLING_VIEWER or BILLING_COORDINATOR" },
  org: { id: "ORG_ADMIN", label: "ORG_ADMIN" },
} satisfies Record<string, PreflightPermission>;

export const CRDB_PREFLIGHT: PreflightDeclaration = {
  capabilities: [
    {
      id: "inventory",
      label: "List clusters and folders",
      requiredPermissions: [P.member],
      essential: true,
    },
    {
      id: "manage",
      label: "Manage clusters",
      description: "Databases, SQL users, allowlists, backups, exports and scaling.",
      requiredPermissions: [P.cluster],
    },
    { id: "costs", label: "Invoices (cost data)", requiredPermissions: [P.billing] },
    { id: "access", label: "Service accounts and API keys", requiredPermissions: [P.org] },
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
        helpLink: { label: "Access management", url: HELP },
      };
    }
    return {
      capabilityId: id,
      status: "unknown",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function verifyCockroachCredentials(
  client: CockroachClient,
): Promise<PreflightResult> {
  let firstCluster = "";
  const inventory = await probe("inventory", [P.member], async () => {
    firstCluster = (await client.clusters())[0]?.id ?? "";
  });
  const checks = await Promise.all([
    firstCluster
      ? probe("manage", [P.cluster], () =>
          crdb(client.ctx, "GET", `/api/v1/clusters/${firstCluster}/sql-users`),
        )
      : Promise.resolve<PreflightCapabilityCheck>({
          capabilityId: "manage",
          status: "unknown",
          message: "No cluster to test against.",
        }),
    probe("costs", [P.billing], () =>
      crdb(client.ctx, "GET", "/api/v1/invoices", undefined, { "pagination.limit": 1 }),
    ),
    probe("access", [P.org], () =>
      crdb(client.ctx, "GET", "/api/v1/service-accounts", undefined, { "pagination.limit": 1 }),
    ),
  ]);
  return { checks: [inventory, ...checks] };
}
