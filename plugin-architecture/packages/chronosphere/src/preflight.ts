/**
 * Credential preflight for Chronosphere. Tokens carry the permissions of the
 * service account or user they belong to, with no scope list to read back, so
 * each area is probed with a one-item list: ok on 2xx, missing on 403,
 * unknown otherwise. A 401 means the token or the org name is wrong.
 */
import type {
  PreflightCapability,
  PreflightCapabilityCheck,
  PreflightDeclaration,
  PreflightResult,
} from "@infrawrench/plugin-base";
import type { ChronoContext } from "./api.js";
import { chronoFetch, statusOf } from "./api.js";
import { PROM_PATH } from "./prom.js";

interface Probe {
  capability: PreflightCapability;
  path: string;
  query?: Record<string, string | number>;
}

const read = (
  id: string,
  label: string,
  description: string,
  plural: string,
  essential = false,
): Probe => ({
  capability: {
    id,
    label,
    description,
    requiredPermissions: [{ id: `${plural}:read`, label: `Read ${label.toLowerCase()}` }],
    ...(essential ? { essential: true } : {}),
  },
  path: `/api/v1/config/${plural}`,
  query: { "page.max_size": 1 },
});

const PROBES: Probe[] = [
  read("monitors", "Monitors", "List, create, edit and delete monitors.", "monitors", true),
  read(
    "routing",
    "Notification policies and notifiers",
    "List, rename and delete routing objects.",
    "notification-policies",
  ),
  read(
    "collections",
    "Collections, buckets and teams",
    "Organise monitors and dashboards.",
    "collections",
  ),
  read("dashboards", "Dashboards", "List, rename and delete dashboards.", "dashboards"),
  read("slos", "SLOs", "List and edit SLOs.", "slos"),
  read("shaping", "Rollup and drop rules", "Change metric shaping rules.", "drop-rules"),
  read(
    "service-accounts",
    "Service accounts",
    "List and delete service accounts (admin).",
    "service-accounts",
  ),
  {
    capability: {
      id: "query",
      label: "PromQL",
      description: "Chart monitor queries and run PromQL from the Query tab.",
      requiredPermissions: [{ id: "metrics:read", label: "Query metrics" }],
    },
    path: `${PROM_PATH}/query`,
    query: { query: "vector(1)" },
  },
];

export const CHRONO_PREFLIGHT: PreflightDeclaration = {
  capabilities: PROBES.map((p) => p.capability),
};

export async function verifyChronoCredentials(ctx: ChronoContext): Promise<PreflightResult> {
  const checks = await Promise.all(
    PROBES.map(async (p): Promise<PreflightCapabilityCheck> => {
      try {
        await chronoFetch(ctx, p.path, { query: p.query ?? {} });
        return { capabilityId: p.capability.id, status: "ok" };
      } catch (err) {
        const status = statusOf(err);
        if (status === 403) {
          return {
            capabilityId: p.capability.id,
            status: "missing",
            missingPermissions: p.capability.requiredPermissions,
          };
        }
        return {
          capabilityId: p.capability.id,
          status: "unknown",
          message:
            status === 401
              ? "Chronosphere rejected the token: it is wrong, revoked, or for another tenant."
              : err instanceof Error
                ? err.message
                : String(err),
        };
      }
    }),
  );
  return { checks };
}
