/**
 * Savings-finder tools: the MCP/chat view of the Costs panel's "Potential
 * savings" (orphans), "Oversized" (right-sizing) and efficiency-alert
 * sections. Read-only: applying a recommendation goes through the ordinary
 * resource-update path (the web/desktop Apply button), which is what carries
 * change-freeze enforcement and audit logging. Every finding carries
 * `remediation`: the owning plugin's ready-to-run CLI commands, plus a
 * Terraform hint when the resource is IaC-managed, so an agent can hand a
 * human the exact command instead of paraphrasing one.
 */
import { z } from "zod";
import { COST_EFFICIENCY_LIMITS, type EfficiencyAlertKind } from "@infrawrench/client-core";
import { listEfficiencyAlerts } from "../services/efficiency-alerts";
import { listOrphans } from "../services/orphans";
import { listRightsizing } from "../services/rightsizing";
import { ok, type ToolDefinition } from "./types";

const REMEDIATION_NOTE =
  " Each finding has `remediation`: `commands` (ordered `{tool, command, description, " +
  "destructive}`; values are already shell-quoted, `$VARS` are listed in `placeholders`) and " +
  "`iac` (non-null when Terraform manages the resource: edit the named address instead of " +
  "running the CLI commands). Show destructive commands to a human before suggesting them.";

export function rightsizingTools(): ToolDefinition[] {
  return [
    {
      name: "list_oversized_resources",
      title: "List oversized resources",
      description:
        "Resources whose p95 CPU/memory utilisation over the last 14 days of stored metrics " +
        "sits well under their current size, each with the cheapest smaller size from the " +
        "provider's own catalog that still clears a headroom margin, the live-priced " +
        "monthly saving, and the estimated monthly kg CO2e the resize would save " +
        "(`monthlyKgCo2eSaving`, null where the region has no published grid figure). Covers plugins that declare right-sizing support (Hetzner servers, " +
        "DigitalOcean Droplets, EC2 instances, Azure VMs, GCE instances). Purely a read; " +
        "results are cached for a few minutes; pass refresh to recompute." +
        REMEDIATION_NOTE,
      inputSchema: {
        refresh: z
          .boolean()
          .optional()
          .describe("Bypass the short server-side cache and recompute now."),
      },
      risk: "read",
      permission: "resources:read",
      handler: async (input, auth) => {
        const refresh = Boolean((input as { refresh?: boolean }).refresh);
        return ok(await listRightsizing(auth.organizationId, { refresh }));
      },
    },
    {
      name: "list_orphaned_resources",
      title: "List orphaned and idle resources",
      description:
        "Likely-wasted resources (unattached volumes, unassigned IPs, load balancers with no " +
        "targets, idle seats and similar), grouped by account, each with the plugin's reason " +
        "and recorded owner. Classified from already-synced state by each resource type's " +
        "declarative rule: no provider API calls. Spend annotations are omitted here; use " +
        "query_costs for money." +
        REMEDIATION_NOTE,
      inputSchema: {},
      risk: "read",
      permission: "resources:read",
      handler: async (_input, auth) =>
        ok(await listOrphans(auth.organizationId, { includeCosts: false })),
    },
    {
      name: "list_efficiency_alerts",
      title: "List efficiency alerts",
      description:
        "Recent efficiency alerts, newest first: commitments nearing expiry, idle commitments " +
        "(utilization under the org's threshold, with the wasted amount), and unit-cost " +
        "regressions. Idle commitments carry `remediation` with the provider's commands for " +
        "inspecting, exchanging, re-scoping or returning the commitment where it allows that.",
      inputSchema: {
        kind: z
          .enum(["commitment_expiry", "commitment_idle", "unit_cost_regression"])
          .optional()
          .describe("Only this kind of alert."),
        limit: z
          .number()
          .int()
          .min(COST_EFFICIENCY_LIMITS.minEventsLimit)
          .max(COST_EFFICIENCY_LIMITS.maxEventsLimit)
          .optional()
          .describe(`Rows to return (default ${COST_EFFICIENCY_LIMITS.defaultEventsLimit}).`),
      },
      risk: "read",
      permission: "costs:read",
      handler: async (input, auth) => {
        const { kind, limit } = input as { kind?: EfficiencyAlertKind; limit?: number };
        const events = await listEfficiencyAlerts(auth.organizationId, {
          kind,
          limit: limit ?? COST_EFFICIENCY_LIMITS.defaultEventsLimit,
        });
        return ok({ events });
      },
    },
  ];
}
