/**
 * The network-flow contract: one screen's worth of answers to "what is driving
 * our egress bill".
 *
 * Lives here rather than in `@infrawrench/ui` for the usual reason: mobile does
 * not depend on that package, and one definition of these bytes has to serve
 * web, desktop, mobile and the CLI.
 *
 * Everything numeric in here is an **estimate** and the flag that says so is
 * not optional. Flow bytes come from logs that sample or drop under load;
 * prices come from a published list rate card with no free tier, no volume
 * tier and no negotiated discount modelled. The ranking is trustworthy; the
 * absolute figure will not tie out to the invoice, and the surface must say so
 * before anybody reads a number off it.
 */

import type { NetworkFlowScope } from "@infrawrench/plugin-base";

export type { NetworkFlowScope, NetworkFlowDirection } from "@infrawrench/plugin-base";

/** Human labels for the boundaries, shared by every surface. */
export const NETWORK_FLOW_SCOPE_LABELS: Record<NetworkFlowScope, string> = {
  intra_zone: "Same zone",
  cross_zone: "Cross-zone",
  cross_region: "Cross-region",
  internet_egress: "Internet egress",
  internet_ingress: "Internet ingress",
  provider_service: "Provider service",
  nat_gateway: "NAT gateway",
  private_interconnect: "VPN / interconnect",
  unknown: "Unclassified",
};

/** One boundary's weight over the range. */
export interface NetworkFlowScopeSummary {
  scope: NetworkFlowScope;
  direction: "egress" | "ingress";
  bytes: number;
  estimatedCost: number;
  currency: string;
  crossedZone: boolean;
  crossedRegion: boolean;
  leftCloud: boolean;
  /** Bytes in this boundary that could not be tied to a workload. */
  unattributedBytes: number;
  /** Bytes in this boundary that fell below the stored top-N cap. */
  truncatedBytes: number;
}

/** One end of a pair, as rendered. */
export interface NetworkFlowEndpointView {
  ref: string;
  label: string;
  zone: string;
  region: string;
  service: string;
  /** Set when `ref` is a resource this org syncs, so the row can link out. */
  resourceTypeId: string;
}

/** One priced pair over the range. */
export interface NetworkFlowPairView {
  source: NetworkFlowEndpointView;
  destination: NetworkFlowEndpointView;
  scope: NetworkFlowScope;
  direction: "egress" | "ingress";
  /** "resolved" | "unattributed": a truncation row is never a pair. */
  attribution: "resolved" | "unattributed";
  bytes: number;
  packets: number;
  estimatedCost: number;
  currency: string;
  accountId: string;
  pluginId: string;
  /** Days in the range this pair appeared on: a spike vs a standing cost. */
  days: number;
}

/** A flow-log source found on an account, usable or not. */
export interface NetworkFlowSourceView {
  id: string;
  target: string;
  region: string | null;
  destinationType: string;
  usable: boolean;
  unusableReason: string | null;
  helpUrl: string | null;
}

/**
 * One account's flow capability and collection state.
 *
 * `supportsFlows: false` is the "degrade to nothing" case: the account's
 * provider has no flow source we can read, so the surface shows the account as
 * unsupported rather than showing it with zero bytes. Zero would be a claim
 * about their network; this is a statement about ours.
 */
export interface NetworkFlowAccountStatus {
  accountId: string;
  pluginId: string;
  displayName: string;
  supportsFlows: boolean;
  /**
   * True when this account's flows re-cut traffic another account may already
   * report (a Kubernetes cluster's pods, whose bytes also cross the cloud
   * account's node interfaces). Such accounts are left out of the org-wide
   * totals and get their own per-cluster report instead.
   */
  recut: boolean;
  /** Null when the plugin cannot report flows at all. */
  collectedThrough: string | null;
  lastPolledAt: string | null;
  failureCount: number;
  lastError: string | null;
  lastErrorHelpUrl: string | null;
  sources: NetworkFlowSourceView[];
  /** Bytes the provider billed *this account* for the last pass's queries. */
  lastQueryBytesScanned: number | null;
}

/** A plugin's published rate card, surfaced so the numbers can be audited. */
export interface NetworkFlowRateCardView {
  pluginId: string;
  currency: string;
  /** ISO date the rates were last checked against the provider's pricing page. */
  asOf: string;
  perGb: Partial<Record<NetworkFlowScope, number>>;
  /** True when querying the source is billed to the customer's cloud account. */
  queriesBillable: boolean;
  /** True when the underlying flow source samples rather than recording all. */
  sampled: boolean;
}

/** Everything the network-costs screen renders. */
export interface NetworkFlowFeed {
  /** Org-level switch. False means nothing has been collected, by choice. */
  enabled: boolean;
  initialLookbackDays: number;
  /** Always true. Present as a field so surfaces render it from data, not habit. */
  estimated: true;
  range: { from: string; to: string };
  scopes: NetworkFlowScopeSummary[];
  topFlows: NetworkFlowPairView[];
  accounts: NetworkFlowAccountStatus[];
  rateCards: NetworkFlowRateCardView[];
  totals: {
    bytes: number;
    estimatedCost: number;
    currency: string;
    unattributedBytes: number;
    truncatedBytes: number;
  };
}

/**
 * Format a byte count for a bill-reading audience: decimal units, because the
 * money was computed in decimal GB and a table where the size column says GiB
 * and the cost column implies GB invites exactly one question, repeatedly.
 */
export function formatFlowBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "kB", "MB", "GB", "TB", "PB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/**
 * How much of a summary is actually explained, 0–1.
 *
 * The number the screen leads with, because a top-flows list is only a finding
 * to the extent that the flows in it account for the bytes. Unattributed and
 * truncated bytes are both *known* quantities here (nothing has been
 * apportioned) so this is a measurement rather than a confidence score.
 */
export function attributionCoverage(summary: {
  bytes: number;
  unattributedBytes: number;
  truncatedBytes: number;
}): number {
  if (summary.bytes <= 0) return 1;
  const explained = summary.bytes - summary.unattributedBytes - summary.truncatedBytes;
  return Math.max(0, Math.min(1, explained / summary.bytes));
}

/* ------------------------------------------------------------------ *
 * Kubernetes network costs: one cluster's traffic, by workload.
 * ------------------------------------------------------------------ */

/**
 * How a row's bytes and boundary were established, strongest first. `""` for
 * a residual row, which has no single method.
 */
export type KubernetesNetworkMethod = "flow_log" | "in_cluster_flows" | "counter_estimate" | "";

/** Human labels for the methods, shared by every surface. */
export const KUBERNETES_NETWORK_METHOD_LABELS: Record<KubernetesNetworkMethod, string> = {
  flow_log: "Cloud flow logs",
  in_cluster_flows: "In-cluster flows",
  counter_estimate: "Pod counters only",
  "": "Mixed",
};

/** One namespace, workload or node row of the report. */
export interface KubernetesNetworkRow {
  /** `namespace/Kind/name` for a workload, the namespace name, or a reserved token. */
  key: string;
  label: string;
  namespace: string;
  /**
   * `workload`, `namespace`, `node` (bytes a node moved beyond its pods'
   * counters) or `truncated` (pairs below the storage cap).
   */
  kind: "workload" | "namespace" | "node" | "truncated";
  bytes: number;
  /** Bytes × the published rate for each boundary. */
  estimatedCost: number;
  /**
   * This row's share of the cluster's **billed** data transfer, when a billed
   * source is configured; `null` when it is not. Never more than was billed.
   */
  allocatedCost: number | null;
  /** Bytes by boundary. */
  byScope: Partial<Record<NetworkFlowScope, number>>;
  /** The weakest method behind any of the row's bytes. */
  method: KubernetesNetworkMethod;
}

/** One boundary's share of the cluster's traffic. */
export interface KubernetesNetworkScopeRow {
  scope: NetworkFlowScope;
  bytes: number;
  estimatedCost: number;
  allocatedCost: number | null;
}

/** The billed source a report apportions, and how the apportionment went. */
export interface KubernetesNetworkBilled {
  /** The cost query selecting the billed data-transfer rows, as typed. */
  query: string | null;
  /** Why the query could not be used, when it could not. */
  error: string | null;
  /** Billed money over the range, in `currency`; null without a usable query. */
  billedCost: number | null;
  /**
   * `cost` when the money was apportioned by list-priced traffic (the normal
   * case), `bytes` when no traffic in the range could be priced and it was
   * apportioned by bytes alone (the weakest basis, labelled as such), `none`
   * when nothing was apportioned.
   */
  basis: "cost" | "bytes" | "none";
  /** Days in the range where the billed line came in below the list estimate and rows were scaled down. */
  scaledDays: number;
  /** Days with traffic but no billed rows yet (collection lag): nothing apportioned for them. */
  daysWithoutBilled: number;
}

/** Everything the Kubernetes network section renders for one cluster. */
export interface KubernetesNetworkReport {
  accountId: string;
  displayName: string;
  range: { from: string; to: string };
  /** Always true: every figure is derived, never collected. */
  estimated: true;
  currency: string;
  totals: {
    bytes: number;
    estimatedCost: number;
    /** Sum of the rows' allocated cost, or null without a billed source. */
    allocatedCost: number | null;
    /** Billed money no observed traffic accounted for; null without a billed source. */
    unallocatedCost: number | null;
  };
  billed: KubernetesNetworkBilled;
  scopes: KubernetesNetworkScopeRow[];
  /** Bytes per method, so the surface can say how much of the picture is observed. */
  methods: Array<{ method: KubernetesNetworkMethod; bytes: number }>;
  namespaces: KubernetesNetworkRow[];
  workloads: KubernetesNetworkRow[];
  /** Largest pairs first: workload → peer, with the boundary they crossed. */
  topTalkers: NetworkFlowPairView[];
  /** The cluster's collection state and detected sources; null if never polled. */
  collection: NetworkFlowAccountStatus | null;
}

/** The per-cluster settings behind a report. */
export interface KubernetesNetworkSettings {
  accountId: string;
  /** Cost query language text selecting the cluster's billed data transfer. */
  billedQuery: string | null;
  updatedAt: string | null;
}

/**
 * Apportion one day's billed money across that day's rows.
 *
 * Pure and shared, so the server and any test agree on the one rule that
 * matters: **the sum handed out never exceeds what was billed.**
 *
 * - With priced traffic, each row gets its list estimate scaled by
 *   `min(1, billed / estimate)`. Billed above the estimate leaves the rest
 *   unallocated (traffic the cluster did not observe, or other resources on the
 *   same line); billed below it (a free allowance, a discount) scales every row
 *   down by the same factor, so the ranking is untouched.
 * - With bytes but no priced traffic at all, the billed money is apportioned by
 *   bytes. Weakest basis, and the report says so.
 */
export function apportionBilledDay(
  rows: ReadonlyArray<{ bytes: number; estimatedCost: number }>,
  billed: number,
): { allocated: number[]; unallocated: number; basis: "cost" | "bytes" | "none"; scaled: boolean } {
  const safeBilled = Number.isFinite(billed) && billed > 0 ? billed : 0;
  const estimate = rows.reduce((a, r) => a + (r.estimatedCost > 0 ? r.estimatedCost : 0), 0);
  if (estimate > 0) {
    const factor = Math.min(1, safeBilled / estimate);
    const allocated = rows.map((r) => (r.estimatedCost > 0 ? r.estimatedCost * factor : 0));
    const handed = allocated.reduce((a, b) => a + b, 0);
    return {
      allocated,
      unallocated: Math.max(0, safeBilled - handed),
      basis: "cost",
      scaled: factor < 1,
    };
  }
  const bytes = rows.reduce((a, r) => a + (r.bytes > 0 ? r.bytes : 0), 0);
  if (bytes > 0 && safeBilled > 0) {
    const allocated = rows.map((r) => (r.bytes > 0 ? (safeBilled * r.bytes) / bytes : 0));
    return { allocated, unallocated: 0, basis: "bytes", scaled: false };
  }
  return { allocated: rows.map(() => 0), unallocated: safeBilled, basis: "none", scaled: false };
}
