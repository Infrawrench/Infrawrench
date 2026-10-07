/**
 * Credential preflight for Splunk Observability Cloud.
 *
 * Splunk access tokens carry auth scopes (API, Ingest, RUM) rather than
 * per-endpoint permissions, and the admin-only routes (org tokens, members,
 * integrations) additionally need the token's owner to be an admin. So each
 * capability is probed with one cheap read: ok on 2xx, missing on 403,
 * unknown otherwise. A 401 means the token or the realm is wrong.
 */
import type {
  PreflightCapability,
  PreflightCapabilityCheck,
  PreflightDeclaration,
  PreflightResult,
} from "@infrawrench/plugin-base";
import type { SplunkContext } from "./api.js";
import { sfFetch, statusOf } from "./api.js";

const perm = (id: string, label = id) => ({ id, label });

interface Probe {
  capability: PreflightCapability;
  run: (ctx: SplunkContext) => Promise<unknown>;
}

const PROBES: Probe[] = [
  {
    capability: {
      id: "api",
      label: "Organization and content",
      description:
        "Read the organization, detectors, dashboards, charts, teams, muting rules, alerts and SLOs.",
      requiredPermissions: [perm("API", "API scope")],
      essential: true,
    },
    run: (ctx) => sfFetch(ctx, "/v2/organization"),
  },
  {
    capability: {
      id: "detectors",
      label: "Detectors and alerts",
      description: "List, edit and toggle detectors; clear alerts.",
      requiredPermissions: [perm("API", "API scope")],
    },
    run: (ctx) => sfFetch(ctx, "/v2/detector", { query: { limit: 1 } }),
  },
  {
    capability: {
      id: "tokens",
      label: "Access tokens",
      description: "List, edit, rotate and delete organization access tokens.",
      requiredPermissions: [perm("admin", "Admin user's API token")],
    },
    run: (ctx) => sfFetch(ctx, "/v2/token", { query: { limit: 1 } }),
  },
  {
    capability: {
      id: "members",
      label: "Members",
      description: "Invite and remove users and change admin rights.",
      requiredPermissions: [perm("admin", "Admin user's API token")],
    },
    run: (ctx) => sfFetch(ctx, "/v2/organization/member", { query: { limit: 1 } }),
  },
  {
    capability: {
      id: "integrations",
      label: "Integrations",
      description: "List, toggle, validate and delete integrations.",
      requiredPermissions: [perm("admin", "Admin user's API token")],
    },
    run: (ctx) => sfFetch(ctx, "/v2/integration", { query: { limit: 1 } }),
  },
  {
    capability: {
      id: "synthetics",
      label: "Synthetic tests",
      description: "List, pause, resume, run and delete synthetic tests.",
      requiredPermissions: [perm("API", "API scope")],
    },
    run: (ctx) => sfFetch(ctx, "/v2/synthetics/tests", { query: { page: 1, perPage: 1 } }),
  },
];

export const SPLUNK_PREFLIGHT: PreflightDeclaration = {
  capabilities: PROBES.map((p) => p.capability),
};

export async function verifySplunkCredentials(ctx: SplunkContext): Promise<PreflightResult> {
  const checks = await Promise.all(
    PROBES.map(async (p): Promise<PreflightCapabilityCheck> => {
      try {
        await p.run(ctx);
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
              ? "Splunk rejected the token: it is wrong, expired, or for another realm."
              : err instanceof Error
                ? err.message
                : String(err),
        };
      }
    }),
  );
  return { checks };
}
