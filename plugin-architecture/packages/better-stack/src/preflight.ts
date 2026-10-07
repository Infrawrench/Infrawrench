/**
 * Credential preflight for Better Stack: one cheap list per product. Global
 * API tokens reach all three hosts; team Uptime or Telemetry tokens only
 * their own, and usage (cost) and team members only answer global tokens.
 */
import type {
  PreflightCapability,
  PreflightCapabilityCheck,
  PreflightDeclaration,
  PreflightResult,
} from "@infrawrench/plugin-base";
import type { BetterStackContext, Host } from "./api.js";
import { bsFetch, statusOf } from "./api.js";

const perm = (id: string, label: string) => ({ id, label });

const PROBES: Array<{ capability: PreflightCapability; host: Host; path: string }> = [
  {
    capability: {
      id: "resources",
      label: "Uptime",
      description:
        "Monitors, heartbeats, status pages, on-call, incidents and escalation policies.",
      requiredPermissions: [
        perm("Uptime API token", "A global API token or a team Uptime API token"),
      ],
      essential: true,
    },
    host: "uptime",
    path: "/api/v2/monitors",
  },
  {
    capability: {
      id: "telemetry",
      label: "Telemetry",
      description:
        "Sources, source groups, dashboards and alerts; logs and SQL through a connection.",
      requiredPermissions: [
        perm("Telemetry API token", "A global API token or a team Telemetry API token"),
      ],
    },
    host: "telemetry",
    path: "/api/v2/sources",
  },
  {
    capability: {
      id: "costs",
      label: "Cost data",
      description: "Daily cost per product and billed item from the usage API.",
      requiredPermissions: [perm("Global API token", "A global API token")],
    },
    host: "main",
    path: "/api/v2/usage",
  },
];

export const BETTER_STACK_PREFLIGHT: PreflightDeclaration = {
  capabilities: PROBES.map((p) => p.capability),
};

export async function verifyBetterStackCredentials(
  ctx: BetterStackContext,
): Promise<PreflightResult> {
  const checks = await Promise.all(
    PROBES.map(async ({ capability, host, path }): Promise<PreflightCapabilityCheck> => {
      try {
        await bsFetch(ctx, host, path);
        return { capabilityId: capability.id, status: "ok" };
      } catch (err) {
        const status = statusOf(err);
        if (status === 401 || status === 403) {
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
  return { checks };
}
