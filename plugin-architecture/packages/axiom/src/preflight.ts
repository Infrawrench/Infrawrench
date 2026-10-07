/**
 * Credential preflight for Axiom: one cheap list call per capability.
 * Axiom answers both a bad token and a missing capability with 403, so a
 * failing `GET /v2/orgs` is reported against everything as a bad token, and
 * a 403 on one list only after the token itself proved good. Capability names
 * are the ones Axiom's token editor and API use (`orgCapabilities`).
 */
import type {
  PreflightCapability,
  PreflightCapabilityCheck,
  PreflightDeclaration,
  PreflightResult,
} from "@infrawrench/plugin-base";
import type { AxiomContext } from "./api.js";
import { axFetch, isPersonalToken, statusOf } from "./api.js";
import type { AxOrg } from "./types.js";

const perm = (id: string, label: string) => ({ id, label });

interface Probe {
  capability: PreflightCapability;
  path: string;
}

const PROBES: Probe[] = [
  {
    capability: {
      id: "resources",
      label: "Datasets",
      description: "List datasets, their fields and virtual fields, and edit them.",
      requiredPermissions: [
        perm("datasets|read", "Datasets: read"),
        perm("datasets|update", "Datasets: update"),
      ],
      essential: true,
    },
    path: "/v2/datasets",
  },
  {
    capability: {
      id: "monitors",
      label: "Monitors",
      requiredPermissions: [
        perm("monitors|read", "Monitors: read"),
        perm("monitors|update", "Monitors: update"),
      ],
    },
    path: "/v2/monitors",
  },
  {
    capability: {
      id: "notifiers",
      label: "Notifiers",
      requiredPermissions: [perm("notifiers|read", "Notifiers: read")],
    },
    path: "/v2/notifiers",
  },
  {
    capability: {
      id: "dashboards",
      label: "Dashboards",
      requiredPermissions: [perm("dashboards|read", "Dashboards: read")],
    },
    path: "/v2/dashboards?limit=1",
  },
  {
    capability: {
      id: "api-tokens",
      label: "API tokens",
      requiredPermissions: [perm("apiTokens|read", "API tokens: read")],
    },
    path: "/v2/tokens",
  },
  {
    capability: {
      id: "users",
      label: "Users",
      requiredPermissions: [perm("users|read", "Users: read")],
    },
    path: "/v2/users",
  },
];

const QUERY_CAPABILITY: PreflightCapability = {
  id: "metrics",
  label: "Queries, logs and metrics",
  description:
    "The APL editor, the Logs tab and the Metrics tab run queries. Organization usage charts read the axiom-audit dataset, which needs the Owner role or query access to it.",
  requiredPermissions: [perm("query|read", "Datasets: query")],
};

export const AXIOM_PREFLIGHT: PreflightDeclaration = {
  capabilities: [...PROBES.map((p) => p.capability), QUERY_CAPABILITY],
};

export async function verifyAxiomCredentials(ctx: AxiomContext): Promise<PreflightResult> {
  let org: AxOrg | undefined;
  try {
    org = ctx.orgId
      ? await axFetch<AxOrg>(ctx, `/v2/orgs/${encodeURIComponent(ctx.orgId)}`)
      : (await axFetch<AxOrg[]>(ctx, "/v2/orgs"))?.[0];
  } catch (err) {
    const status = statusOf(err);
    const message =
      status === 401 || status === 403
        ? "Axiom rejected the token. Check it, and for a personal access token the organization ID."
        : err instanceof Error
          ? err.message
          : String(err);
    return {
      checks: [...PROBES.map((p) => p.capability), QUERY_CAPABILITY].map((c) =>
        status === 401 || status === 403
          ? {
              capabilityId: c.id,
              status: "missing",
              missingPermissions: c.requiredPermissions,
              message,
            }
          : { capabilityId: c.id, status: "unknown", message },
      ),
    };
  }
  const checks: PreflightCapabilityCheck[] = await Promise.all(
    PROBES.map(async ({ capability, path }): Promise<PreflightCapabilityCheck> => {
      try {
        await axFetch(ctx, path);
        return { capabilityId: capability.id, status: "ok" };
      } catch (err) {
        if (statusOf(err) === 403) {
          return {
            capabilityId: capability.id,
            status: "missing",
            missingPermissions: capability.requiredPermissions,
          };
        }
        return {
          capabilityId: capability.id,
          status: "unknown",
          message: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
  checks.push(
    isPersonalToken(ctx.token)
      ? { capabilityId: QUERY_CAPABILITY.id, status: "ok" }
      : {
          capabilityId: QUERY_CAPABILITY.id,
          status: "unknown",
          message:
            "Query access is per dataset; running a query to check it would bill query compute.",
        },
  );
  return { checks, ...(org?.name ? { identity: `${org.name} (${org.id ?? ""})` } : {}) };
}
