/**
 * Kubernetes efficiency reports: saved views over the Kubernetes plugin's
 * derived cost rows that say how much of a cluster's money bought capacity
 * something actually used.
 *
 * ## Where the numbers come from
 *
 * The Kubernetes plugin allocates each cluster's node, disk, load balancer and
 * control-plane price to workloads (see `plugin-kubernetes/src/cost-model.ts`)
 * and writes the result as daily cost rows. Every row carries two reserved
 * tags that make this report a query over stored data rather than a live call
 * into a cluster:
 *
 * - `k8s_resource`: what the money bought. `cpu`, `memory`, `gpu`, `storage`,
 *   `network` (load balancers) or `control_plane`.
 * - `k8s_usage`: whether it was used.
 *   - `used`: capacity a pod measurably used (metrics-server CPU and memory,
 *     DCGM or AMD exporter GPU busy time), plus mounted volumes and
 *     provisioned load balancers, whose usage signal is attachment.
 *   - `unused`: requested but measured unused. A pod is charged for
 *     `max(request, usage)`; this is the part above its usage.
 *   - `unmeasured`: allocated to a workload with no usage data (no
 *     metrics-server, a time-sliced GPU). Never counted as used or unused.
 *   - `idle`: capacity nobody requested: unrequested node CPU and memory,
 *     unrequested GPUs, bound volumes nothing mounts.
 *   - `overhead`: system-reserved node capacity and the managed control-plane
 *     fee. Real money that no workload can use.
 *
 * Rows written before those tags existed are classified from their service
 * (`kubernetes-idle` is idle, `kubernetes-workload` is unmeasured compute, …),
 * see {@link classifyKubernetesCostRow}; their CPU and memory were not yet
 * written apart, so they report as the `compute` category.
 *
 * ## Efficiency, precisely
 *
 * - **Total basis** (`basis: "total"`, the cluster view):
 *   `efficiency = used / (total - unmeasured)`. Idle capacity and overhead
 *   count against it: this is "of every measured dollar the cluster cost, how
 *   much bought something used".
 * - **Allocated basis** (`basis: "allocated"`, the workload view):
 *   `efficiency = used / (used + unused)`. Only what workloads reserved: "of
 *   what teams asked for, how much did they use".
 *
 * Unmeasured money is left out of both the numerator and the denominator, and
 * `measuredShare` says how much of the denominator's universe was measured.
 * When nothing was measured the efficiency is `null`, never `0`: "we do not
 * know" is not "nothing was used".
 *
 * ## Idle handling
 *
 * Idle and overhead money has no namespace, workload or pod label. With
 * `idle: "separate"` it is its own rows ("Idle capacity", "Cluster overhead"),
 * which is what keeps a team's number meaning "what this team asked for".
 * With `idle: "spread"` it is shared, per cluster and per period, across that
 * cluster's groups in proportion to what each was allocated, so a team's row
 * reads as a fully loaded cost. Totals are identical either way; a grouping
 * where idle money already has a value (cluster, node pool, category) keeps it
 * in its own group in both modes.
 *
 * Pure and dependency-free, like the rest of client-core: the server's scan
 * hands back rows of {@link KubernetesEfficiencyScanRow} and everything else
 * (classification, idle spreading, efficiency, CSV) happens here, so web,
 * desktop, mobile and the CLI agree on every figure.
 */

import type { CostDateRange, CostFilter } from "./costs";
import { resolveCostDateRange } from "./costs";
import type { CloudFetch } from "./fetch";

/** The plugin whose rows these reports read. */
export const KUBERNETES_COST_PLUGIN_ID = "kubernetes";

/** Tag naming the kind of capacity a Kubernetes cost row's money bought. */
export const K8S_RESOURCE_TAG = "k8s_resource";
/** Tag naming whether that capacity was used. */
export const K8S_USAGE_TAG = "k8s_usage";

/**
 * Cost categories. `compute` only ever appears for rows collected before CPU
 * and memory were written apart.
 */
export const K8S_COST_CATEGORIES = [
  "cpu",
  "memory",
  "gpu",
  "storage",
  "network",
  "control_plane",
  "compute",
] as const;
export type K8sCostCategory = (typeof K8S_COST_CATEGORIES)[number];

export const K8S_COST_CATEGORY_LABELS: Record<K8sCostCategory, string> = {
  cpu: "CPU",
  memory: "Memory",
  gpu: "GPU",
  storage: "Storage",
  network: "Network",
  control_plane: "Control plane",
  compute: "CPU and memory (combined)",
};

export const K8S_USAGE_STATES = ["used", "unused", "unmeasured", "idle", "overhead"] as const;
export type K8sUsageState = (typeof K8S_USAGE_STATES)[number];

export const K8S_USAGE_STATE_LABELS: Record<K8sUsageState, string> = {
  used: "Used",
  unused: "Requested, unused",
  unmeasured: "Unmeasured",
  idle: "Idle",
  overhead: "Overhead",
};

/**
 * One colour per usage state, shared by web, desktop and mobile so a stacked
 * bar reads the same everywhere. Used is green and the two kinds of waste
 * warm; unmeasured and overhead are neutral because neither is a finding.
 */
export const K8S_USAGE_STATE_COLORS: Record<K8sUsageState, string> = {
  used: "#34d399",
  unused: "#fbbf24",
  unmeasured: "#9ca3af",
  idle: "#f87171",
  overhead: "#64748b",
};

export const K8S_EFFICIENCY_GROUP_BYS = [
  "cluster",
  "namespace",
  "workload",
  "label",
  "node_pool",
  "category",
] as const;
export type K8sEfficiencyGroupBy = (typeof K8S_EFFICIENCY_GROUP_BYS)[number];

export const K8S_EFFICIENCY_GROUP_BY_LABELS: Record<K8sEfficiencyGroupBy, string> = {
  cluster: "Cluster",
  namespace: "Namespace",
  workload: "Workload",
  label: "Label",
  node_pool: "Node pool",
  category: "Cost category",
};

export const K8S_EFFICIENCY_GRANULARITIES = ["day", "week", "month"] as const;
export type K8sEfficiencyGranularity = (typeof K8S_EFFICIENCY_GRANULARITIES)[number];

export const K8S_EFFICIENCY_GRANULARITY_LABELS: Record<K8sEfficiencyGranularity, string> = {
  day: "Daily",
  week: "Weekly",
  month: "Monthly",
};

export const K8S_IDLE_MODES = ["separate", "spread"] as const;
export type K8sIdleMode = (typeof K8S_IDLE_MODES)[number];

export const K8S_EFFICIENCY_BASES = ["total", "allocated"] as const;
export type K8sEfficiencyBasis = (typeof K8S_EFFICIENCY_BASES)[number];

/** Filter dimensions a report accepts: clusters, regions and tags (labels). */
export const K8S_EFFICIENCY_FILTER_DIMENSIONS = ["account", "region", "tag"] as const;

/** Bounds the API enforces. */
export const K8S_EFFICIENCY_LIMITS = {
  maxNameLength: 120,
  maxDescriptionLength: 2000,
  maxFilters: 20,
  maxFilterValues: 200,
  maxRangeDays: 366,
} as const;

/**
 * A saved report's definition. Stored as jsonb and validated by the zod
 * schema in `ui/src/cost/config.ts`, which is checked against this shape.
 */
export interface KubernetesEfficiencyConfig {
  version: 1;
  dateRange: CostDateRange;
  granularity: K8sEfficiencyGranularity;
  /**
   * AND-composed, on the cost vocabulary: `account` (cluster), `region` and
   * `tag` (namespace, workload, workload_kind, node_pool, capacity_type, and
   * the `k8s_pod_label:`/`k8s_node_label:`/`k8s_pvc_label:` labels).
   */
  filters: CostFilter[];
  groupBy: K8sEfficiencyGroupBy;
  /** The tag key to group by when `groupBy` is `label`. */
  groupByLabelKey?: string | undefined;
  /** Cost categories to include; absent or empty is every category. */
  categories?: K8sCostCategory[] | undefined;
  idle: K8sIdleMode;
  basis: K8sEfficiencyBasis;
}

export const DEFAULT_K8S_EFFICIENCY_CONFIG: KubernetesEfficiencyConfig = {
  version: 1,
  dateRange: { kind: "relative", preset: "30d" },
  granularity: "day",
  filters: [],
  groupBy: "namespace",
  idle: "separate",
  basis: "total",
};

/** Create/update payload (POST/PUT /k8s-efficiency-reports). */
export interface KubernetesEfficiencyReportInput {
  name: string;
  description?: string | undefined;
  config: KubernetesEfficiencyConfig;
  /** Cost-report folder to file it under; null is the top level. */
  folderId?: string | null | undefined;
}

/** A saved report as the API returns it. */
export interface KubernetesEfficiencyReport {
  id: string;
  name: string;
  description: string | null;
  config: KubernetesEfficiencyConfig;
  folderId: string | null;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One row of the server's aggregate scan over `cost_daily`. */
export interface KubernetesEfficiencyScanRow {
  /** Bucket start, `YYYY-MM-DD`. */
  bucket: string;
  /** The group-by value; `""` when the row has none (idle has no namespace). */
  group: string;
  accountId: string;
  service: string;
  /** Raw `k8s_resource` tag; `""` on rows written before it existed. */
  resource: string;
  /** Raw `k8s_usage` tag; `""` on rows written before it existed. */
  usage: string;
  currency: string;
  amount: number;
}

/** Money by usage state. */
export interface KubernetesEfficiencyAmounts {
  total: number;
  used: number;
  unused: number;
  unmeasured: number;
  idle: number;
  overhead: number;
}

/** {@link KubernetesEfficiencyAmounts} plus what is derived from them. */
export interface KubernetesEfficiencyFigures extends KubernetesEfficiencyAmounts {
  /** What workloads held: used + unused + unmeasured. */
  allocated: number;
  /** See the module doc for both bases. `null` when nothing was measured. */
  efficiency: number | null;
  /** Share of the efficiency denominator's universe that was measured, 0..1. */
  measuredShare: number | null;
}

export type KubernetesEfficiencyRowKind = "group" | "idle" | "overhead" | "unattributed";

export interface KubernetesEfficiencyCategoryFigures {
  category: K8sCostCategory;
  figures: KubernetesEfficiencyFigures;
}

export interface KubernetesEfficiencyPoint extends KubernetesEfficiencyFigures {
  bucket: string;
}

export interface KubernetesEfficiencyRow {
  /** The group value, or `__idle__` / `__overhead__` / `__unattributed__`. */
  key: string;
  kind: KubernetesEfficiencyRowKind;
  /** Display name: the cluster's name for a cluster key, else the key. */
  label: string;
  figures: KubernetesEfficiencyFigures;
  categories: KubernetesEfficiencyCategoryFigures[];
  points: KubernetesEfficiencyPoint[];
}

/** Everything in one currency. Mixed-currency clusters get one each. */
export interface KubernetesEfficiencyCurrencyResult {
  currency: string;
  totals: KubernetesEfficiencyFigures;
  categories: KubernetesEfficiencyCategoryFigures[];
  points: KubernetesEfficiencyPoint[];
  rows: KubernetesEfficiencyRow[];
}

export interface KubernetesEfficiencyResult {
  from: string;
  to: string;
  granularity: K8sEfficiencyGranularity;
  groupBy: K8sEfficiencyGroupBy;
  groupByLabelKey?: string | undefined;
  idle: K8sIdleMode;
  basis: K8sEfficiencyBasis;
  /** Every bucket start in the window, so a gap draws as a gap. */
  buckets: string[];
  currencies: KubernetesEfficiencyCurrencyResult[];
  /**
   * True when some rows predate the resource and usage tags: their CPU and
   * memory are reported together as `compute`, and their compute as
   * unmeasured.
   */
  includesLegacyRows: boolean;
}

/** `POST /k8s-efficiency-reports/:id/run`. */
export interface KubernetesEfficiencyRunResult {
  reportId: string;
  name: string;
  result: KubernetesEfficiencyResult;
}

/* ------------------------------------------------------------------ *
 * Classification
 * ------------------------------------------------------------------ */

const IDLE_SERVICES = new Set([
  "kubernetes-idle",
  "kubernetes-gpu-idle",
  "kubernetes-storage-idle",
]);
const OVERHEAD_SERVICES = new Set(["kubernetes-system-reserved", "kubernetes-control-plane"]);

function isCategory(value: string): value is K8sCostCategory {
  return (K8S_COST_CATEGORIES as readonly string[]).includes(value);
}

function isUsageState(value: string): value is K8sUsageState {
  return (K8S_USAGE_STATES as readonly string[]).includes(value);
}

/**
 * A row's category and usage state: its tags when it carries them, otherwise
 * derived from its service, the only thing rows collected before the tags
 * existed say about themselves.
 */
export function classifyKubernetesCostRow(
  service: string,
  resourceTag: string,
  usageTag: string,
): { category: K8sCostCategory; state: K8sUsageState; legacy: boolean } {
  const legacy = !isCategory(resourceTag) || !isUsageState(usageTag);
  const category: K8sCostCategory = isCategory(resourceTag)
    ? resourceTag
    : service === "kubernetes-gpu" || service === "kubernetes-gpu-idle"
      ? "gpu"
      : service === "kubernetes-storage" || service === "kubernetes-storage-idle"
        ? "storage"
        : service === "kubernetes-load-balancer"
          ? "network"
          : service === "kubernetes-control-plane"
            ? "control_plane"
            : "compute";
  const state: K8sUsageState = isUsageState(usageTag)
    ? usageTag
    : IDLE_SERVICES.has(service)
      ? "idle"
      : OVERHEAD_SERVICES.has(service)
        ? "overhead"
        : service === "kubernetes-storage" || service === "kubernetes-load-balancer"
          ? "used"
          : "unmeasured";
  return { category, state, legacy };
}

/* ------------------------------------------------------------------ *
 * Figures
 * ------------------------------------------------------------------ */

/** Below this, a denominator is treated as nothing (float dust from splits). */
const EPSILON = 1e-9;

function emptyAmounts(): KubernetesEfficiencyAmounts {
  return { total: 0, used: 0, unused: 0, unmeasured: 0, idle: 0, overhead: 0 };
}

function addInto(
  into: KubernetesEfficiencyAmounts,
  state: K8sUsageState,
  amount: number,
): KubernetesEfficiencyAmounts {
  into[state] += amount;
  into.total += amount;
  return into;
}

function addAmounts(into: KubernetesEfficiencyAmounts, from: KubernetesEfficiencyAmounts): void {
  for (const state of K8S_USAGE_STATES) into[state] += from[state];
  into.total += from.total;
}

/**
 * Efficiency of a set of amounts on a basis. `null` when there is nothing
 * measured to divide by; see the module doc for the definitions.
 */
export function kubernetesEfficiency(
  amounts: KubernetesEfficiencyAmounts,
  basis: K8sEfficiencyBasis,
): number | null {
  const denominator =
    basis === "allocated" ? amounts.used + amounts.unused : amounts.total - amounts.unmeasured;
  if (denominator <= EPSILON) return null;
  return Math.min(1, Math.max(0, amounts.used / denominator));
}

/** Share of the basis' universe that was measured. `null` when it is empty. */
function measuredShare(
  amounts: KubernetesEfficiencyAmounts,
  basis: K8sEfficiencyBasis,
): number | null {
  const universe =
    basis === "allocated" ? amounts.used + amounts.unused + amounts.unmeasured : amounts.total;
  if (universe <= EPSILON) return null;
  const measured =
    basis === "allocated" ? amounts.used + amounts.unused : amounts.total - amounts.unmeasured;
  return Math.min(1, Math.max(0, measured / universe));
}

export function kubernetesEfficiencyFigures(
  amounts: KubernetesEfficiencyAmounts,
  basis: K8sEfficiencyBasis,
): KubernetesEfficiencyFigures {
  return {
    ...amounts,
    allocated: amounts.used + amounts.unused + amounts.unmeasured,
    efficiency: kubernetesEfficiency(amounts, basis),
    measuredShare: measuredShare(amounts, basis),
  };
}

/* ------------------------------------------------------------------ *
 * Config helpers
 * ------------------------------------------------------------------ */

/** The window a config covers, anchored to `today` (UTC). */
export function resolveKubernetesEfficiencyRange(
  config: Pick<KubernetesEfficiencyConfig, "dateRange">,
  today = new Date(),
): { from: string; to: string } {
  return resolveCostDateRange(config.dateRange, today);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * Why a config cannot run, or `null` when it can. One rule set for the API
 * (zod `superRefine`), both editors and the CLI, so the UI disables exactly
 * what the server refuses.
 */
export function kubernetesEfficiencyConfigProblem(
  config: KubernetesEfficiencyConfig,
  today = new Date(),
): string | null {
  if (config.groupBy === "label") {
    if (!config.groupByLabelKey?.trim()) return "Grouping by label needs a label key.";
  } else if (config.groupByLabelKey !== undefined) {
    return "A label key is only used when grouping by label.";
  }
  if (config.filters.length > K8S_EFFICIENCY_LIMITS.maxFilters) {
    return `At most ${K8S_EFFICIENCY_LIMITS.maxFilters} filters.`;
  }
  for (const f of config.filters) {
    if (!(K8S_EFFICIENCY_FILTER_DIMENSIONS as readonly string[]).includes(f.dimension)) {
      return `Kubernetes efficiency reports filter by cluster, region or label, not ${f.dimension}.`;
    }
    if (f.dimension === "tag" && !f.tagKey?.trim()) return "A label filter needs a label key.";
    if (f.values.length === 0) return "A filter needs at least one value.";
    if (f.values.length > K8S_EFFICIENCY_LIMITS.maxFilterValues) {
      return `At most ${K8S_EFFICIENCY_LIMITS.maxFilterValues} values per filter.`;
    }
  }
  const categories = config.categories ?? [];
  if (new Set(categories).size !== categories.length) return "A category is listed twice.";
  const { from, to } = resolveKubernetesEfficiencyRange(config, today);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return "Dates must be YYYY-MM-DD.";
  }
  if (from > to) return "The start date is after the end date.";
  if (daysBetween(from, to) + 1 > K8S_EFFICIENCY_LIMITS.maxRangeDays) {
    return `A report covers at most ${K8S_EFFICIENCY_LIMITS.maxRangeDays} days.`;
  }
  return null;
}

/** Trim and bound a report name; `null` when it is not usable. */
export function normalizeKubernetesEfficiencyReportName(raw: string): string | null {
  const name = raw.trim();
  if (!name || name.length > K8S_EFFICIENCY_LIMITS.maxNameLength) return null;
  return name;
}

/* ------------------------------------------------------------------ *
 * Buckets
 * ------------------------------------------------------------------ */

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Start of the bucket a day falls in: Monday-start weeks, calendar months. */
export function kubernetesEfficiencyBucketStart(
  day: string,
  granularity: K8sEfficiencyGranularity,
): string {
  if (granularity === "day") return day;
  if (granularity === "month") return `${day.slice(0, 7)}-01`;
  const ms = Date.parse(`${day}T00:00:00Z`);
  const weekday = (new Date(ms).getUTCDay() + 6) % 7; // Monday = 0
  return isoDay(ms - weekday * 86_400_000);
}

/** Every bucket start from `from` to `to`, inclusive. */
export function kubernetesEfficiencyBuckets(
  from: string,
  to: string,
  granularity: K8sEfficiencyGranularity,
): string[] {
  const out: string[] = [];
  let cursor = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(cursor) || !Number.isFinite(end)) return out;
  let last = "";
  // At most a year and a bit of days; bounded by the API's range cap.
  for (let i = 0; cursor <= end && i < 4000; i++) {
    const bucket = kubernetesEfficiencyBucketStart(isoDay(cursor), granularity);
    if (bucket !== last) {
      out.push(bucket);
      last = bucket;
    }
    cursor += 86_400_000;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Assembly
 * ------------------------------------------------------------------ */

const SYNTHETIC_KEYS: Record<Exclude<KubernetesEfficiencyRowKind, "group">, string> = {
  idle: "__idle__",
  overhead: "__overhead__",
  unattributed: "__unattributed__",
};

export const K8S_EFFICIENCY_ROW_KIND_LABELS: Record<KubernetesEfficiencyRowKind, string> = {
  group: "",
  idle: "Idle capacity",
  overhead: "Cluster overhead",
  unattributed: "(no value)",
};

interface Accumulator {
  key: string;
  kind: KubernetesEfficiencyRowKind;
  byCategory: Map<K8sCostCategory, KubernetesEfficiencyAmounts>;
  byBucket: Map<string, KubernetesEfficiencyAmounts>;
}

function accumulatorFor(
  map: Map<string, Accumulator>,
  key: string,
  kind: KubernetesEfficiencyRowKind,
) {
  let acc = map.get(key);
  if (!acc) {
    acc = { key, kind, byCategory: new Map(), byBucket: new Map() };
    map.set(key, acc);
  }
  return acc;
}

function bump(
  acc: Accumulator,
  category: K8sCostCategory,
  bucket: string,
  state: K8sUsageState,
  amount: number,
): void {
  addInto(acc.byCategory.get(category) ?? setGet(acc.byCategory, category), state, amount);
  addInto(acc.byBucket.get(bucket) ?? setGet(acc.byBucket, bucket), state, amount);
}

function setGet<K>(map: Map<K, KubernetesEfficiencyAmounts>, key: K): KubernetesEfficiencyAmounts {
  const fresh = emptyAmounts();
  map.set(key, fresh);
  return fresh;
}

interface Classified {
  bucket: string;
  group: string;
  accountId: string;
  category: K8sCostCategory;
  state: K8sUsageState;
  amount: number;
}

export interface BuildKubernetesEfficiencyOptions {
  config: KubernetesEfficiencyConfig;
  from: string;
  to: string;
  /** Display names for group keys (cluster account id → name). */
  labels?: Readonly<Record<string, string>> | undefined;
}

/**
 * Turn the server's scan into the report: classify each row, apply the
 * category filter, share idle money out when asked to, and total everything
 * per row, per category and per bucket, one block per currency.
 */
export function buildKubernetesEfficiencyResult(
  scan: readonly KubernetesEfficiencyScanRow[],
  options: BuildKubernetesEfficiencyOptions,
): KubernetesEfficiencyResult {
  const { config, from, to } = options;
  const wanted =
    config.categories && config.categories.length > 0 ? new Set(config.categories) : null;
  let includesLegacyRows = false;

  const byCurrency = new Map<string, Classified[]>();
  for (const row of scan) {
    if (!Number.isFinite(row.amount) || row.amount === 0) continue;
    const { category, state, legacy } = classifyKubernetesCostRow(
      row.service,
      row.resource,
      row.usage,
    );
    if (wanted && !wanted.has(category)) continue;
    if (legacy) includesLegacyRows = true;
    const group = config.groupBy === "category" ? category : row.group;
    const list = byCurrency.get(row.currency) ?? [];
    list.push({
      bucket: row.bucket,
      group,
      accountId: row.accountId,
      category,
      state,
      amount: row.amount,
    });
    byCurrency.set(row.currency, list);
  }

  const currencies: KubernetesEfficiencyCurrencyResult[] = [];
  for (const [currency, rows] of [...byCurrency.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    currencies.push(assembleCurrency(currency, rows, options));
  }

  return {
    from,
    to,
    granularity: config.granularity,
    groupBy: config.groupBy,
    ...(config.groupBy === "label" && config.groupByLabelKey
      ? { groupByLabelKey: config.groupByLabelKey }
      : {}),
    idle: config.idle,
    basis: config.basis,
    buckets: kubernetesEfficiencyBuckets(from, to, config.granularity),
    currencies,
    includesLegacyRows,
  };
}

function assembleCurrency(
  currency: string,
  rows: Classified[],
  options: BuildKubernetesEfficiencyOptions,
): KubernetesEfficiencyCurrencyResult {
  const { config } = options;
  const groups = new Map<string, Accumulator>();
  const unassigned: Classified[] = [];

  for (const row of rows) {
    if (row.group !== "") {
      bump(
        accumulatorFor(groups, row.group, "group"),
        row.category,
        row.bucket,
        row.state,
        row.amount,
      );
    } else if (row.state === "idle" || row.state === "overhead") {
      unassigned.push(row);
    } else {
      // Allocated money the grouping has no value for (a shared volume when
      // grouping by workload, compute from a pod without the label): its own
      // row, never spread, because it is somebody's, just not nameable here.
      bump(
        accumulatorFor(groups, SYNTHETIC_KEYS.unattributed, "unattributed"),
        row.category,
        row.bucket,
        row.state,
        row.amount,
      );
    }
  }

  if (config.idle === "spread") {
    // Weights: what each group was allocated, per cluster and bucket. Spread
    // within the cluster that paid for the idle capacity, never across
    // clusters, and within the period it was idle in.
    const weights = new Map<string, Map<string, number>>();
    for (const row of rows) {
      if (row.group === "") continue;
      if (row.state !== "used" && row.state !== "unused" && row.state !== "unmeasured") continue;
      const slot = `${row.accountId}\u0000${row.bucket}`;
      const byGroup = weights.get(slot) ?? new Map<string, number>();
      byGroup.set(row.group, (byGroup.get(row.group) ?? 0) + row.amount);
      weights.set(slot, byGroup);
    }
    for (const row of unassigned) {
      const byGroup = weights.get(`${row.accountId}\u0000${row.bucket}`);
      const total = byGroup ? [...byGroup.values()].reduce((a, b) => a + b, 0) : 0;
      if (!byGroup || total <= EPSILON) {
        // Nobody in this cluster held anything that period: nothing to share
        // it with, so it stays visible as its own row.
        const kind = row.state === "idle" ? "idle" : "overhead";
        bump(
          accumulatorFor(groups, SYNTHETIC_KEYS[kind], kind),
          row.category,
          row.bucket,
          row.state,
          row.amount,
        );
        continue;
      }
      for (const [group, weight] of byGroup) {
        bump(
          accumulatorFor(groups, group, "group"),
          row.category,
          row.bucket,
          row.state,
          (row.amount * weight) / total,
        );
      }
    }
  } else {
    for (const row of unassigned) {
      const kind = row.state === "idle" ? "idle" : "overhead";
      bump(
        accumulatorFor(groups, SYNTHETIC_KEYS[kind], kind),
        row.category,
        row.bucket,
        row.state,
        row.amount,
      );
    }
  }

  const totalsAmounts = emptyAmounts();
  const totalsByCategory = new Map<K8sCostCategory, KubernetesEfficiencyAmounts>();
  const totalsByBucket = new Map<string, KubernetesEfficiencyAmounts>();
  const resultRows: KubernetesEfficiencyRow[] = [];
  for (const acc of groups.values()) {
    const amounts = emptyAmounts();
    for (const [category, a] of acc.byCategory) {
      addAmounts(amounts, a);
      addAmounts(totalsByCategory.get(category) ?? setGet(totalsByCategory, category), a);
    }
    for (const [bucket, a] of acc.byBucket) {
      addAmounts(totalsByBucket.get(bucket) ?? setGet(totalsByBucket, bucket), a);
    }
    addAmounts(totalsAmounts, amounts);
    resultRows.push({
      key: acc.key,
      kind: acc.kind,
      label:
        acc.kind === "group"
          ? (options.labels?.[acc.key] ?? acc.key)
          : K8S_EFFICIENCY_ROW_KIND_LABELS[acc.kind],
      figures: kubernetesEfficiencyFigures(amounts, config.basis),
      categories: categoryFigures(acc.byCategory, config.basis),
      points: bucketPoints(acc.byBucket, config.basis),
    });
  }

  // Biggest first, the synthetic rows after every real group.
  const order: Record<KubernetesEfficiencyRowKind, number> = {
    group: 0,
    unattributed: 1,
    idle: 2,
    overhead: 3,
  };
  resultRows.sort(
    (a, b) =>
      order[a.kind] - order[b.kind] ||
      b.figures.total - a.figures.total ||
      a.label.localeCompare(b.label),
  );

  return {
    currency,
    totals: kubernetesEfficiencyFigures(totalsAmounts, config.basis),
    categories: categoryFigures(totalsByCategory, config.basis),
    points: bucketPoints(totalsByBucket, config.basis),
    rows: resultRows,
  };
}

function categoryFigures(
  map: Map<K8sCostCategory, KubernetesEfficiencyAmounts>,
  basis: K8sEfficiencyBasis,
): KubernetesEfficiencyCategoryFigures[] {
  return K8S_COST_CATEGORIES.filter((c) => map.has(c)).map((category) => ({
    category,
    figures: kubernetesEfficiencyFigures(map.get(category)!, basis),
  }));
}

function bucketPoints(
  map: Map<string, KubernetesEfficiencyAmounts>,
  basis: K8sEfficiencyBasis,
): KubernetesEfficiencyPoint[] {
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([bucket, amounts]) => ({ bucket, ...kubernetesEfficiencyFigures(amounts, basis) }));
}

/* ------------------------------------------------------------------ *
 * Export
 * ------------------------------------------------------------------ */

function csvCell(value: string | number | null): string {
  if (value === null) return "";
  const text = typeof value === "number" ? String(Number(value.toFixed(6))) : value;
  // Formula-leading characters are neutralised so a spreadsheet never runs a
  // label as a formula.
  const safe = /^[=+\-@\t\r]/.test(text) && typeof value === "string" ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

const CSV_AMOUNT_COLUMNS = [
  "total",
  "used",
  "unused",
  "unmeasured",
  "idle",
  "overhead",
  "allocated",
] as const;

/** One flat record per row, category and (optionally) bucket. */
export interface KubernetesEfficiencyExportRecord {
  currency: string;
  /** Bucket start; `""` on whole-window records. */
  period: string;
  group: string;
  groupKind: KubernetesEfficiencyRowKind | "total";
  /** `""` on all-category records. */
  category: K8sCostCategory | "";
  total: number;
  used: number;
  unused: number;
  unmeasured: number;
  idle: number;
  overhead: number;
  allocated: number;
  efficiency: number | null;
  measuredShare: number | null;
}

function record(
  currency: string,
  period: string,
  group: string,
  groupKind: KubernetesEfficiencyExportRecord["groupKind"],
  category: K8sCostCategory | "",
  f: KubernetesEfficiencyFigures,
): KubernetesEfficiencyExportRecord {
  return {
    currency,
    period,
    group,
    groupKind,
    category,
    total: f.total,
    used: f.used,
    unused: f.unused,
    unmeasured: f.unmeasured,
    idle: f.idle,
    overhead: f.overhead,
    allocated: f.allocated,
    efficiency: f.efficiency,
    measuredShare: f.measuredShare,
  };
}

/**
 * The flat records an export writes: per row (and per category within it),
 * then the report total, and, with `perPeriod`, each row's per-bucket figures.
 */
export function kubernetesEfficiencyExportRecords(
  result: KubernetesEfficiencyResult,
  opts: { perPeriod?: boolean } = {},
): KubernetesEfficiencyExportRecord[] {
  const out: KubernetesEfficiencyExportRecord[] = [];
  for (const block of result.currencies) {
    for (const row of block.rows) {
      out.push(record(block.currency, "", row.label, row.kind, "", row.figures));
      for (const c of row.categories) {
        out.push(record(block.currency, "", row.label, row.kind, c.category, c.figures));
      }
    }
    out.push(record(block.currency, "", "Total", "total", "", block.totals));
    for (const c of block.categories) {
      out.push(record(block.currency, "", "Total", "total", c.category, c.figures));
    }
    if (opts.perPeriod) {
      for (const row of block.rows) {
        for (const p of row.points) {
          out.push(record(block.currency, p.bucket, row.label, row.kind, "", p));
        }
      }
      for (const p of block.points)
        out.push(record(block.currency, p.bucket, "Total", "total", "", p));
    }
  }
  return out;
}

const CSV_HEADER = [
  "currency",
  "period",
  "group",
  "group_kind",
  "category",
  ...CSV_AMOUNT_COLUMNS,
  "efficiency",
  "measured_share",
];

/** CSV of {@link kubernetesEfficiencyExportRecords}. RFC 4180, `\r\n` lines. */
export function kubernetesEfficiencyCsv(
  result: KubernetesEfficiencyResult,
  opts: { perPeriod?: boolean } = {},
): string {
  const lines = [CSV_HEADER.join(",")];
  for (const r of kubernetesEfficiencyExportRecords(result, opts)) {
    lines.push(
      [
        csvCell(r.currency),
        csvCell(r.period),
        csvCell(r.group),
        csvCell(r.groupKind),
        csvCell(r.category),
        ...CSV_AMOUNT_COLUMNS.map((c) => csvCell(r[c])),
        csvCell(r.efficiency),
        csvCell(r.measuredShare),
      ].join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

/** `"62%"`, or `"n/a"` when unmeasured. */
export function formatKubernetesEfficiency(efficiency: number | null): string {
  return efficiency === null ? "n/a" : `${Math.round(efficiency * 100)}%`;
}

/* ------------------------------------------------------------------ *
 * Fetch helpers (mobile, CLI)
 * ------------------------------------------------------------------ */

const BASE = "/k8s-efficiency-reports";

export async function listKubernetesEfficiencyReports(
  api: CloudFetch,
  orgId: string,
): Promise<KubernetesEfficiencyReport[]> {
  return (await api.org<KubernetesEfficiencyReport[]>(orgId, BASE)) ?? [];
}

export async function getKubernetesEfficiencyReport(
  api: CloudFetch,
  orgId: string,
  reportId: string,
): Promise<KubernetesEfficiencyReport | null> {
  return await api.org<KubernetesEfficiencyReport>(
    orgId,
    `${BASE}/${encodeURIComponent(reportId)}`,
  );
}

export async function runKubernetesEfficiencyReport(
  api: CloudFetch,
  orgId: string,
  reportId: string,
): Promise<KubernetesEfficiencyRunResult | null> {
  return await api.org<KubernetesEfficiencyRunResult>(
    orgId,
    `${BASE}/${encodeURIComponent(reportId)}/run`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
  );
}

export async function queryKubernetesEfficiency(
  api: CloudFetch,
  orgId: string,
  config: KubernetesEfficiencyConfig,
): Promise<KubernetesEfficiencyResult | null> {
  return await api.org<KubernetesEfficiencyResult>(orgId, `${BASE}/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ config }),
  });
}
