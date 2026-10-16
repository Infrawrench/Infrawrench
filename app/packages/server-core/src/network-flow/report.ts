/**
 * Running a network flow report: resolve the window and scope, run the reads,
 * hand them to the pure assembly in `client-core/src/network-flow-reports.ts`.
 *
 * Which rows a report reads is the feed's rule, restated here because it
 * decides whether a total is honest:
 *
 * - every statement starts from `flowOrgCondition`, so a cost visibility scope
 *   narrows a report to the accounts it grants outright, exactly as on the
 *   feed (a scope that grants none sees no flows rather than all of them);
 * - plugins whose flows **re-cut** another account's traffic (a Kubernetes
 *   cluster's pods, whose bytes also cross the node interfaces a VPC flow log
 *   counts) stay out of a report that does not name one of their accounts,
 *   so a cross-account total never counts the same bytes twice;
 * - bytes from a plugin whose source **samples** are counted and labelled,
 *   never dropped and never re-scaled here: the plugin already reported its
 *   scaled estimate.
 */
import { and, eq, isNull } from "drizzle-orm";
import {
  buildNetworkFlowReport,
  networkFlowReportRangeProblem,
  networkFlowReportRanksByBytes,
  networkFlowReportTopN,
  resolveCostDateRange,
  NETWORK_FLOW_PAIR_SEPARATOR,
  NETWORK_FLOW_REPORT_LIMITS,
  NETWORK_FLOW_RETENTION_DAYS,
  NETWORK_FLOW_TRAFFIC_CLASSES,
  type NetworkFlowReportCell,
  type NetworkFlowReportConfig,
  type NetworkFlowReportGroupTotal,
  type NetworkFlowReportNotice,
  type NetworkFlowReportOptions,
  type NetworkFlowReportResult,
  type NetworkFlowReportTalker,
} from "@infrawrench/client-core";
import type { NetworkFlowScope } from "@infrawrench/plugin-base";

import {
  readNetworkFlowReportCells,
  readNetworkFlowReportDimensionValues,
  readNetworkFlowReportGroups,
  readNetworkFlowReportTalkers,
  type NetworkFlowReportCellRow,
  type NetworkFlowReportSqlFilters,
} from "../clickhouse/network-flow-report-readers";
import { isoDay } from "../cost/dates";
import { strictlyVisibleAccountIds } from "../cost/visibility-context";
import { db } from "../db/client";
import { accounts } from "../db/schema";
import { loadPlugins } from "../plugin-loader";
import { getNetworkFlowSettings } from "./settings";

/** A config the server refuses to run (a resolved range past the limits). */
export class NetworkFlowReportError extends Error {
  override readonly name = "NetworkFlowReportError";
}

const DAY_MS = 86_400_000;

interface FlowScope {
  /** Flow-capable accounts the caller may see. */
  accounts: Array<{ id: string; displayName: string; pluginId: string; recut: boolean }>;
  /** Every org account's display name the caller may see, for labels. */
  names: Map<string, string>;
  recutPluginIds: string[];
  sampledPluginIds: string[];
}

async function loadFlowScope(organizationId: string): Promise<FlowScope> {
  const plugins = await loadPlugins();
  const capable = new Map<string, { recut: boolean; sampled: boolean }>();
  for (const p of plugins) {
    const cap = p.plugin.manifest.networkFlows;
    if (!cap) continue;
    capable.set(p.plugin.manifest.id, { recut: cap.recut === true, sampled: cap.sampled === true });
  }
  const rows = await db
    .select({ id: accounts.id, displayName: accounts.displayName, pluginId: accounts.pluginId })
    .from(accounts)
    .where(and(eq(accounts.organizationId, organizationId), isNull(accounts.deletedAt)));
  const visible = strictlyVisibleAccountIds(organizationId);
  const seen = rows.filter((a) => !visible || visible.has(a.id));
  return {
    accounts: seen
      .filter((a) => capable.has(a.pluginId))
      .map((a) => ({ ...a, recut: capable.get(a.pluginId)!.recut })),
    names: new Map(seen.map((a) => [a.id, a.displayName])),
    recutPluginIds: [...capable].filter(([, c]) => c.recut).map(([id]) => id),
    sampledPluginIds: [...capable].filter(([, c]) => c.sampled).map(([id]) => id),
  };
}

/** The report's filters in reader terms, plus whether re-cut rows were left out. */
function sqlFilters(
  config: NetworkFlowReportConfig,
  scope: FlowScope,
): { filters: NetworkFlowReportSqlFilters; recutExcluded: boolean } {
  const f = config.filters;
  // Naming an account is asking about it: a cluster named here is its own
  // whole answer, as on the feed. Without an account filter, re-cut plugins
  // are left out so no byte is counted from both the node and the pod.
  const excludePluginIds = f.accountIds?.length ? [] : scope.recutPluginIds;
  return {
    filters: {
      accountIds: f.accountIds,
      networks: f.networks,
      regions: f.regions,
      zones: f.zones,
      sourceRefs: f.sourceRefs,
      destinationRefs: f.destinationRefs,
      peerServices: f.services,
      peerResourceTypes: f.resourceTypes,
      scopes: f.trafficClasses,
      directions: f.directions,
      excludePluginIds,
    },
    recutExcluded:
      excludePluginIds.length > 0 &&
      scope.accounts.some((a) => a.recut && excludePluginIds.includes(a.pluginId)),
  };
}

function toCell(r: NetworkFlowReportCellRow): NetworkFlowReportCell {
  return {
    bucket: r.bucket,
    groupKey: r.group_key,
    currency: r.currency || "USD",
    bytes: r.bytes,
    estimatedCost: r.estimated_cost,
    sampledBytes: r.sampled_bytes,
    sampledCost: r.sampled_cost,
    unattributedBytes: r.unattributed_bytes,
    truncatedBytes: r.truncated_bytes,
  };
}

/** A group's display label. Traffic classes and sentinels are named by the clients. */
function groupLabel(
  config: NetworkFlowReportConfig,
  key: string,
  labelA: string,
  labelB: string,
  names: ReadonlyMap<string, string>,
): string {
  switch (config.groupBy) {
    case "pair": {
      const [src, dst] = key.split(NETWORK_FLOW_PAIR_SEPARATOR);
      return `${labelA || src || "-"} → ${labelB || dst || "-"}`;
    }
    case "zone_pair":
    case "region_pair": {
      const [a, b] = key.split(NETWORK_FLOW_PAIR_SEPARATOR);
      return `${a || "-"} → ${b || "-"}`;
    }
    case "source":
    case "destination":
      return labelA || key;
    case "account":
      return names.get(key) ?? key;
    default:
      return key;
  }
}

/** Resolve a config's window: relative presets anchor on `today`, never past it. */
export function resolveNetworkFlowReportWindow(
  config: NetworkFlowReportConfig,
  today = new Date(),
): { from: string; to: string } {
  const { from, to: resolvedTo } = resolveCostDateRange(config.dateRange, today);
  // A future day has no flows; counting it would only add empty buckets.
  const todayIso = isoDay(today);
  const to = resolvedTo > todayIso && from <= todayIso ? todayIso : resolvedTo;
  return { from, to };
}

/**
 * Run a report config. `today` anchors relative presets, so a saved "last 30
 * days" means the 30 days before each run.
 */
export async function runNetworkFlowReportConfig(
  organizationId: string,
  config: NetworkFlowReportConfig,
  today = new Date(),
): Promise<NetworkFlowReportResult> {
  const { from, to } = resolveNetworkFlowReportWindow(config, today);
  const problem = networkFlowReportRangeProblem(from, to);
  if (problem) throw new NetworkFlowReportError(problem);

  const [settings, scope] = await Promise.all([
    getNetworkFlowSettings(organizationId),
    loadFlowScope(organizationId),
  ]);
  const { filters, recutExcluded } = sqlFilters(config, scope);
  const range = { from, to };
  const orderByBytes = networkFlowReportRanksByBytes(config.metric);
  const topN = networkFlowReportTopN(config);
  const sampledPluginIds = scope.sampledPluginIds;

  const [groupRead, overallRows, talkerRows] = await Promise.all([
    config.groupBy === "none"
      ? Promise.resolve({ rows: [], count: 0 })
      : readNetworkFlowReportGroups(organizationId, {
          range,
          split: config.groupBy,
          filters,
          sampledPluginIds,
          orderByBytes,
          limit: topN,
        }),
    readNetworkFlowReportCells(organizationId, {
      range,
      bucket: config.granularity,
      split: "none",
      filters,
      sampledPluginIds,
      groupKeys: null,
    }),
    readNetworkFlowReportTalkers(organizationId, {
      range,
      filters,
      sampledPluginIds,
      orderByBytes,
      limit: topN,
    }),
  ]);

  const groups: NetworkFlowReportGroupTotal[] = groupRead.rows.map((r) => ({
    groupKey: r.group_key,
    label: groupLabel(config, r.group_key, r.label_a, r.label_b, scope.names),
    currency: r.currency || "USD",
    pairCount: r.pair_count,
    bytes: r.bytes,
    estimatedCost: r.estimated_cost,
    sampledBytes: r.sampled_bytes,
    sampledCost: r.sampled_cost,
    unattributedBytes: r.unattributed_bytes,
    truncatedBytes: r.truncated_bytes,
  }));
  // The chart's groups: the largest, by the report's own ranking (the reader
  // returned them in that order). Their per-bucket cells come from one more
  // scan restricted to just those keys.
  const chartKeys = [...new Set(groups.map((g) => g.groupKey))].slice(
    0,
    NETWORK_FLOW_REPORT_LIMITS.chartSeries,
  );
  const seriesRows =
    config.groupBy === "none"
      ? []
      : await readNetworkFlowReportCells(organizationId, {
          range,
          bucket: config.granularity,
          split: config.groupBy,
          filters,
          sampledPluginIds,
          groupKeys: chartKeys,
        });

  const sampled = new Set(sampledPluginIds);
  const topTalkers: NetworkFlowReportTalker[] = talkerRows.map((r) => ({
    source: {
      ref: r.src_ref,
      label: r.src_label || r.src_ref,
      zone: r.src_zone,
      region: r.src_region,
      service: r.src_service,
      resourceTypeId: r.src_resource_type_id,
      network: r.src_network,
    },
    destination: {
      ref: r.dst_ref,
      label: r.dst_label || r.dst_ref,
      zone: r.dst_zone,
      region: r.dst_region,
      service: r.dst_service,
      resourceTypeId: r.dst_resource_type_id,
      network: r.dst_network,
    },
    scope: r.scope as NetworkFlowScope,
    direction: r.direction === "ingress" ? "ingress" : "egress",
    attribution: r.attribution === "unattributed" ? "unattributed" : "resolved",
    bytes: r.bytes,
    packets: r.packets,
    estimatedCost: r.estimated_cost,
    currency: r.currency || "USD",
    accountId: r.account_id,
    accountName: scope.names.get(r.account_id) ?? "",
    pluginId: r.plugin_id,
    days: r.days,
    sampled: r.sampled > 0 || sampled.has(r.plugin_id),
  }));

  const notices: NetworkFlowReportNotice[] = [];
  if (!settings.enabled) notices.push("collection_disabled");
  if (scope.accounts.length === 0) notices.push("no_flow_accounts");
  const retentionStart = isoDay(
    new Date(today.valueOf() - (NETWORK_FLOW_RETENTION_DAYS - 1) * DAY_MS),
  );
  if (from < retentionStart) notices.push("beyond_retention");
  if (recutExcluded) notices.push("recut_excluded");

  return buildNetworkFlowReport({
    from,
    to,
    granularity: config.granularity,
    groupBy: config.groupBy,
    metric: config.metric,
    overallCells: overallRows.map(toCell),
    seriesCells: seriesRows.map(toCell),
    groups,
    groupCount: groupRead.count,
    topTalkers,
    topN,
    sampledPluginIds: sampledPluginIds.filter((id) =>
      scope.accounts.some((a) => a.pluginId === id),
    ),
    notices,
  });
}

/**
 * Picker values for the report editor, scoped exactly as a run is: accounts
 * the caller may see whose provider can report flows, and every value seen in
 * the store's retention window.
 */
export async function getNetworkFlowReportOptions(
  organizationId: string,
  today = new Date(),
): Promise<NetworkFlowReportOptions> {
  const scope = await loadFlowScope(organizationId);
  const to = isoDay(today);
  const from = isoDay(new Date(today.valueOf() - (NETWORK_FLOW_RETENTION_DAYS - 1) * DAY_MS));
  // Options include re-cut plugins' values: a user filtering to a cluster by
  // account must be able to pick that cluster's workloads too.
  const dims = await readNetworkFlowReportDimensionValues(organizationId, { from, to });
  const scopes = new Set(dims.scopes);
  return {
    accounts: scope.accounts
      .map((a) => ({ id: a.id, name: a.displayName, pluginId: a.pluginId, recut: a.recut }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    networks: dims.networks,
    regions: dims.regions,
    zones: dims.zones,
    services: dims.services,
    resourceTypes: dims.resourceTypes,
    endpoints: dims.endpoints.map((e) => ({
      ref: e.ref,
      label: e.label,
      resourceTypeId: e.resource_type_id,
      side: e.side,
    })),
    // Every class, in bill order, so a report can be saved for a boundary that
    // has not carried traffic yet; the ones seen in the window first.
    trafficClasses: [
      ...NETWORK_FLOW_TRAFFIC_CLASSES.filter((s) => scopes.has(s)),
      ...NETWORK_FLOW_TRAFFIC_CLASSES.filter((s) => !scopes.has(s)),
    ],
  };
}
