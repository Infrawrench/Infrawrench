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
import { chronoFetch, configApi, guarded, statusOf } from "./api.js";
import { PROM_PATH } from "./prom.js";

type ConfigApi = ReturnType<typeof configApi>;

interface Probe {
  capability: PreflightCapability;
  /** The cheapest call that needs the permission. */
  call: (api: ConfigApi, ctx: ChronoContext) => Promise<object>;
}

const ONE = { query: { "page.max_size": 1 } };

const read = (
  id: string,
  label: string,
  description: string,
  plural: string,
  call: Probe["call"],
  essential = false,
): Probe => ({
  capability: {
    id,
    label,
    description,
    requiredPermissions: [{ id: `${plural}:read`, label: `Read ${label.toLowerCase()}` }],
    ...(essential ? { essential: true } : {}),
  },
  call,
});

const PROBES: Probe[] = [
  read(
    "monitors",
    "Monitors",
    "List, create, edit and delete monitors.",
    "monitors",
    (api) => api.get("/api/v1/config/monitors", ONE),
    true,
  ),
  read(
    "routing",
    "Notification policies and notifiers",
    "List, rename and delete routing objects.",
    "notification-policies",
    (api) => api.get("/api/v1/config/notification-policies", ONE),
  ),
  read(
    "collections",
    "Collections, buckets and teams",
    "Organise monitors and dashboards.",
    "collections",
    (api) => api.get("/api/v1/config/collections", ONE),
  ),
  read("dashboards", "Dashboards", "List, rename and delete dashboards.", "dashboards", (api) =>
    api.get("/api/v1/config/dashboards", ONE),
  ),
  read("slos", "SLOs", "List and edit SLOs.", "slos", (api) => api.get("/api/v1/config/slos", ONE)),
  read("shaping", "Rollup and drop rules", "Change metric shaping rules.", "drop-rules", (api) =>
    api.get("/api/v1/config/drop-rules", ONE),
  ),
  read(
    "service-accounts",
    "Service accounts",
    "List and delete service accounts (admin).",
    "service-accounts",
    (api) => api.get("/api/v1/config/service-accounts", ONE),
  ),
  {
    capability: {
      id: "query",
      product: "observability",
      label: "PromQL",
      description: "Chart monitor queries and run PromQL from the Query tab.",
      requiredPermissions: [{ id: "metrics:read", label: "Query metrics" }],
    },
    call: (_api, ctx) => chronoFetch(ctx, `${PROM_PATH}/query`, { query: { query: "vector(1)" } }),
  },
];

export const CHRONO_PREFLIGHT: PreflightDeclaration = {
  capabilities: PROBES.map((p) => p.capability),
};

export async function verifyChronoCredentials(ctx: ChronoContext): Promise<PreflightResult> {
  const api = configApi(ctx);
  const checks = await Promise.all(
    PROBES.map(async (p): Promise<PreflightCapabilityCheck> => {
      try {
        await guarded(p.call(api, ctx));
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
