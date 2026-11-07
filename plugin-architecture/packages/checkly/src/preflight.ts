/**
 * Credential preflight for Checkly: one list per area. A user API key carries
 * its owner's role in the account (Read only, Read & Write, Admin, Owner), so
 * a 403 here means the role is too narrow for that area.
 */
import type {
  PreflightCapability,
  PreflightCapabilityCheck,
  PreflightDeclaration,
  PreflightResult,
} from "@infrawrench/plugin-base";
import type { ChecklyApi } from "./api.js";
import { statusOf } from "./api.js";

const perm = (id: string, label: string) => ({ id, label });

const PROBES: Array<{
  capability: PreflightCapability;
  probe: (api: ChecklyApi) => Promise<object | undefined>;
}> = [
  {
    capability: {
      id: "resources",
      label: "Checks and groups",
      requiredPermissions: [
        perm("Read & Write", "Read & Write role (Read only lists without changing anything)"),
      ],
      essential: true,
    },
    probe: (api) => api.get("/v1/checks", { query: { limit: 1 } }),
  },
  {
    capability: {
      id: "alerting",
      label: "Alert channels and maintenance windows",
      requiredPermissions: [perm("Read & Write", "Read & Write role")],
    },
    probe: (api) => api.get("/v1/alert-channels", { query: { limit: 1 } }),
  },
  {
    capability: {
      id: "metrics",
      label: "Check results and analytics",
      description: "Charts on the Metrics tab and 7-day availability.",
      requiredPermissions: [perm("Read only", "Read only role or higher")],
    },
    probe: (api) => api.get("/v1/check-statuses"),
  },
  {
    capability: {
      id: "private-locations",
      label: "Private locations",
      requiredPermissions: [perm("Admin", "Admin role to manage agent keys")],
    },
    probe: (api) => api.get("/v1/private-locations"),
  },
];

export const CHECKLY_PREFLIGHT: PreflightDeclaration = {
  capabilities: PROBES.map((p) => p.capability),
};

export async function verifyChecklyCredentials(api: ChecklyApi): Promise<PreflightResult> {
  let identity: string | undefined;
  try {
    const me = await api.get("/v1/accounts/me");
    identity = [me.name, me.planDisplayName].filter(Boolean).join(", ") || me.id;
  } catch {
    identity = undefined;
  }
  const checks = await Promise.all(
    PROBES.map(async ({ capability, probe }): Promise<PreflightCapabilityCheck> => {
      try {
        await probe(api);
        return { capabilityId: capability.id, status: "ok" };
      } catch (err) {
        const status = statusOf(err);
        if (status === 401 || status === 403) {
          return {
            capabilityId: capability.id,
            status: "missing",
            missingPermissions: capability.requiredPermissions,
            ...(status === 401 ? { message: "Checkly rejected the API key or account ID." } : {}),
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
  return { checks, ...(identity ? { identity } : {}) };
}
