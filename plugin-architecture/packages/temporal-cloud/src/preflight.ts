import type {
  PreflightCapabilityCheck,
  PreflightDeclaration,
  PreflightResult,
} from "@infrawrench/plugin-base";
import type { TemporalContext } from "./api.js";
import { METRICS_API_BASE, fetchText, isPermissionError, statusOf, tcFetch } from "./api.js";
import type { TcApiKey, TcServiceAccount, TcUser } from "./types.js";

/**
 * Temporal Cloud has no permission strings, only roles
 * (https://docs.temporal.io/cloud/manage-access/roles-and-permissions), so
 * each capability names the account role that grants it.
 */
export const TEMPORAL_PREFLIGHT: PreflightDeclaration = {
  capabilities: [
    {
      id: "resources",
      label: "Namespaces, users, keys and endpoints",
      description:
        "List and manage namespaces, identities, Nexus endpoints and connectivity rules.",
      essential: true,
      requiredPermissions: [
        { id: "Account Admin", label: "Manage namespaces, users and service accounts" },
      ],
    },
    {
      id: "costs",
      label: "Billed cost",
      description: "Generate billing reports for per-namespace spend.",
      requiredPermissions: [
        { id: "Finance Admin", label: "Read usage and generate billing reports (or Owner)" },
      ],
    },
    {
      id: "metrics",
      label: "Namespace metrics",
      description: "Read the OpenMetrics endpoint for actions, workflow outcomes and latency.",
      requiredPermissions: [{ id: "Metrics Read-Only", label: "Read the metrics endpoint" }],
    },
  ],
};

const ROLES_HELP = {
  label: "Account roles",
  url: "https://docs.temporal.io/cloud/manage-access/roles-and-permissions",
};

export async function verifyTemporalCredentials(ctx: TemporalContext): Promise<PreflightResult> {
  const checks: PreflightCapabilityCheck[] = [];
  let identity: string | undefined;
  let role = "";
  try {
    const me = await tcFetch<{
      user?: TcUser;
      serviceAccount?: TcServiceAccount;
      principalApiKey?: TcApiKey;
    }>(ctx, "/cloud/current-identity");
    identity = me.user?.spec?.email ?? me.serviceAccount?.spec?.name ?? me.principalApiKey?.id;
    role =
      me.user?.spec?.access?.accountAccess?.role ??
      me.serviceAccount?.spec?.access?.accountAccess?.role ??
      "";
  } catch (err) {
    if (statusOf(err) === 401) {
      return {
        checks: TEMPORAL_PREFLIGHT.capabilities.map((c) => ({
          capabilityId: c.id,
          status: "missing" as const,
          missingPermissions: c.requiredPermissions,
          message:
            "Temporal Cloud rejected the API key. Check it was copied whole and has not expired.",
        })),
      };
    }
  }

  try {
    await tcFetch<unknown>(ctx, "/cloud/namespaces", { query: { pageSize: 1 } });
    checks.push(
      role === "ROLE_ADMIN" || role === "ROLE_OWNER"
        ? { capabilityId: "resources", status: "ok" }
        : {
            capabilityId: "resources",
            status: "missing",
            missingPermissions: TEMPORAL_PREFLIGHT.capabilities[0]?.requiredPermissions ?? [],
            message:
              "The key can read namespaces but its role cannot manage everything; edits may be refused.",
            helpLink: ROLES_HELP,
          },
    );
  } catch (err) {
    checks.push(
      isPermissionError(err)
        ? {
            capabilityId: "resources",
            status: "missing",
            missingPermissions: TEMPORAL_PREFLIGHT.capabilities[0]?.requiredPermissions ?? [],
            helpLink: ROLES_HELP,
          }
        : { capabilityId: "resources", status: "unknown", message: String(err) },
    );
  }

  // Creating a report is a write, so the probe reads the role instead.
  if (role === "ROLE_OWNER" || role === "ROLE_FINANCE_ADMIN") {
    checks.push({ capabilityId: "costs", status: "ok" });
  } else if (role) {
    checks.push({
      capabilityId: "costs",
      status: "missing",
      missingPermissions: TEMPORAL_PREFLIGHT.capabilities[1]?.requiredPermissions ?? [],
      message:
        "Without Owner or Finance Admin, the last 90 days are estimated from usage at published rates instead of read from billing reports.",
      helpLink: ROLES_HELP,
    });
  } else {
    checks.push({
      capabilityId: "costs",
      status: "unknown",
      message: "The key's role could not be read.",
    });
  }

  try {
    const res = await fetchText(ctx, `${METRICS_API_BASE}/v1/descriptors?limit=1`, {
      Authorization: `Bearer ${ctx.metricsApiKey}`,
    });
    checks.push(
      res.status >= 200 && res.status < 300
        ? { capabilityId: "metrics", status: "ok" }
        : res.status === 401 || res.status === 403
          ? {
              capabilityId: "metrics",
              status: "missing",
              missingPermissions: TEMPORAL_PREFLIGHT.capabilities[2]?.requiredPermissions ?? [],
              message:
                "Add a service account key with the Metrics Read-Only role as the Metrics API key.",
              helpLink: {
                label: "OpenMetrics setup",
                url: "https://docs.temporal.io/cloud/metrics/openmetrics",
              },
            }
          : { capabilityId: "metrics", status: "unknown", message: `HTTP ${res.status}` },
    );
  } catch (err) {
    checks.push({ capabilityId: "metrics", status: "unknown", message: String(err) });
  }

  return { checks, ...(identity ? { identity } : {}) };
}
