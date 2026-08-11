/**
 * The network-flow contract — one screen's worth of answers to "what is driving
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
  /** "resolved" | "unattributed" — a truncation row is never a pair. */
  attribution: "resolved" | "unattributed";
  bytes: number;
  packets: number;
  estimatedCost: number;
  currency: string;
  accountId: string;
  pluginId: string;
  /** Days in the range this pair appeared on — a spike vs a standing cost. */
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
 * truncated bytes are both *known* quantities here — nothing has been
 * apportioned — so this is a measurement rather than a confidence score.
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
