/**
 * The cluster efficiency report.
 *
 * Efficiency used to be a percentage on a pill and a stat on a card — enough to
 * notice a problem, not enough to do anything about it. This turns it into a
 * report: every namespace and every workload, what it asked for, what it
 * actually uses, and **what the gap costs**, worst first.
 *
 * WHY THIS IS NOT A SAVED COST REPORT. The obvious home was the `cost_reports`
 * object, and it does not fit — not by a little. That object is a *saved
 * ClickHouse query*: its `config` column is validated against a closed
 * `costGraphConfigSchema`, running one calls `costQueryForConfig(...)` →
 * `runCostQuery(...)` against the stored daily cost rows, the run result is
 * typed as a bucketed money series, and the renderer is a single chart card.
 * There is no data-source indirection to hook and no report-kind discriminator
 * to extend. More decisively, the numbers this report is *about* — requested,
 * used, wasted — are computed live from `/api/v1/pods` and `metrics.k8s.io` and
 * are never written to the cost store at all; only the money is. Forcing them
 * in would mean a new column on the cost rows, a widened config union, and a
 * second renderer, i.e. building the parallel report type anyway while making
 * the existing one harder to reason about.
 *
 * So it lives on the cluster's own surfaces, where the data is: an **Efficiency**
 * tab on the cluster and on each namespace, plus a plain-text rendering that
 * pastes into a ticket or a Slack thread. Sharing is the text; acting is the
 * per-row link to the workload.
 *
 * WHAT IT REFUSES TO DO. It does not name a recommended request value. See
 * `rightsizingNote` below.
 *
 * Pure: an allocation in, rows and strings out. No fetching, no clock — the
 * caller passes the timestamp.
 */

import type {
  ClusterAllocation,
  Efficiency,
  NamespaceAllocation,
  WorkloadAllocation,
} from "./cost-model.js";
import { formatMoney } from "./cost-model.js";
import { formatCores, formatMemory, type ResourcePair } from "./quantity.js";

/**
 * Why there is no Kubernetes entry in the "Oversized" right-sizing list, and
 * why this report stops at the diagnosis.
 *
 * Right-sizing in `server-core` is a *size-catalog matcher*: a plugin declares
 * a list of discrete provider SKUs with prices, the service takes a p95 over 14
 * days of stored metrics, picks the cheapest catalog entry the p95 still fits
 * inside with headroom, and applies it through `updateResource`. Every one of
 * those four pieces is wrong for a workload:
 *
 *  - **No catalog.** A pod request is a continuous two-dimensional quantity set
 *    per container, not a choice from a menu. There is no "next size down".
 *  - **No `updateResource` path.** Resizing a workload is a patch to
 *    `spec.template.spec.containers[].resources`, per container — the manifest
 *    editor's job, not the resource-update form's.
 *  - **No p95.** `metrics.k8s.io` reports usage over a window of seconds. A
 *    recommendation drawn from one instantaneous sample is precisely the kind
 *    of confident-looking invented number the rest of this plugin refuses to
 *    produce; a workload's peak is not its mean and a sample at 03:00 does not
 *    describe a lunchtime spike.
 *  - **The percentile source is opt-in anyway.** Stored quantiles exist for
 *    resources pinned to a dashboard, which is not the same population as
 *    "every workload in the cluster".
 *
 * So Kubernetes right-sizing is deliberately not duplicated into the Oversized
 * list, and this report gives the argument rather than the answer: the money,
 * the ratio, and the worst offenders in order. Deciding a new request value is
 * the operator's call, made against a workload they know the shape of.
 */
export const RIGHTSIZING_NOTE =
  "This report diagnoses; it does not prescribe a new request value. Live usage is an " +
  "instantaneous sample, and a request derived from one sample would be a guess dressed up " +
  "as a recommendation. Use the numbers here to pick the workloads worth looking at, then " +
  "size them against a peak you trust.";

/** One row of the report — a namespace or a workload, they share a shape. */
export interface EfficiencyRow {
  /** `namespace` for a namespace row, `namespace/Kind/name` for a workload. */
  key: string;
  /** What to show in the first column. */
  label: string;
  namespace: string;
  /** Empty for a namespace row. */
  workloadKind: string;
  podCount: number;
  requests: ResourcePair;
  /** `null` when nothing measured this row — never zero. */
  usage: ResourcePair | null;
  /** `null` for the same reason. */
  wasted: ResourcePair | null;
  efficiency: Efficiency;
  /** Total attributed cost: compute + storage + load balancers. */
  dailyCost: number | null;
  /** The compute share of {@link dailyCost} that buys nothing. */
  wastedDailyCost: number | null;
  /** Nothing measured this row. Renders as "unknown", not as 0%. */
  unknown: boolean;
}

export interface EfficiencyReport {
  /** ISO timestamp, supplied by the caller — this module owns no clock. */
  generatedAt: string;
  currency: string;
  /** `requests` when metrics-server was absent and nothing could be measured. */
  measured: boolean;
  /** Rows whose usage is unknown, out of the total. Drives the caveat line. */
  unknownWorkloads: number;
  totalWorkloads: number;
  /** True when at least one node had no rate, so some waste has no price. */
  partiallyPriced: boolean;
  totals: {
    requests: ResourcePair;
    usage: ResourcePair | null;
    wasted: ResourcePair | null;
    efficiency: Efficiency;
    dailyCost: number | null;
    wastedDailyCost: number | null;
    /** Unallocated node capacity — a different waste from over-requesting. */
    dailyIdleCost: number | null;
    /** Bound-but-unmounted storage — a third kind again. */
    dailyUnattachedStorageCost: number | null;
  };
  namespaces: EfficiencyRow[];
  workloads: EfficiencyRow[];
}

function rowFrom(
  source: WorkloadAllocation | NamespaceAllocation,
  key: string,
  label: string,
  workloadKind: string,
): EfficiencyRow {
  return {
    key,
    label,
    namespace: source.namespace,
    workloadKind,
    podCount: source.podCount,
    requests: source.requests,
    usage: source.usage,
    wasted: source.wasted,
    efficiency: source.efficiency,
    dailyCost: source.dailyCost,
    wastedDailyCost: source.wastedDailyCost,
    unknown: source.usageUnknown,
  };
}

/**
 * Order: worst offenders first, and "worst" means most money burnt.
 *
 * Three tiers, because they are not comparable and pretending otherwise would
 * shuffle rows arbitrarily:
 *
 *  1. Rows with a priced waste figure, descending by that figure. This is the
 *     list someone acts on.
 *  2. Rows measured but unpriced (no node rate) — ranked by wasted CPU cores,
 *     the biggest thing we can honestly compare them by.
 *  3. Rows with no usage data at all, alphabetically. They are not "efficient"
 *     and they are not "wasteful"; they are unmeasured, and burying them at the
 *     bottom is better than ranking them among figures they do not have.
 */
function byWasteDescending(a: EfficiencyRow, b: EfficiencyRow): number {
  const tier = (row: EfficiencyRow) => (row.unknown ? 2 : row.wastedDailyCost != null ? 0 : 1);
  const ta = tier(a);
  const tb = tier(b);
  if (ta !== tb) return ta - tb;
  if (ta === 0)
    return (b.wastedDailyCost ?? 0) - (a.wastedDailyCost ?? 0) || a.key.localeCompare(b.key);
  if (ta === 1)
    return (b.wasted?.cpuCores ?? 0) - (a.wasted?.cpuCores ?? 0) || a.key.localeCompare(b.key);
  return a.key.localeCompare(b.key);
}

/**
 * Build the report from an allocation.
 *
 * `namespaceFilter` scopes it to one namespace, which is what the namespace
 * detail view renders — the same report, the same ordering, fewer rows.
 */
export function buildEfficiencyReport(
  cluster: ClusterAllocation,
  generatedAt: string,
  namespaceFilter?: string,
): EfficiencyReport {
  const namespaces = cluster.namespaces
    .filter((ns) => namespaceFilter == null || ns.namespace === namespaceFilter)
    .map((ns) => rowFrom(ns, ns.namespace, ns.namespace, ""));

  const workloads = cluster.workloads
    .filter((w) => namespaceFilter == null || w.namespace === namespaceFilter)
    .map((w) => rowFrom(w, w.key, w.workload, w.workloadKind));

  namespaces.sort(byWasteDescending);
  workloads.sort(byWasteDescending);

  // Totals are summed from the rows in scope, not read off the cluster, so a
  // namespace-scoped report totals that namespace rather than the cluster.
  const scoped = namespaceFilter == null;
  const totalRequests = namespaces.reduce(
    (acc, r) => ({
      cpuCores: acc.cpuCores + r.requests.cpuCores,
      memoryBytes: acc.memoryBytes + r.requests.memoryBytes,
    }),
    { cpuCores: 0, memoryBytes: 0 },
  );
  const anyUsage = namespaces.some((r) => r.usage != null);
  const totalUsage = anyUsage
    ? namespaces.reduce(
        (acc, r) => ({
          cpuCores: acc.cpuCores + (r.usage?.cpuCores ?? 0),
          memoryBytes: acc.memoryBytes + (r.usage?.memoryBytes ?? 0),
        }),
        { cpuCores: 0, memoryBytes: 0 },
      )
    : null;
  const totalWasted = anyUsage
    ? namespaces.reduce(
        (acc, r) => ({
          cpuCores: acc.cpuCores + (r.wasted?.cpuCores ?? 0),
          memoryBytes: acc.memoryBytes + (r.wasted?.memoryBytes ?? 0),
        }),
        { cpuCores: 0, memoryBytes: 0 },
      )
    : null;

  const dailyCost = sumOrNull(namespaces.map((r) => r.dailyCost));
  const wastedDailyCost = sumOrNull(namespaces.map((r) => r.wastedDailyCost));

  return {
    generatedAt,
    currency: cluster.currency,
    measured: cluster.basis === "usage-or-requests",
    unknownWorkloads: workloads.filter((w) => w.unknown).length,
    totalWorkloads: workloads.length,
    partiallyPriced: cluster.unpricedNodes.length > 0,
    totals: {
      requests: totalRequests,
      usage: totalUsage,
      wasted: totalWasted,
      efficiency: {
        cpu: ratioOrNull(totalUsage?.cpuCores, totalRequests.cpuCores),
        memory: ratioOrNull(totalUsage?.memoryBytes, totalRequests.memoryBytes),
      },
      dailyCost,
      wastedDailyCost,
      // Idle and unattached storage are cluster-wide facts, not a namespace's,
      // so a scoped report omits them rather than repeating the whole cluster's
      // figure under one namespace's heading.
      dailyIdleCost: scoped ? cluster.dailyIdleCost : null,
      dailyUnattachedStorageCost: scoped ? cluster.storage.dailyUnattachedCost : null,
    },
    namespaces,
    workloads,
  };
}

function sumOrNull(values: Array<number | null>): number | null {
  let total = 0;
  let saw = false;
  for (const value of values) {
    if (value == null) continue;
    total += value;
    saw = true;
  }
  return saw ? total : null;
}

function ratioOrNull(used: number | undefined, requested: number): number | null {
  if (used == null || !(requested > 0)) return null;
  return used / requested;
}

/** `18%` — or `unknown`, which is a different thing from `0%`. */
export function formatEfficiencyCell(row: EfficiencyRow, dimension: "cpu" | "memory"): string {
  if (row.unknown) return "unknown";
  const value = row.efficiency[dimension];
  if (value == null) return "—";
  return `${Math.round(value * 100)}%`;
}

/** `1.5 CPU · 3.2Gi`, or `unknown` where nothing measured the row. */
export function formatPair(pair: ResourcePair | null, unknown: boolean): string {
  if (unknown) return "unknown";
  if (!pair) return "—";
  return `${formatCores(pair.cpuCores)} CPU · ${formatMemory(pair.memoryBytes)}`;
}

/** `$4.20/day`, or an em dash when there is no money to show. */
export function formatDaily(amount: number | null, currency: string): string {
  return amount == null ? "—" : `${formatMoney(amount, currency)}/day`;
}

/**
 * The report as plain text.
 *
 * This is the "share" half of the feature. A table on a screen cannot be pasted
 * into a Jira ticket or a Slack thread, and screenshots of numbers go stale
 * without saying so — a fixed-width block carries the figures, the caveats and
 * the timestamp together, which is what makes it safe to forward.
 */
export function formatEfficiencyReportText(report: EfficiencyReport, title: string): string {
  const lines: string[] = [];
  const money = (value: number | null) => formatDaily(value, report.currency);

  lines.push(title);
  lines.push("=".repeat(title.length));
  lines.push(`Generated ${report.generatedAt}`);
  lines.push("");

  lines.push("SUMMARY");
  lines.push(`  Requested            ${formatPair(report.totals.requests, false)}`);
  lines.push(`  Used                 ${formatPair(report.totals.usage, !report.measured)}`);
  lines.push(`  Unused (requested)   ${formatPair(report.totals.wasted, !report.measured)}`);
  lines.push(`  Attributed cost      ${money(report.totals.dailyCost)}`);
  lines.push(`  Cost of unused       ${money(report.totals.wastedDailyCost)}`);
  if (report.totals.dailyIdleCost != null) {
    lines.push(`  Idle node capacity   ${money(report.totals.dailyIdleCost)}`);
  }
  if (report.totals.dailyUnattachedStorageCost != null) {
    lines.push(`  Unattached storage   ${money(report.totals.dailyUnattachedStorageCost)}`);
  }
  lines.push("");

  const section = (heading: string, rows: EfficiencyRow[], showKind: boolean) => {
    if (rows.length === 0) return;
    lines.push(heading);
    lines.push(
      `  ${pad("NAME", 34)}${showKind ? pad("KIND", 13) : ""}${pad("CPU", 9)}${pad("MEM", 9)}${pad("WASTED/DAY", 13)}COST/DAY`,
    );
    for (const row of rows) {
      const name = showKind ? `${row.namespace}/${row.label}` : row.label;
      lines.push(
        `  ${pad(name, 34)}${showKind ? pad(row.workloadKind, 13) : ""}` +
          `${pad(formatEfficiencyCell(row, "cpu"), 9)}${pad(formatEfficiencyCell(row, "memory"), 9)}` +
          `${pad(money(row.wastedDailyCost), 13)}${money(row.dailyCost)}`,
      );
    }
    lines.push("");
  };

  section("BY NAMESPACE (worst first)", report.namespaces, false);
  section("BY WORKLOAD (worst first)", report.workloads, true);

  lines.push("NOTES");
  lines.push("  Derived allocation, not a billed amount. The cluster's money is invoiced to the");
  lines.push("  cloud account that owns the nodes; this is that bill, re-cut.");
  if (!report.measured) {
    lines.push("  metrics-server is not reporting, so nothing here is measured — every efficiency");
    lines.push("  figure reads 'unknown' rather than being assumed.");
  } else if (report.unknownWorkloads > 0) {
    lines.push(
      `  ${report.unknownWorkloads} of ${report.totalWorkloads} workloads have no usage data and read 'unknown'.`,
    );
  }
  if (report.partiallyPriced) {
    lines.push("  Some nodes have no hourly rate, so their workloads show waste without money.");
  }
  lines.push(`  ${RIGHTSIZING_NOTE}`);

  return lines.join("\n");
}

/** Left-align in a fixed-width column, never truncating below one space. */
function pad(text: string, width: number): string {
  return text.length >= width ? `${text} ` : text.padEnd(width);
}
