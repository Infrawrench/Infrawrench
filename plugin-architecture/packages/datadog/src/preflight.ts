/**
 * Credential preflight for Datadog.
 *
 * Datadog splits authentication in two: the API key names the organization
 * and the application key names the user (or service account) and carries
 * their permissions. An application key can additionally be *scoped* to a
 * subset of those permissions, and that is the least-privilege story this
 * preflight supports: every capability lists the exact permission names the
 * endpoints it calls declare (`x-permission` in Datadog's published OpenAPI
 * documents, 2026-10), and the template is the scope list to paste when
 * creating a scoped application key.
 *
 * Probes are three-way, as everywhere else: ok only on a 2xx, missing only on
 * a 403, unknown on anything else (a 5xx says nothing about scopes). A 401
 * means the keys themselves are wrong, which no permission can fix, so it is
 * reported against every capability with that message.
 */

import type {
  PolicyTemplate,
  PreflightCapability,
  PreflightCapabilityCheck,
  PreflightDeclaration,
  PreflightResult,
} from "@infrawrench/plugin-base";
import type { DatadogContext } from "./api.js";
import { ddFetch, statusOf } from "./api.js";

interface CapabilityProbe {
  capability: PreflightCapability;
  path: string;
  query?: Record<string, string | number | boolean>;
}

const perm = (id: string, label: string) => ({ id, label });

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

const PROBES: CapabilityProbe[] = [
  {
    capability: {
      id: "costs",
      label: "Cost data",
      description:
        "Estimated, projected and historical cost by product and organization, and cost attribution by tag. Both keys must belong to the parent organization.",
      requiredPermissions: [perm("usage_read", "Usage Read"), perm("billing_read", "Billing Read")],
    },
    path: "/api/v2/usage/estimated_cost",
    query: { start_month: currentMonth() },
  },
  {
    capability: {
      id: "usage",
      label: "Usage metrics",
      description: "Hourly usage by product on each organization's Metrics tab.",
      requiredPermissions: [perm("usage_read", "Usage Read")],
    },
    path: "/api/v2/usage/hourly_usage",
    query: {
      "filter[timestamp][start]": new Date(Date.now() - 2 * 3600_000).toISOString().slice(0, 13),
      "filter[product_families]": "infra_hosts",
      "page[limit]": 1,
    },
  },
  {
    capability: {
      id: "monitors",
      label: "Monitors and downtimes",
      description: "List monitors and downtimes, edit monitors, mute and schedule downtimes.",
      requiredPermissions: [
        perm("monitors_read", "Monitors Read"),
        perm("monitors_write", "Monitors Write"),
        perm("monitors_downtime", "Manage Downtimes"),
      ],
    },
    path: "/api/v1/monitor",
    query: { page: 0, page_size: 1 },
  },
  {
    capability: {
      id: "dashboards",
      label: "Dashboards",
      requiredPermissions: [
        perm("dashboards_read", "Dashboards Read"),
        perm("dashboards_write", "Dashboards Write"),
      ],
    },
    path: "/api/v1/dashboard",
    query: { count: 1 },
  },
  {
    capability: {
      id: "slos",
      label: "SLOs",
      requiredPermissions: [perm("slos_read", "SLOs Read"), perm("slos_write", "SLOs Write")],
    },
    path: "/api/v1/slo",
    query: { limit: 1 },
  },
  {
    capability: {
      id: "synthetics",
      label: "Synthetic tests",
      description: "List tests and chart results; pause, resume and run them.",
      requiredPermissions: [
        perm("synthetics_read", "Synthetics Read"),
        perm("synthetics_write", "Synthetics Write"),
      ],
    },
    path: "/api/v1/synthetics/tests",
    query: { page_size: 1 },
  },
  {
    capability: {
      id: "hosts",
      label: "Hosts",
      requiredPermissions: [perm("hosts_read", "Hosts Read")],
    },
    path: "/api/v1/hosts",
    query: { count: 1 },
  },
  {
    capability: {
      id: "metrics",
      label: "Host and monitor charts",
      description: "Metric queries behind the host and monitor Metrics tabs.",
      requiredPermissions: [perm("timeseries_query", "Timeseries Query")],
    },
    path: "/api/v1/query",
    query: {
      from: Math.floor(Date.now() / 1000) - 300,
      to: Math.floor(Date.now() / 1000),
      query: "avg:datadog.agent.running{*}",
    },
  },
  {
    capability: {
      id: "users",
      label: "Users",
      description: "List users and disable them from the access review.",
      requiredPermissions: [
        perm("user_access_read", "User Access Read"),
        perm("user_access_manage", "User Access Manage"),
      ],
    },
    path: "/api/v2/users",
    query: { "page[size]": 1 },
  },
  {
    capability: {
      id: "api-keys",
      label: "API keys",
      requiredPermissions: [
        perm("api_keys_read", "API Keys Read"),
        perm("api_keys_delete", "API Keys Delete"),
      ],
    },
    path: "/api/v2/api_keys",
    query: { "page[size]": 1 },
  },
  {
    capability: {
      id: "application-keys",
      label: "Application keys",
      requiredPermissions: [
        perm("org_app_keys_read", "Org App Keys Read"),
        perm("org_app_keys_write", "Org App Keys Write"),
      ],
    },
    path: "/api/v2/application_keys",
    query: { "page[size]": 1 },
  },
];

export const DATADOG_PREFLIGHT: PreflightDeclaration = {
  capabilities: PROBES.map((p) => p.capability),
  templateFormat: { label: "Application key scopes", language: "text" },
};

const SCOPES_HELP = {
  label: "Scoped application keys",
  url: "https://docs.datadoghq.com/account_management/api-app-keys/#scopes",
};

export async function verifyDatadogCredentials(ctx: DatadogContext): Promise<PreflightResult> {
  // The API key alone: `GET /api/v1/validate` needs no application key.
  try {
    const res = await ddFetch<{ valid?: boolean }>(ctx, "/api/v1/validate");
    if (res?.valid === false) throw Object.assign(new Error("invalid"), { status: 403 });
  } catch (err) {
    const status = statusOf(err);
    const message =
      status === 403 || status === 401
        ? `Datadog rejected the API key on ${ctx.site.label}. Check the key, and that the account's site matches the one in your Datadog URL.`
        : `Could not reach Datadog on ${ctx.site.label}: ${err instanceof Error ? err.message : String(err)}`;
    return {
      checks: PROBES.map((p) => ({
        capabilityId: p.capability.id,
        status: "unknown",
        message,
      })),
    };
  }

  let identity: string | undefined;
  try {
    const me = await ddFetch<{
      data?: { attributes?: { email?: string; handle?: string; name?: string } };
    }>(ctx, "/api/v2/current_user");
    const a = me.data?.attributes;
    identity = a?.email || a?.handle || a?.name || undefined;
  } catch {
    identity = undefined;
  }

  const checks = await Promise.all(
    PROBES.map(async (probe): Promise<PreflightCapabilityCheck> => {
      try {
        await ddFetch<unknown>(ctx, probe.path, { query: probe.query ?? {} });
        return { capabilityId: probe.capability.id, status: "ok" };
      } catch (err) {
        const status = statusOf(err);
        if (status === 403) {
          return {
            capabilityId: probe.capability.id,
            status: "missing",
            missingPermissions: probe.capability.requiredPermissions,
            message:
              "The application key, or the user that owns it, lacks the permissions this needs.",
            helpLink: SCOPES_HELP,
          };
        }
        if (status === 401) {
          return {
            capabilityId: probe.capability.id,
            status: "unknown",
            message:
              "Datadog rejected the application key. Check that it belongs to the same organization as the API key.",
          };
        }
        return {
          capabilityId: probe.capability.id,
          status: "unknown",
          message: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
  return { checks, ...(identity ? { identity } : {}) };
}

export function datadogPolicyTemplate(capabilityIds: string[]): PolicyTemplate {
  const selected = PROBES.filter(
    (p) => capabilityIds.length === 0 || capabilityIds.includes(p.capability.id),
  );
  const scopes = [
    ...new Set(selected.flatMap((p) => p.capability.requiredPermissions.map((x) => x.id))),
  ].sort();
  return {
    formatLabel: "Application key scopes",
    language: "text",
    document: scopes.join("\n"),
    instructions:
      "In Datadog, open Organization Settings, then Application Keys, create a key (or edit one) and use Edit Scopes to grant exactly these scopes. The key's owner must hold the same permissions through their role: a scope narrows a key, it cannot grant more than its owner has. The Write, Delete and Manage scopes are only needed for the matching actions; leave them out for a read-only account.",
    helpLink: SCOPES_HELP,
  };
}
