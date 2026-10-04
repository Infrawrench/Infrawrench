/**
 * Credential preflight for Confluent Cloud.
 *
 * A Cloud API key carries exactly the RBAC role bindings of the user or
 * service account that owns it, so least privilege here means "bind these
 * roles to a dedicated service account and create its Cloud API key". Role
 * names and what each grants come from Confluent's predefined-role
 * reference (https://docs.confluent.io/cloud/current/security/access-control/rbac/predefined-rbac-roles.html,
 * 2026-10).
 *
 * Probes are three-way: ok on a 2xx, missing on a 403, unknown otherwise. A
 * 401 means the key itself is wrong (or is a cluster key, not a Cloud key),
 * which no role can fix, so it is reported against every capability.
 */

import type {
  PolicyTemplate,
  PreflightCapability,
  PreflightCapabilityCheck,
  PreflightDeclaration,
  PreflightResult,
} from "@infrawrench/plugin-base";
import type { ConfluentContext } from "./api.js";
import { TELEMETRY_API, ccFetch, statusOf } from "./api.js";

interface CapabilityProbe {
  capability: PreflightCapability;
  run: (ctx: ConfluentContext) => Promise<unknown>;
  /** The role binding the template asks for, and at which scope. */
  role: string;
}

const perm = (id: string, label: string) => ({ id, label });

function day(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

const PROBES: CapabilityProbe[] = [
  {
    capability: {
      id: "inventory",
      label: "Inventory",
      description:
        "List environments, Kafka clusters, connectors, Flink compute pools, ksqlDB clusters, Schema Registry, networks and API keys.",
      requiredPermissions: [perm("Operator", "Operator (organization)")],
    },
    role: "Operator",
    run: (ctx) => ccFetch(ctx, "/org/v2/environments", { query: { page_size: 1 } }),
  },
  {
    capability: {
      id: "costs",
      label: "Cost data",
      description:
        "Daily cost by product, environment and resource from the Billing Costs API, and the CKU prices the Oversized finder compares against.",
      requiredPermissions: [perm("BillingAdmin", "BillingAdmin (organization)")],
    },
    role: "BillingAdmin",
    run: (ctx) =>
      ccFetch(ctx, "/billing/v1/costs", {
        query: { start_date: day(-5), end_date: day(-4), page_size: 1 },
      }),
  },
  {
    capability: {
      id: "metrics",
      label: "Metrics",
      description:
        "Throughput, partitions, topics, connections, consumer lag, CKU utilization, connector records, Flink CFUs and ksqlDB saturation from the Metrics API.",
      requiredPermissions: [perm("MetricsViewer", "MetricsViewer (organization)")],
    },
    role: "MetricsViewer",
    run: (ctx) =>
      ccFetch(ctx, "/v2/metrics/cloud/query", {
        base: TELEMETRY_API,
        method: "POST",
        body: JSON.stringify({
          aggregations: [{ metric: "io.confluent.kafka.server/received_bytes" }],
          filter: { op: "EQ", field: "resource.kafka.id", value: "lkc-preflight" },
          granularity: "PT1H",
          intervals: ["now-2h|h/now|h"],
        }),
      }),
  },
  {
    capability: {
      id: "service-accounts",
      label: "Service accounts",
      description: "List, create, edit and delete service accounts.",
      requiredPermissions: [perm("AccountAdmin", "AccountAdmin (organization)")],
    },
    role: "AccountAdmin",
    run: (ctx) => ccFetch(ctx, "/iam/v2/service-accounts", { query: { page_size: 1 } }),
  },
  {
    capability: {
      id: "encryption-keys",
      label: "Encryption keys",
      description: "List self-managed encryption keys registered for cluster storage.",
      requiredPermissions: [perm("OrganizationAdmin", "OrganizationAdmin (organization)")],
    },
    role: "OrganizationAdmin",
    run: (ctx) => ccFetch(ctx, "/byok/v1/keys", { query: { page_size: 1 } }),
  },
];

export const CONFLUENT_PREFLIGHT: PreflightDeclaration = {
  capabilities: PROBES.map((p) => p.capability),
  templateFormat: { label: "Confluent CLI role bindings", language: "text" },
};

const RBAC_HELP = {
  label: "Predefined RBAC roles",
  url: "https://docs.confluent.io/cloud/current/security/access-control/rbac/predefined-rbac-roles.html",
};

export async function verifyConfluentCredentials(ctx: ConfluentContext): Promise<PreflightResult> {
  // The key alone: the organization list answers for any valid Cloud key.
  let identity: string | undefined;
  try {
    const orgs = await ccFetch<{ data?: Array<{ display_name?: string; id?: string }> }>(
      ctx,
      "/org/v2/organizations",
    );
    const org = orgs?.data?.[0];
    identity = org?.display_name || org?.id || undefined;
  } catch (err) {
    if (statusOf(err) === 401) {
      return {
        checks: PROBES.map((p) => ({
          capabilityId: p.capability.id,
          status: "unknown",
          message:
            "Confluent Cloud rejected the key. Use a Cloud API key (Administration, Cloud API keys), not a key scoped to one cluster.",
        })),
      };
    }
  }

  const checks = await Promise.all(
    PROBES.map(async (probe): Promise<PreflightCapabilityCheck> => {
      try {
        await probe.run(ctx);
        return { capabilityId: probe.capability.id, status: "ok" };
      } catch (err) {
        const status = statusOf(err);
        if (status === 403) {
          return {
            capabilityId: probe.capability.id,
            status: "missing",
            missingPermissions: probe.capability.requiredPermissions,
            message: "The Cloud API key's owner has no role binding that allows this.",
            helpLink: RBAC_HELP,
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

export function confluentPolicyTemplate(capabilityIds: string[]): PolicyTemplate {
  const selected = PROBES.filter(
    (p) => capabilityIds.length === 0 || capabilityIds.includes(p.capability.id),
  );
  const roles = [...new Set(selected.map((p) => p.role))];
  const lines = [
    "# Replace sa-123456 with the service account that owns the Cloud API key.",
    ...roles.map(
      (role) => `confluent iam rbac role-binding create --principal User:sa-123456 --role ${role}`,
    ),
  ];
  return {
    formatLabel: "Confluent CLI role bindings",
    language: "text",
    document: lines.join("\n"),
    instructions:
      "Create a service account for Infrawrench (Administration, Accounts and access, Service accounts), bind these organization-level roles to it with the Confluent CLI or the Accounts and access page, then create a Cloud API key owned by it. Resizing clusters, pausing connectors, managing Flink compute pools and creating environments additionally need EnvironmentAdmin (or OrganizationAdmin to create environments); leave them out for a read-only account.",
    helpLink: RBAC_HELP,
  };
}
