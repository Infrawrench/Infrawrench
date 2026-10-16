/**
 * Network flow reports: saved, re-runnable views over the network-flow store
 * (`network_flow_daily`), filed and shared like cost reports.
 *
 * The Network tab's feed answers "what is driving our egress bill right now"
 * over one fixed trailing window. A report answers "how much did cross-zone
 * traffic out of this VPC cost, per week, by flow pair" and keeps the question
 * under a name so it can be re-run, shared, exported and managed from
 * Terraform.
 *
 * This module is the contract (types, limits, validation) and every piece of
 * arithmetic a surface could get wrong: bucket assembly, the "everything else"
 * series, sampling shares and the CSV writers. The server, the web and
 * desktop UI and the CLI all import it, so a figure means the same thing
 * everywhere.
 *
 * ─── What the figures are ──────────────────────────────────────────────────
 *
 * - **Bytes** are observed bytes as the flow collector stored them, in decimal
 *   units (GB = 10^9), summed over the window.
 * - **Estimated cost** is those bytes priced at the provider's published list
 *   rate for the boundary they crossed (see `network-flows.ts`). It is always
 *   an estimate and never ties out to the invoice: free allowances, volume
 *   tiers and negotiated rates are invisible to a flow log.
 * - **Sampled share**: a plugin whose flow source samples rather than records
 *   every flow (`networkFlows.sampled`) reports bytes that are already a
 *   scaled-up estimate. Those bytes are counted, never dropped, and every
 *   figure says how much of it came from a sampled source.
 * - **Unattributed** bytes could not be tied to a workload at one end;
 *   **outside top pairs** bytes are the per-day remainder below the stored
 *   pair cap. Both are part of every total and neither is spread across the
 *   itemized pairs.
 */

import type { NetworkFlowScope } from "@infrawrench/plugin-base";

import type { CostDateRange, CostRangePreset } from "./costs";
import { COST_RANGE_PRESETS } from "./costs";
import type { CloudFetch } from "./fetch";
import type { NetworkFlowEndpointView } from "./network-flows";

/* ------------------------------------------------------------------ *
 * Vocabulary
 * ------------------------------------------------------------------ */

/**
 * Traffic classes a report filters and groups on: the network-flow boundaries,
 * in the order a bill reads them. Intra-region VPC peering is billed (and
 * classified) as cross-zone; transit gateway, VPN and interconnect traffic is
 * `private_interconnect`.
 */
export const NETWORK_FLOW_TRAFFIC_CLASSES: readonly NetworkFlowScope[] = [
  "intra_zone",
  "cross_zone",
  "cross_region",
  "internet_egress",
  "internet_ingress",
  "nat_gateway",
  "private_interconnect",
  "provider_service",
  "unknown",
];

export const NETWORK_FLOW_REPORT_DIRECTIONS = ["egress", "ingress"] as const;
export type NetworkFlowReportDirection = (typeof NETWORK_FLOW_REPORT_DIRECTIONS)[number];

/**
 * Bucket sizes. No hourly (flows are stored one row per UTC day) and no
 * quarterly (the store keeps 90 days, so a quarter would be one bucket).
 */
export const NETWORK_FLOW_REPORT_GRANULARITIES = ["daily", "weekly", "monthly"] as const;
export type NetworkFlowReportGranularity = (typeof NETWORK_FLOW_REPORT_GRANULARITIES)[number];

/**
 * What a report can split by. Pair-shaped groupings (`pair`, `zone_pair`,
 * `region_pair`) are source then destination; `service` is the **peer's**
 * service (the destination of egress, the source of ingress); `network` is
 * the local side's VPC.
 */
export const NETWORK_FLOW_REPORT_GROUP_BYS = [
  "none",
  "pair",
  "source",
  "destination",
  "traffic_class",
  "service",
  "zone_pair",
  "region_pair",
  "account",
  "network",
] as const;
export type NetworkFlowReportGroupBy = (typeof NETWORK_FLOW_REPORT_GROUP_BYS)[number];

/** What the report shows: estimated cost, bytes, or both side by side. */
export const NETWORK_FLOW_REPORT_METRICS = ["cost", "bytes", "both"] as const;
export type NetworkFlowReportMetric = (typeof NETWORK_FLOW_REPORT_METRICS)[number];

/** English labels; UI surfaces translate their own, the CLI prints these. */
export const NETWORK_FLOW_REPORT_GROUP_BY_LABELS: Record<NetworkFlowReportGroupBy, string> = {
  none: "No grouping",
  pair: "Flow pair",
  source: "Source",
  destination: "Destination",
  traffic_class: "Traffic class",
  service: "Peer service",
  zone_pair: "Zone pair",
  region_pair: "Region pair",
  account: "Account",
  network: "VPC / network",
};

export const NETWORK_FLOW_REPORT_GRANULARITY_LABELS: Record<NetworkFlowReportGranularity, string> =
  {
    daily: "Daily",
    weekly: "Weekly",
    monthly: "Monthly",
  };

export const NETWORK_FLOW_REPORT_METRIC_LABELS: Record<NetworkFlowReportMetric, string> = {
  cost: "Estimated cost",
  bytes: "Bytes",
  both: "Bytes and estimated cost",
};

/** Group key of a pair-shaped grouping: `source␟destination`. */
export const NETWORK_FLOW_PAIR_SEPARATOR = "\u001f";
/** Group key of the per-day remainder below the stored pair cap. */
export const NETWORK_FLOW_REPORT_TRUNCATED_KEY = "infrawrench:truncated";
/** Group key of the chart's "everything else" series. */
export const NETWORK_FLOW_REPORT_OTHER_KEY = "__other__";

/* ------------------------------------------------------------------ *
 * Saved report
 * ------------------------------------------------------------------ */

export const NETWORK_FLOW_REPORT_LIMITS = {
  maxNameLength: 120,
  maxDescriptionLength: 2000,
  /** Values per filter list. */
  maxFilterValues: 200,
  /** Longest window a report may cover. The store keeps 90 days; see the notice. */
  maxRangeDays: 366,
  /** Groups and top talkers a run lists. */
  maxTopN: 200,
  defaultTopN: 25,
  /** Series the chart draws before folding the rest into "everything else". */
  chartSeries: 8,
} as const;

/** How long the flow store keeps a day (its ClickHouse TTL). */
export const NETWORK_FLOW_RETENTION_DAYS = 90;

/**
 * Filters, every list AND-composed with the others and OR within itself. An
 * absent or empty list does not filter. Lists that name an endpoint property
 * (`networks`, `regions`, `zones`) match a flow when **either** end has it, so
 * "us-east-1" keeps traffic into and out of the region.
 */
export interface NetworkFlowReportFilters {
  accountIds?: string[];
  /** VPC / network ids, either end. */
  networks?: string[];
  /** Provider regions, either end. */
  regions?: string[];
  /** Availability zone ids, either end. */
  zones?: string[];
  /** Flow endpoint refs on the source side (`i-0abc…`, a workload). */
  sourceRefs?: string[];
  /** Flow endpoint refs on the destination side (a resource, `internet`, `aws:s3`). */
  destinationRefs?: string[];
  /** The peer's provider service (`s3`, `dynamodb`). */
  services?: string[];
  /** The peer's resource type id. */
  resourceTypes?: string[];
  trafficClasses?: NetworkFlowScope[];
  directions?: NetworkFlowReportDirection[];
}

export interface NetworkFlowReportConfig {
  version: 1;
  dateRange: CostDateRange;
  granularity: NetworkFlowReportGranularity;
  groupBy: NetworkFlowReportGroupBy;
  filters: NetworkFlowReportFilters;
  metric: NetworkFlowReportMetric;
  /** Groups and top talkers listed. Absent means the default (25). */
  topN?: number;
}

export const DEFAULT_NETWORK_FLOW_REPORT_CONFIG: NetworkFlowReportConfig = {
  version: 1,
  dateRange: { kind: "relative", preset: "30d" },
  granularity: "daily",
  groupBy: "traffic_class",
  filters: {},
  metric: "both",
};

export interface NetworkFlowReportInput {
  name: string;
  description?: string | null;
  config: NetworkFlowReportConfig;
  /** A report folder (the same tree cost reports live in); null is the top level. */
  folderId?: string | null;
}

export interface NetworkFlowReport {
  id: string;
  name: string;
  description: string | null;
  config: NetworkFlowReportConfig;
  folderId: string | null;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

function isIsoDay(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DAY.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.valueOf()) && d.toISOString().slice(0, 10) === value;
}

/** Inclusive day count of an ISO range (1 for a single day). */
export function networkFlowReportRangeDays(from: string, to: string): number {
  return (
    Math.round(
      (new Date(`${to}T00:00:00Z`).valueOf() - new Date(`${from}T00:00:00Z`).valueOf()) / DAY_MS,
    ) + 1
  );
}

export type NetworkFlowReportValidation<T> = { ok: true; value: T } | { ok: false; error: string };

const FILTER_KEYS = [
  "accountIds",
  "networks",
  "regions",
  "zones",
  "sourceRefs",
  "destinationRefs",
  "services",
  "resourceTypes",
  "trafficClasses",
  "directions",
] as const;

function stringList(
  raw: unknown,
  field: string,
): { ok: true; value: string[] | undefined } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (!Array.isArray(raw)) return { ok: false, error: `filters.${field} must be a list.` };
  if (raw.length > NETWORK_FLOW_REPORT_LIMITS.maxFilterValues) {
    return {
      ok: false,
      error: `filters.${field} takes at most ${NETWORK_FLOW_REPORT_LIMITS.maxFilterValues} values.`,
    };
  }
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string" || v.trim() === "") {
      return { ok: false, error: `filters.${field} must contain non-empty strings.` };
    }
    if (!out.includes(v)) out.push(v);
  }
  return { ok: true, value: out.length > 0 ? out : undefined };
}

/** Why a resolved window cannot run, or null when it can. */
export function networkFlowReportRangeProblem(from: string, to: string): string | null {
  if (networkFlowReportRangeDays(from, to) > NETWORK_FLOW_REPORT_LIMITS.maxRangeDays) {
    return `A network flow report covers at most ${NETWORK_FLOW_REPORT_LIMITS.maxRangeDays} days.`;
  }
  return null;
}

/**
 * Parse and normalize a config from untrusted JSON. Unknown keys are refused
 * rather than dropped, so a typo in a Terraform or API body is an error and
 * not a silently different report. Range limits are checked here for absolute
 * ranges; a relative preset is checked against its resolved range when the
 * report runs.
 */
export function normalizeNetworkFlowReportConfig(
  raw: unknown,
): NetworkFlowReportValidation<NetworkFlowReportConfig> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "config must be an object." };
  }
  const c = raw as Record<string, unknown>;
  const allowed = new Set([
    "version",
    "dateRange",
    "granularity",
    "groupBy",
    "filters",
    "metric",
    "topN",
  ]);
  const unknown = Object.keys(c).find((k) => !allowed.has(k));
  if (unknown) return { ok: false, error: `Unknown config field "${unknown}".` };
  if (c["version"] !== 1) return { ok: false, error: "config.version must be 1." };

  const range = c["dateRange"] as Record<string, unknown> | undefined;
  let dateRange: CostDateRange;
  if (!range || typeof range !== "object") {
    return { ok: false, error: "config.dateRange is required." };
  } else if (range["kind"] === "relative") {
    if (!COST_RANGE_PRESETS.includes(range["preset"] as CostRangePreset)) {
      return {
        ok: false,
        error: `config.dateRange.preset must be one of ${COST_RANGE_PRESETS.join(", ")}.`,
      };
    }
    dateRange = { kind: "relative", preset: range["preset"] as CostRangePreset };
  } else if (range["kind"] === "absolute") {
    const from = range["from"];
    const to = range["to"];
    if (!isIsoDay(from) || !isIsoDay(to)) {
      return { ok: false, error: "config.dateRange.from and .to must be YYYY-MM-DD days." };
    }
    if (from > to) return { ok: false, error: "config.dateRange.from must not be after .to." };
    dateRange = { kind: "absolute", from, to };
  } else {
    return { ok: false, error: 'config.dateRange.kind must be "relative" or "absolute".' };
  }

  const granularity = c["granularity"] ?? "daily";
  if (!NETWORK_FLOW_REPORT_GRANULARITIES.includes(granularity as NetworkFlowReportGranularity)) {
    return {
      ok: false,
      error:
        granularity === "hourly"
          ? "Hourly is not available: flows are stored one row per day, so an hourly bucket would be invented."
          : `config.granularity must be one of ${NETWORK_FLOW_REPORT_GRANULARITIES.join(", ")}.`,
    };
  }
  const groupBy = c["groupBy"] ?? "none";
  if (!NETWORK_FLOW_REPORT_GROUP_BYS.includes(groupBy as NetworkFlowReportGroupBy)) {
    return {
      ok: false,
      error: `config.groupBy must be one of ${NETWORK_FLOW_REPORT_GROUP_BYS.join(", ")}.`,
    };
  }
  const metric = c["metric"] ?? "both";
  if (!NETWORK_FLOW_REPORT_METRICS.includes(metric as NetworkFlowReportMetric)) {
    return {
      ok: false,
      error: `config.metric must be one of ${NETWORK_FLOW_REPORT_METRICS.join(", ")}.`,
    };
  }
  const topN = c["topN"];
  if (
    topN !== undefined &&
    topN !== null &&
    (typeof topN !== "number" ||
      !Number.isInteger(topN) ||
      topN < 1 ||
      topN > NETWORK_FLOW_REPORT_LIMITS.maxTopN)
  ) {
    return {
      ok: false,
      error: `config.topN must be a whole number from 1 to ${NETWORK_FLOW_REPORT_LIMITS.maxTopN}.`,
    };
  }

  const rawFilters = c["filters"] ?? {};
  if (typeof rawFilters !== "object" || Array.isArray(rawFilters) || rawFilters === null) {
    return { ok: false, error: "config.filters must be an object." };
  }
  const f = rawFilters as Record<string, unknown>;
  const unknownFilter = Object.keys(f).find((k) => !(FILTER_KEYS as readonly string[]).includes(k));
  if (unknownFilter) return { ok: false, error: `Unknown filter "${unknownFilter}".` };
  const filters: NetworkFlowReportFilters = {};
  for (const key of FILTER_KEYS) {
    const parsed = stringList(f[key], key);
    if (!parsed.ok) return parsed;
    if (parsed.value) {
      (filters as Record<string, string[]>)[key] = parsed.value;
    }
  }
  if (filters.trafficClasses?.some((s) => !NETWORK_FLOW_TRAFFIC_CLASSES.includes(s))) {
    return {
      ok: false,
      error: `filters.trafficClasses must contain ${NETWORK_FLOW_TRAFFIC_CLASSES.join(", ")}.`,
    };
  }
  if (filters.directions?.some((d) => !NETWORK_FLOW_REPORT_DIRECTIONS.includes(d))) {
    return { ok: false, error: "filters.directions must contain egress, ingress." };
  }

  const config: NetworkFlowReportConfig = {
    version: 1,
    dateRange,
    granularity: granularity as NetworkFlowReportGranularity,
    groupBy: groupBy as NetworkFlowReportGroupBy,
    filters,
    metric: metric as NetworkFlowReportMetric,
    ...(typeof topN === "number" ? { topN } : {}),
  };
  if (dateRange.kind === "absolute") {
    const problem = networkFlowReportRangeProblem(dateRange.from, dateRange.to);
    if (problem) return { ok: false, error: problem };
  }
  return { ok: true, value: config };
}

/** Parse and normalize a create/update body. */
export function normalizeNetworkFlowReportInput(
  raw: unknown,
): NetworkFlowReportValidation<NetworkFlowReportInput> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "Expected a JSON object." };
  }
  const body = raw as Record<string, unknown>;
  const unknown = Object.keys(body).find(
    (k) => !["name", "description", "config", "folderId"].includes(k),
  );
  if (unknown) return { ok: false, error: `Unknown field "${unknown}".` };
  const name = typeof body["name"] === "string" ? body["name"].trim() : "";
  if (!name) return { ok: false, error: "name is required." };
  if (name.length > NETWORK_FLOW_REPORT_LIMITS.maxNameLength) {
    return {
      ok: false,
      error: `name is at most ${NETWORK_FLOW_REPORT_LIMITS.maxNameLength} characters.`,
    };
  }
  const rawDescription = body["description"];
  if (
    rawDescription !== undefined &&
    rawDescription !== null &&
    typeof rawDescription !== "string"
  ) {
    return { ok: false, error: "description must be a string." };
  }
  const description = typeof rawDescription === "string" ? rawDescription.trim() : "";
  if (description.length > NETWORK_FLOW_REPORT_LIMITS.maxDescriptionLength) {
    return {
      ok: false,
      error: `description is at most ${NETWORK_FLOW_REPORT_LIMITS.maxDescriptionLength} characters.`,
    };
  }
  const folderId = body["folderId"];
  if (folderId !== undefined && folderId !== null && typeof folderId !== "string") {
    return { ok: false, error: "folderId must be a string or null." };
  }
  const config = normalizeNetworkFlowReportConfig(body["config"]);
  if (!config.ok) return config;
  return {
    ok: true,
    value: {
      name,
      description: description || null,
      config: config.value,
      folderId: folderId ? folderId : null,
    },
  };
}

/** The topN a config runs with. */
export function networkFlowReportTopN(config: Pick<NetworkFlowReportConfig, "topN">): number {
  return config.topN ?? NETWORK_FLOW_REPORT_LIMITS.defaultTopN;
}

/* ------------------------------------------------------------------ *
 * Result
 * ------------------------------------------------------------------ */

/** The summed figures of one bucket, group or whole report. */
export interface NetworkFlowReportTotals {
  bytes: number;
  /** List-priced estimate, in the series currency. */
  estimatedCost: number;
  /** Of `bytes`, how many came from a sampled flow source. */
  sampledBytes: number;
  /** Of `estimatedCost`, how much was priced from sampled bytes. */
  sampledCost: number;
  /** Of `bytes`, how many could not be tied to a workload at one end. */
  unattributedBytes: number;
  /** Of `bytes`, the per-day remainder below the stored pair cap. */
  truncatedBytes: number;
}

export function emptyNetworkFlowReportTotals(): NetworkFlowReportTotals {
  return {
    bytes: 0,
    estimatedCost: 0,
    sampledBytes: 0,
    sampledCost: 0,
    unattributedBytes: 0,
    truncatedBytes: 0,
  };
}

export function addNetworkFlowReportTotals(
  into: NetworkFlowReportTotals,
  add: NetworkFlowReportTotals,
): NetworkFlowReportTotals {
  into.bytes += add.bytes;
  into.estimatedCost += add.estimatedCost;
  into.sampledBytes += add.sampledBytes;
  into.sampledCost += add.sampledCost;
  into.unattributedBytes += add.unattributedBytes;
  into.truncatedBytes += add.truncatedBytes;
  return into;
}

function subtractTotals(
  a: NetworkFlowReportTotals,
  b: NetworkFlowReportTotals,
): NetworkFlowReportTotals {
  // Clamped: floating-point dust must not draw a negative "everything else".
  const pos = (n: number) => (n > 1e-9 ? n : 0);
  return {
    bytes: pos(a.bytes - b.bytes),
    estimatedCost: pos(a.estimatedCost - b.estimatedCost),
    sampledBytes: pos(a.sampledBytes - b.sampledBytes),
    sampledCost: pos(a.sampledCost - b.sampledCost),
    unattributedBytes: pos(a.unattributedBytes - b.unattributedBytes),
    truncatedBytes: pos(a.truncatedBytes - b.truncatedBytes),
  };
}

/** Share of a total's bytes from a sampled source, 0 to 1; 0 when there are no bytes. */
export function networkFlowSampledShare(
  t: Pick<NetworkFlowReportTotals, "bytes" | "sampledBytes">,
) {
  return t.bytes > 0 ? Math.min(1, Math.max(0, t.sampledBytes / t.bytes)) : 0;
}

/** One aggregate the server's query returns: a day-or-bucket of a group in a currency. */
export interface NetworkFlowReportCell extends NetworkFlowReportTotals {
  bucket: string;
  groupKey: string;
  currency: string;
}

/** One group's total over the window, with its label (from the server). */
export interface NetworkFlowReportGroupTotal extends NetworkFlowReportTotals {
  groupKey: string;
  label: string;
  currency: string;
  /** Distinct flow pairs behind the group. */
  pairCount: number;
}

export interface NetworkFlowReportPoint extends NetworkFlowReportTotals {
  bucket: string;
}

export interface NetworkFlowReportSeries {
  /** Group key (`""` without grouping) plus currency: unique within a result. */
  id: string;
  groupKey: string;
  label: string;
  currency: string;
  points: NetworkFlowReportPoint[];
  total: NetworkFlowReportTotals;
}

/** One row of the top-talkers table: a flow pair over the whole window. */
export interface NetworkFlowReportTalker {
  source: NetworkFlowEndpointView & { network: string };
  destination: NetworkFlowEndpointView & { network: string };
  scope: NetworkFlowScope;
  direction: NetworkFlowReportDirection;
  attribution: "resolved" | "unattributed";
  bytes: number;
  packets: number;
  estimatedCost: number;
  currency: string;
  accountId: string;
  /** The account's display name, when the caller can see it. */
  accountName: string;
  pluginId: string;
  /** Days in the window the pair appeared on: a spike or a standing cost. */
  days: number;
  /** True when the pair's bytes came from a sampled flow source. */
  sampled: boolean;
}

export type NetworkFlowReportNotice =
  /** Flow collection is switched off for the organization. */
  | "collection_disabled"
  /** No connected account in scope can report flows. */
  | "no_flow_accounts"
  /** The window starts before the store's 90-day retention. */
  | "beyond_retention"
  /** Some bytes came from a flow source that samples. */
  | "sampled_sources"
  /** Kubernetes cluster traffic was left out (it re-cuts a cloud flow log). */
  | "recut_excluded"
  /** Some bytes could not be tied to a workload at one end. */
  | "unattributed_traffic"
  /** Some bytes fell below the stored pair cap on their day. */
  | "truncated_traffic"
  /** Rate cards in more than one currency: totals are per currency. */
  | "multiple_currencies";

export interface NetworkFlowReportResult {
  from: string;
  to: string;
  granularity: NetworkFlowReportGranularity;
  groupBy: NetworkFlowReportGroupBy;
  metric: NetworkFlowReportMetric;
  /** Always true: every figure is list-priced from observed bytes. */
  estimated: true;
  /** Every bucket start in the window, gaps included, ascending. */
  buckets: string[];
  /**
   * The chart's series: the largest groups, then one
   * {@link NETWORK_FLOW_REPORT_OTHER_KEY} series per currency for the rest,
   * so the stack always adds up to the overall line. Empty without grouping.
   */
  series: NetworkFlowReportSeries[];
  /** All groups combined, one per currency: the headline. */
  overall: NetworkFlowReportSeries[];
  /** Per-group totals over the window, largest first, up to topN. */
  groups: NetworkFlowReportGroupTotal[];
  /** How many groups there were in all, so the table can say what it left out. */
  groupCount: number;
  /** The largest flow pairs, up to topN (the stored-cap remainder is never a pair). */
  topTalkers: NetworkFlowReportTalker[];
  /** Plugins whose flow source samples, among those in scope. */
  sampledPluginIds: string[];
  notices: NetworkFlowReportNotice[];
}

/** A run of a saved report: the result plus which report it was. */
export interface NetworkFlowReportRunResult extends NetworkFlowReportResult {
  reportId: string;
  name: string;
}

/** Picker values for the editor, all scoped to what the caller may see. */
export interface NetworkFlowReportOptions {
  accounts: Array<{ id: string; name: string; pluginId: string; recut: boolean }>;
  networks: string[];
  regions: string[];
  zones: string[];
  services: string[];
  resourceTypes: string[];
  /** Endpoints seen in the store (both sides), heaviest first. */
  endpoints: Array<{
    ref: string;
    label: string;
    resourceTypeId: string;
    side: "source" | "destination" | "both";
  }>;
  trafficClasses: NetworkFlowScope[];
}

/** The start (ISO day) of the bucket a day falls in. Weeks start on Monday. */
export function networkFlowReportBucketOf(
  day: string,
  granularity: NetworkFlowReportGranularity,
): string {
  if (granularity === "daily") return day;
  const d = new Date(`${day}T00:00:00Z`);
  if (granularity === "weekly") {
    const dow = (d.getUTCDay() + 6) % 7;
    return new Date(d.valueOf() - dow * DAY_MS).toISOString().slice(0, 10);
  }
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

/** Every bucket start from the bucket holding `from` to the one holding `to`. */
export function networkFlowReportBuckets(
  from: string,
  to: string,
  granularity: NetworkFlowReportGranularity,
): string[] {
  const out: string[] = [];
  const last = networkFlowReportBucketOf(to, granularity);
  let cur = networkFlowReportBucketOf(from, granularity);
  while (cur <= last) {
    out.push(cur);
    const d = new Date(`${cur}T00:00:00Z`);
    if (granularity === "daily") d.setUTCDate(d.getUTCDate() + 1);
    else if (granularity === "weekly") d.setUTCDate(d.getUTCDate() + 7);
    else d.setUTCMonth(d.getUTCMonth() + 1);
    cur = d.toISOString().slice(0, 10);
  }
  return out;
}

/** How a result ranks: by money unless the report is about bytes only. */
export function networkFlowReportRanksByBytes(metric: NetworkFlowReportMetric): boolean {
  return metric === "bytes";
}

export interface BuildNetworkFlowReportInput {
  from: string;
  to: string;
  granularity: NetworkFlowReportGranularity;
  groupBy: NetworkFlowReportGroupBy;
  metric: NetworkFlowReportMetric;
  /** Overall cells (groupKey ""), per bucket and currency. */
  overallCells: readonly NetworkFlowReportCell[];
  /** Cells for the charted groups only, per bucket and currency. */
  seriesCells: readonly NetworkFlowReportCell[];
  /** Group totals, any order; the build sorts and cuts them. */
  groups: readonly NetworkFlowReportGroupTotal[];
  /** Total number of groups before the cut (the server knows; defaults to `groups.length`). */
  groupCount?: number;
  topTalkers: readonly NetworkFlowReportTalker[];
  topN: number;
  sampledPluginIds?: readonly string[];
  notices?: readonly NetworkFlowReportNotice[];
}

function rankCompare(byBytes: boolean) {
  return (
    a: Pick<NetworkFlowReportTotals, "bytes" | "estimatedCost"> & { label?: string },
    b: Pick<NetworkFlowReportTotals, "bytes" | "estimatedCost"> & { label?: string },
  ) =>
    (byBytes
      ? b.bytes - a.bytes || b.estimatedCost - a.estimatedCost
      : b.estimatedCost - a.estimatedCost || b.bytes - a.bytes) ||
    (a.label ?? "").localeCompare(b.label ?? "");
}

function seriesOf(
  groupKey: string,
  label: string,
  currency: string,
  buckets: readonly string[],
  byBucket: ReadonlyMap<string, NetworkFlowReportTotals>,
): NetworkFlowReportSeries {
  const total = emptyNetworkFlowReportTotals();
  const points = buckets.map((bucket) => {
    const t = { ...(byBucket.get(bucket) ?? emptyNetworkFlowReportTotals()) };
    addNetworkFlowReportTotals(total, t);
    return { bucket, ...t };
  });
  return { id: `${groupKey}\u0000${currency}`, groupKey, label, currency, points, total };
}

function bucketCells(
  cells: readonly NetworkFlowReportCell[],
  granularity: NetworkFlowReportGranularity,
): Map<
  string,
  { groupKey: string; currency: string; byBucket: Map<string, NetworkFlowReportTotals> }
> {
  const out = new Map<
    string,
    { groupKey: string; currency: string; byBucket: Map<string, NetworkFlowReportTotals> }
  >();
  for (const cell of cells) {
    const id = `${cell.groupKey}\u0000${cell.currency}`;
    let entry = out.get(id);
    if (!entry) {
      entry = { groupKey: cell.groupKey, currency: cell.currency, byBucket: new Map() };
      out.set(id, entry);
    }
    const bucket = networkFlowReportBucketOf(cell.bucket, granularity);
    const t = entry.byBucket.get(bucket) ?? emptyNetworkFlowReportTotals();
    addNetworkFlowReportTotals(t, cell);
    entry.byBucket.set(bucket, t);
  }
  return out;
}

/**
 * Assemble a result. Pure: the server calls it after its queries and tests
 * call it directly.
 *
 * - Every bucket of the window appears in every series (an empty bucket is
 *   zero bytes and zero money: a day with no flows did move nothing, unlike a
 *   ratio, so zero is the honest value).
 * - The chart draws at most {@link NETWORK_FLOW_REPORT_LIMITS.chartSeries}
 *   groups; the remainder per currency is one "everything else" series computed
 *   by subtraction from the overall cells, so the stack equals the headline.
 * - Notices for sampled, unattributed and truncated bytes are added here from
 *   the overall totals, so every surface warns on the same condition.
 */
export function buildNetworkFlowReport(
  input: BuildNetworkFlowReportInput,
): NetworkFlowReportResult {
  const buckets = networkFlowReportBuckets(input.from, input.to, input.granularity);
  const byBytes = networkFlowReportRanksByBytes(input.metric);
  const compare = rankCompare(byBytes);

  const overall = [...bucketCells(input.overallCells, input.granularity).values()]
    .map((e) => seriesOf("", e.currency, e.currency, buckets, e.byBucket))
    .sort((a, b) => a.currency.localeCompare(b.currency));

  const groups = [...input.groups].sort(compare).slice(0, Math.max(1, input.topN));
  const labelOf = new Map(input.groups.map((g) => [`${g.groupKey}\u0000${g.currency}`, g.label]));

  let series: NetworkFlowReportSeries[] = [];
  if (input.groupBy !== "none") {
    const drawn = [...bucketCells(input.seriesCells, input.granularity).entries()]
      .map(([id, e]) =>
        seriesOf(e.groupKey, labelOf.get(id) ?? e.groupKey, e.currency, buckets, e.byBucket),
      )
      .sort((a, b) => compare({ ...a.total, label: a.label }, { ...b.total, label: b.label }))
      .slice(0, NETWORK_FLOW_REPORT_LIMITS.chartSeries);
    series = drawn;
    // Everything else, per currency: overall minus what was drawn.
    for (const o of overall) {
      const drawnHere = drawn.filter((s) => s.currency === o.currency);
      const rest = new Map<string, NetworkFlowReportTotals>();
      let any = false;
      for (const p of o.points) {
        const sum = emptyNetworkFlowReportTotals();
        for (const s of drawnHere) {
          const q = s.points.find((x) => x.bucket === p.bucket);
          if (q) addNetworkFlowReportTotals(sum, q);
        }
        const diff = subtractTotals(p, sum);
        if (diff.bytes > 0 || diff.estimatedCost > 0) any = true;
        rest.set(p.bucket, diff);
      }
      if (any) {
        series.push(
          seriesOf(NETWORK_FLOW_REPORT_OTHER_KEY, "Everything else", o.currency, buckets, rest),
        );
      }
    }
  }

  const notices = [...(input.notices ?? [])];
  const add = (n: NetworkFlowReportNotice) => {
    if (!notices.includes(n)) notices.push(n);
  };
  if (overall.some((s) => s.total.sampledBytes > 0)) add("sampled_sources");
  if (overall.some((s) => s.total.unattributedBytes > 0)) add("unattributed_traffic");
  if (overall.some((s) => s.total.truncatedBytes > 0)) add("truncated_traffic");
  if (overall.length > 1) add("multiple_currencies");

  return {
    from: input.from,
    to: input.to,
    granularity: input.granularity,
    groupBy: input.groupBy,
    metric: input.metric,
    estimated: true,
    buckets,
    series,
    overall,
    groups,
    groupCount: input.groupCount ?? input.groups.length,
    topTalkers: [...input.topTalkers]
      .sort((a, b) => compare(a, b))
      .slice(0, Math.max(1, input.topN)),
    sampledPluginIds: [...(input.sampledPluginIds ?? [])],
    notices,
  };
}

/* ------------------------------------------------------------------ *
 * Labels for keys only the client can name
 * ------------------------------------------------------------------ */

/**
 * Split a pair-shaped group key (`pair`, `zone_pair`, `region_pair`) into its
 * two sides. Anything else comes back as `[key, ""]`.
 */
export function splitNetworkFlowPairKey(key: string): [string, string] {
  const i = key.indexOf(NETWORK_FLOW_PAIR_SEPARATOR);
  return i < 0 ? [key, ""] : [key.slice(0, i), key.slice(i + 1)];
}

/* ------------------------------------------------------------------ *
 * CSV
 * ------------------------------------------------------------------ */

/**
 * One CSV cell. Numbers go out bare; text is RFC 4180 quoted, and text that
 * starts like a formula gets a leading tab, because endpoint labels come from
 * customers' clouds and a spreadsheet must not execute them.
 */
function csvCell(value: string | number | boolean | null): string {
  if (value === null) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  const guarded = /^[=+\-@\t\r]/.test(value) ? `\t${value}` : value;
  return `"${guarded.replace(/"/g, '""')}"`;
}

const cents = (n: number) => Math.round(n * 100) / 100;
const share = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * The report's series as CSV: one row per group per bucket, then one total row
 * per group (bucket `total`). Bytes are whole bytes, money is rounded to
 * cents, `sampled_share` is a fraction. The "everything else" row is included
 * so a column sum equals the headline.
 */
export function networkFlowReportToCsv(result: NetworkFlowReportResult): string {
  const header = [
    "bucket",
    "group",
    "currency",
    "bytes",
    "estimated_cost",
    "sampled_share",
    "unattributed_bytes",
    "outside_top_pairs_bytes",
  ];
  const lines = [header.map(csvCell).join(",")];
  const source = result.groupBy === "none" ? result.overall : result.series;
  const row = (bucket: string, s: NetworkFlowReportSeries, t: NetworkFlowReportTotals) =>
    [
      csvCell(bucket),
      csvCell(result.groupBy === "none" ? "" : s.label),
      csvCell(s.currency),
      csvCell(Math.round(t.bytes)),
      csvCell(cents(t.estimatedCost)),
      csvCell(share(networkFlowSampledShare(t))),
      csvCell(Math.round(t.unattributedBytes)),
      csvCell(Math.round(t.truncatedBytes)),
    ].join(",");
  for (const s of source) for (const p of s.points) lines.push(row(p.bucket, s, p));
  for (const s of source) lines.push(row("total", s, s.total));
  return `${lines.join("\r\n")}\r\n`;
}

/** The top-talkers table as CSV: one row per flow pair over the window. */
export function networkFlowReportPairsToCsv(result: NetworkFlowReportResult): string {
  const header = [
    "source",
    "source_ref",
    "source_zone",
    "source_region",
    "source_network",
    "destination",
    "destination_ref",
    "destination_zone",
    "destination_region",
    "destination_network",
    "traffic_class",
    "direction",
    "attribution",
    "account",
    "bytes",
    "estimated_cost",
    "currency",
    "days",
    "sampled",
  ];
  const lines = [header.map(csvCell).join(",")];
  for (const t of result.topTalkers) {
    lines.push(
      [
        csvCell(t.source.label),
        csvCell(t.source.ref),
        csvCell(t.source.zone),
        csvCell(t.source.region),
        csvCell(t.source.network),
        csvCell(t.destination.label),
        csvCell(t.destination.ref),
        csvCell(t.destination.zone),
        csvCell(t.destination.region),
        csvCell(t.destination.network),
        csvCell(t.scope),
        csvCell(t.direction),
        csvCell(t.attribution),
        csvCell(t.accountName || t.accountId),
        csvCell(Math.round(t.bytes)),
        csvCell(cents(t.estimatedCost)),
        csvCell(t.currency),
        csvCell(t.days),
        csvCell(t.sampled),
      ].join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

/** A file name for a report's CSV: the name, slugged, plus the window. */
export function networkFlowReportCsvFileName(
  name: string,
  from: string,
  to: string,
  kind: "series" | "pairs" = "series",
): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "network-flow-report";
  return `${slug}${kind === "pairs" ? "-pairs" : ""}-${from}-to-${to}.csv`;
}

/* ------------------------------------------------------------------ *
 * Fetch helpers (anything on a CloudFetch)
 * ------------------------------------------------------------------ */

/** Saved network flow reports the caller may open (`costs:read`). */
export async function fetchNetworkFlowReports(
  api: CloudFetch,
  orgId: string,
): Promise<NetworkFlowReport[] | null> {
  return api.org<NetworkFlowReport[]>(orgId, "/network-flows/reports");
}

/** Run a saved report (`costs:read`). */
export async function runNetworkFlowReport(
  api: CloudFetch,
  orgId: string,
  reportId: string,
): Promise<NetworkFlowReportRunResult | null> {
  return api.org<NetworkFlowReportRunResult>(
    orgId,
    `/network-flows/reports/${encodeURIComponent(reportId)}/run`,
    { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
  );
}
