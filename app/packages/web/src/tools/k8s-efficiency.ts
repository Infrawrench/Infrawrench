/**
 * Kubernetes efficiency tools: list and run saved efficiency reports, or run
 * an unsaved one, from chat and MCP. Reads only; reports are created and
 * edited in the app. Permissions mirror the routes (`costs:read`), and every
 * read runs under the caller's cost visibility scope (`runToolHandler`).
 */
import { z } from "zod";
import { kubernetesEfficiencyConfigSchema } from "@infrawrench/ui/cost/config";
import type { KubernetesEfficiencyResult } from "@infrawrench/client-core";
import {
  listKubernetesEfficiencyReports,
  queryKubernetesEfficiency,
  runKubernetesEfficiencyReport,
} from "../services/k8s-efficiency-reports";
import { ok, err, type ToolDefinition } from "./types";

const CONFIG_GUIDE =
  "Config: `{version: 1, dateRange: {kind:'relative', preset: 7d|30d|90d|mtd|last_month|qtd|ytd|6m|12m} " +
  "| {kind:'absolute', from, to}, granularity: day|week|month, filters: [{dimension: account|region|tag, " +
  "op: in|not_in, values, tagKey?}], groupBy: cluster|namespace|workload|label|node_pool|category, " +
  "groupByLabelKey? (with groupBy label, e.g. k8s_pod_label:team), categories?: [cpu|memory|gpu|storage|" +
  "network|control_plane|compute], idle: separate|spread, basis: total|allocated}`. Efficiency on the " +
  "total basis is used / (total - unmeasured); on the allocated basis used / (used + unused). Null means " +
  "nothing was measured, not zero.";

/**
 * The run result trimmed for a model: totals and rows without the per-period
 * series, which can run to hundreds of points and say nothing a sentence
 * needs.
 */
function summarize(result: KubernetesEfficiencyResult) {
  return {
    from: result.from,
    to: result.to,
    groupBy: result.groupBy,
    groupByLabelKey: result.groupByLabelKey,
    idle: result.idle,
    basis: result.basis,
    includesLegacyRows: result.includesLegacyRows,
    currencies: result.currencies.map((c) => ({
      currency: c.currency,
      totals: c.totals,
      categories: c.categories,
      rows: c.rows.slice(0, 50).map((r) => ({
        key: r.key,
        kind: r.kind,
        label: r.label,
        figures: r.figures,
        categories: r.categories,
      })),
      rowsOmitted: Math.max(0, c.rows.length - 50),
    })),
  };
}

export function kubernetesEfficiencyTools(): ToolDefinition[] {
  return [
    {
      name: "list_kubernetes_efficiency_reports",
      title: "List Kubernetes efficiency reports",
      description:
        "List the organization's saved Kubernetes efficiency reports: how much of each cluster's " +
        "cost was used, requested but unused, unmeasured, idle or overhead, by cluster, namespace, " +
        "workload, label, node pool or cost category. Returns definitions; use " +
        "run_kubernetes_efficiency_report for numbers.",
      inputSchema: {},
      risk: "read",
      permission: "costs:read",
      handler: async (_input, auth) => {
        const reports = await listKubernetesEfficiencyReports(auth.organizationId);
        return ok(
          reports.map((r) => ({
            id: r.id,
            name: r.name,
            description: r.description,
            config: r.config,
            updatedAt: r.updatedAt,
          })),
        );
      },
    },
    {
      name: "run_kubernetes_efficiency_report",
      title: "Run Kubernetes efficiency report",
      description:
        "Run a saved Kubernetes efficiency report and return its totals, per-category split and " +
        "one row per group (at most 50), each with total, used, unused, unmeasured, idle and " +
        "overhead cost and an efficiency between 0 and 1. Quote the returned window with figures.",
      inputSchema: { reportId: z.string() },
      risk: "read",
      permission: "costs:read",
      handler: async (input, auth) => {
        const reportId = input["reportId"] as string;
        const run = await runKubernetesEfficiencyReport(auth.organizationId, reportId);
        if (!run) return err(`Kubernetes efficiency report not found: ${reportId}`);
        return ok({ reportId: run.reportId, name: run.name, ...summarize(run.result) });
      },
    },
    {
      name: "query_kubernetes_efficiency",
      title: "Query Kubernetes efficiency",
      description:
        "Run an unsaved Kubernetes efficiency report over the clusters the caller can see. " +
        CONFIG_GUIDE,
      inputSchema: { config: z.record(z.unknown()) },
      risk: "read",
      permission: "costs:read",
      handler: async (input, auth) => {
        const parsed = kubernetesEfficiencyConfigSchema.safeParse(input["config"]);
        if (!parsed.success) {
          return err(
            `Invalid config: ${parsed.error.issues
              .slice(0, 6)
              .map((i) => `${i.path.join(".") || "(config)"}: ${i.message}`)
              .join("; ")}`,
          );
        }
        return ok(summarize(await queryKubernetesEfficiency(auth.organizationId, parsed.data)));
      },
    },
  ];
}
