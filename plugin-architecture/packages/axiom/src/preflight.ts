/**
 * Credential preflight for Axiom: one cheap list call per capability.
 * Axiom answers both a bad token and a missing capability with 403, so a 403 on
 * one list counts only after the token itself proved good. A personal access
 * token proves itself on `GET /v2/orgs`. The document has that route refuse an
 * API token, so one of those proves itself on any list that answers instead.
 * Capability names are the ones Axiom's token editor and API use (`orgCapabilities`).
 */
import type {
  PreflightCapability,
  PreflightCapabilityCheck,
  PreflightDeclaration,
  PreflightResult,
} from "@infrawrench/plugin-base";
import { pathEncode } from "@infrawrench/plugin-base";
import type { AxiomApi, AxiomContext } from "./api.js";
import { isPersonalToken, managementApi, orgRefusedApiToken, statusOf } from "./api.js";
import type { AxOrg } from "./types.js";

const perm = (id: string, label: string) => ({ id, label });

interface Probe {
  capability: PreflightCapability;
  call: (api: AxiomApi) => Promise<object>;
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
    call: (api) => api.get("/datasets"),
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
    call: (api) => api.get("/monitors"),
  },
  {
    capability: {
      id: "notifiers",
      label: "Notifiers",
      requiredPermissions: [perm("notifiers|read", "Notifiers: read")],
    },
    call: (api) => api.get("/notifiers"),
  },
  {
    capability: {
      id: "dashboards",
      label: "Dashboards",
      requiredPermissions: [perm("dashboards|read", "Dashboards: read")],
    },
    call: (api) => api.get("/dashboards", { query: { limit: 1 } }),
  },
  {
    capability: {
      id: "api-tokens",
      label: "API tokens",
      requiredPermissions: [perm("apiTokens|read", "API tokens: read")],
    },
    call: (api) => api.get("/tokens"),
  },
  {
    capability: {
      id: "users",
      label: "Users",
      requiredPermissions: [perm("users|read", "Users: read")],
    },
    call: (api) => api.get("/users"),
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

/** The routes that can prove an API token good, between them needing every capability. */
const TOKEN_PROOFS: Array<Probe["call"]> = [
  ...PROBES.map((p) => p.call),
  (api) => api.get("/views"),
  (api) => api.get("/apl-starred-queries", { query: { who: "all", limit: 1 } }),
  (api) => {
    const end = new Date();
    const start = new Date(end.getTime() - 3600_000);
    return api.get("/annotations", {
      query: { start: start.toISOString(), end: end.toISOString() },
    });
  },
];

function readOrg(api: AxiomApi, ctx: AxiomContext): Promise<AxOrg | undefined> {
  return ctx.orgId
    ? api.get(`/orgs/${pathEncode(ctx.orgId)}`)
    : api.get("/orgs").then((orgs) => orgs?.[0]);
}

/**
 * Whether Axiom accepts this token at all, asked afresh: an answer from any route proves
 * it, and a 403 alone cannot, since a bad token gets one as well. An error that is not a
 * refusal leaves it unproved, so the caller's list fails rather than reading as empty.
 */
export async function tokenAccepted(api: AxiomApi, ctx: AxiomContext): Promise<boolean> {
  try {
    await readOrg(api, ctx);
    return true;
  } catch (err) {
    if (!orgRefusedApiToken(ctx.token, err)) return false;
  }
  for (const proof of TOKEN_PROOFS) {
    try {
      await proof(api);
      return true;
    } catch (err) {
      if (statusOf(err) !== 403) return false;
    }
  }
  return false;
}

function rejected(message: string): PreflightResult {
  return {
    checks: [...PROBES.map((p) => p.capability), QUERY_CAPABILITY].map((c) => ({
      capabilityId: c.id,
      status: "missing",
      missingPermissions: c.requiredPermissions,
      message,
    })),
  };
}

const REJECTED =
  "Axiom rejected the token. Check it, and for a personal access token the organization ID.";

export async function verifyAxiomCredentials(ctx: AxiomContext): Promise<PreflightResult> {
  // A probe's error names its whole request, since the dashboards one has a query.
  const api = managementApi(ctx, "target");
  let org: AxOrg | undefined;
  let orgRefused = false;
  try {
    org = await readOrg(api, ctx);
  } catch (err) {
    orgRefused = orgRefusedApiToken(ctx.token, err);
    if (!orgRefused) {
      const status = statusOf(err);
      if (status === 401 || status === 403) return rejected(REJECTED);
      const message = err instanceof Error ? err.message : String(err);
      return {
        checks: [...PROBES.map((p) => p.capability), QUERY_CAPABILITY].map((c) => ({
          capabilityId: c.id,
          status: "unknown",
          message,
        })),
      };
    }
  }
  const checks: PreflightCapabilityCheck[] = await Promise.all(
    PROBES.map(async ({ capability, call }): Promise<PreflightCapabilityCheck> => {
      try {
        await call(api);
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
  if (
    orgRefused &&
    checks.every((c) => c.status === "missing") &&
    !(await tokenAccepted(api, ctx))
  ) {
    return rejected(REJECTED);
  }
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
