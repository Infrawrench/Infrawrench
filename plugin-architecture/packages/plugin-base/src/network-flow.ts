/**
 * The network-flow contract: priced attribution of *pair* traffic — who talked
 * to what, across which boundary, and what that boundary costs.
 *
 * This is deliberately **not** part of the cost contract, and the separation is
 * load-bearing in both directions:
 *
 * - Flow rows never reach `cost_daily`. The provider already bills a
 *   `DataTransfer` line and the host already collects it; adding a derived
 *   second opinion to the same table would double-count the org's spend and
 *   corrupt every budget, anomaly and invoice that reads from it. Flow rows
 *   live in their own store and are read by their own surface.
 * - Cost rows never explain themselves. `cost_daily` can tell you that egress
 *   cost $4,100 last month; it cannot tell you that 80% of it was one service
 *   in `use1-az2` talking to a replica in `use1-az4`. That is what this is for,
 *   and it is the only question the cost dimensions structurally cannot answer,
 *   because the answer is about a *pair* and every cost dimension is about one
 *   side.
 *
 * **Everything here is an estimate, always.** A priced flow is bytes observed
 * in a flow log multiplied by a published rate, and it will not reconcile to
 * the invoice line: flow logs sample (GCP) or drop under capacity pressure
 * (AWS's `SKIPDATA`), free tiers and volume tiers are not modelled, and a
 * negotiated rate is invisible to us. {@link NetworkFlowCapabilityDeclaration}
 * has no `estimated` flag to turn off for exactly that reason — the host marks
 * this data estimated unconditionally, the same way
 * `CostCapabilityDeclaration.estimated` marks a rate-card cost collector.
 */

/**
 * Which boundary a flow crossed. This is the whole pricing model: rates differ
 * by boundary, not by resource, so a flow's scope and its byte count are
 * together sufficient to price it.
 *
 * The values are provider-neutral on purpose — every hyperscaler charges for
 * the same handful of boundaries under different names — but a plugin that
 * cannot *tell* which boundary a flow crossed must emit `unknown` rather than
 * guessing at the cheapest or the most expensive one.
 */
export type NetworkFlowScope =
  /** Both endpoints in the same availability zone. Free everywhere. */
  | "intra_zone"
  /** Both endpoints in the same region, different zones. */
  | "cross_zone"
  /** Endpoints in different regions of the same provider. */
  | "cross_region"
  /** Left the provider's network outbound — the expensive one. */
  | "internet_egress"
  /** Arrived from outside the provider's network. Free on every provider. */
  | "internet_ingress"
  /**
   * Traffic to a first-party service endpoint inside the same region (object
   * storage over a gateway endpoint, a managed database). Usually free, which
   * is precisely why it must be distinguishable from `internet_egress` — the
   * same bytes to the same service over the wrong path are not free at all.
   */
  | "provider_service"
  /**
   * Processed by a managed NAT device. Priced per GB *processed*, on top of
   * whatever the onward boundary costs, and the single most common surprise on
   * a network bill.
   */
  | "nat_gateway"
  /** Over a VPN / private interconnect to somewhere off-cloud. */
  | "private_interconnect"
  /**
   * The plugin saw the bytes and could not classify the boundary. Priced at
   * zero and *labelled*, never folded into a neighbouring scope.
   */
  | "unknown";

export const NETWORK_FLOW_SCOPES: readonly NetworkFlowScope[] = [
  "intra_zone",
  "cross_zone",
  "cross_region",
  "internet_egress",
  "internet_ingress",
  "provider_service",
  "nat_gateway",
  "private_interconnect",
  "unknown",
];

/** Direction relative to the endpoint that observed the flow. */
export type NetworkFlowDirection = "egress" | "ingress";

/**
 * How well a flow's endpoints could be tied to something the user owns.
 *
 * There is no `partial`: a pair with one resolved side and one unresolved side
 * is `unattributed`, because the finding "service X is sending 2 TB somewhere"
 * is only actionable if you can also say where, and pretending otherwise is how
 * a bucket of unexplained bytes gets quietly assigned to whoever is nearest.
 */
export type NetworkFlowAttribution =
  /** Both endpoints resolved to a known resource or a named provider service. */
  | "resolved"
  /**
   * Real bytes whose endpoints could not be tied to a workload. Kept as its own
   * bucket and shown as its own bucket — never apportioned across the resolved
   * pairs, and never dropped, because the dropped version of this row is what
   * makes a total quietly stop adding up.
   */
  | "unattributed"
  /**
   * The residual left over when a day had more distinct pairs than the host
   * stores. Emitted by the host (not by plugins) as an exact arithmetic
   * remainder against {@link NetworkFlowTotal}, one row per scope/direction.
   */
  | "truncated";

/**
 * One end of a flow.
 *
 * `ref` is the stable identity the UI groups and links on. Prefer the provider
 * resource id the host already syncs (`i-0abc…`, `nat-0def…`) so the pair can
 * be clicked through to a resource page; fall back to a stable descriptive
 * token (`internet`, `s3.us-east-1`) when there is no resource. Never put a raw
 * IP address here for an endpoint that could not be resolved — addresses are
 * unbounded cardinality and a churning address is a different row every day for
 * the same workload. Use a class token and set `attribution: "unattributed"`.
 */
export interface NetworkFlowEndpoint {
  /** Stable identity, resource id where one exists. Never a raw IP. */
  ref: string;
  /** Human label when `ref` is not itself readable. */
  label?: string;
  /** Availability zone id, when known. Empty/absent when it is not. */
  zone?: string;
  /** Provider region, when known. */
  region?: string;
  /**
   * Provider service this endpoint belongs to (`s3`, `dynamodb`, `ec2`), when
   * the provider names it. Feeds the "by service" half of the pair view.
   */
  service?: string;
  /** Resource type id, when `ref` is a resource the host syncs. */
  resourceTypeId?: string;
}

/**
 * One aggregated pair for one UTC day. This is *already aggregated* — a plugin
 * must never return per-packet or per-connection records. See
 * {@link NetworkFlowCapabilityDeclaration.maxPairsPerDay}.
 */
export interface NetworkFlowRecord {
  /** UTC day, YYYY-MM-DD. */
  date: string;
  source: NetworkFlowEndpoint;
  destination: NetworkFlowEndpoint;
  scope: NetworkFlowScope;
  direction: NetworkFlowDirection;
  attribution: Exclude<NetworkFlowAttribution, "truncated">;
  bytes: number;
  packets?: number;
}

/**
 * The exact per-(scope, direction) byte total for a day, independent of how
 * many pairs the plugin returned.
 *
 * This exists so the host can compute the truncation residual by *subtraction*
 * rather than by estimation. Without it a top-N pair list is a silent
 * undercount: the screen says "here is your egress" and the number is smaller
 * than the bill by however much the tail weighed. With it, the tail is a row.
 *
 * A plugin that genuinely returned every pair should still emit totals; the
 * residual then computes to zero and no truncation row is written. A plugin
 * that cannot compute totals cheaply should omit them entirely — the host then
 * writes no residual at all rather than inventing one, and the surface says the
 * figures are top-N only.
 */
export interface NetworkFlowTotal {
  date: string;
  scope: NetworkFlowScope;
  direction: NetworkFlowDirection;
  bytes: number;
}

/**
 * A flow-log source the plugin discovered on the account, whether or not it can
 * be used.
 *
 * Unusable sources are reported rather than skipped, because "you have no flow
 * logs" and "you have flow logs we cannot read" are different problems with
 * different fixes, and a screen that shows neither is indistinguishable from a
 * screen showing a genuinely quiet network.
 */
export interface NetworkFlowSource {
  /** Provider id of the source (a flow log id, a sink name). */
  id: string;
  /** What the flow log is attached to — a VPC id, a subnet id, a network. */
  target: string;
  region?: string;
  /** Where the records land: `logs`, `object_storage`, `warehouse`, `stream`. */
  destinationType: string;
  /** True when the plugin can actually query this source. */
  usable: boolean;
  /**
   * Why not, in the user's terms, when `usable` is false. Must name the fix:
   * "flow log fl-0abc uses the default record format, which has no
   * availability-zone or direction fields — recreate it with a custom format
   * including az-id, flow-direction and instance-id".
   */
  unusableReason?: string;
  /** A provider docs page that explains the fix, when the plugin knows one. */
  helpUrl?: string;
}

/**
 * Published per-GB rates, declared by the plugin because the numbers are the
 * provider's and belong with the provider's code — while the arithmetic that
 * applies them is generic and lives in the host, so it can be tested once.
 *
 * Rates are *list* rates in `currency`, per GB (10^9 bytes, which is how every
 * provider's data-transfer pricing page defines a GB — not GiB). A scope absent
 * from `perGb` is priced at zero, which is the correct answer for the free
 * boundaries and an honest one for boundaries the plugin declines to price.
 */
export interface NetworkFlowRateCard {
  currency: string;
  /**
   * ISO date the rates were last checked against the provider's pricing page.
   * Surfaced to the user, because a stale rate card is the failure mode here
   * and an undated one cannot be audited.
   */
  asOf: string;
  /** Rate that applies when no region-specific override matches. */
  perGb: Partial<Record<NetworkFlowScope, number>>;
  /**
   * Region-specific overrides, keyed by provider region id. Merged over
   * `perGb`, so an override need only name the scopes that differ.
   */
  perRegion?: Record<string, Partial<Record<NetworkFlowScope, number>>>;
}

/**
 * Declared by a plugin that can return aggregated network flows. Its presence
 * is what makes the host schedule a flow pass for the plugin's accounts; its
 * absence means the surface shows *nothing* for those accounts rather than
 * zero, which is the same rule the rest of the cost surface follows.
 */
export interface NetworkFlowCapabilityDeclaration {
  /**
   * Rates the host prices observed bytes at. Required: a plugin that can count
   * bytes but cannot price them produces a screen of large numbers with no
   * money on it, which is exactly the screen the provider console already
   * gives you.
   */
  rates: NetworkFlowRateCard;
  /**
   * How many distinct pairs the plugin will return for one account-day. The
   * host caps at its own budget regardless; declaring it lets the surface say
   * how deep the list goes and lets the host size its expectations.
   */
  maxPairsPerDay: number;
  /**
   * How many days back the plugin can answer for. Flow logs have short
   * retention by default (CloudWatch log groups are commonly 7 or 30 days), so
   * this is usually much smaller than a cost capability's `maxHistoryDays`.
   */
  maxHistoryDays: number;
  /**
   * True when querying the source bills the *user's* provider account — AWS
   * charges per GB scanned by a Logs Insights query, and a busy VPC's flow log
   * group is not small. The host makes collection opt-in and says so when this
   * is set; leaving it false on a source that does charge is how a monitoring
   * tool ends up on someone's bill review.
   */
  queriesBillable?: boolean;
  /**
   * True when the underlying source samples rather than recording every flow
   * (GCP VPC flow logs default to a 0.5 sample rate). Bytes are then a scaled
   * estimate of an estimate, and the surface says so.
   */
  sampled?: boolean;
}

/** One UTC day. Flow collection is day-at-a-time and forward-only. */
export interface NetworkFlowFetchRange {
  /** YYYY-MM-DD, UTC. Inclusive; the whole day. */
  day: string;
  /**
   * The host's authorization to spend the customer's money, withdrawn when it
   * aborts.
   *
   * A day is not a bounded unit of work: it is a walk over every flow log on
   * the account, each one a query with its own timeout, so the host cannot
   * decide up front whether a day fits in the time it is entitled to run for.
   * What the host *does* know, continuously, is whether it still holds the
   * cluster-wide claim on this account — and the moment it can no longer prove
   * that it does, another replica may take the account over and start the same
   * scans. Two replicas scanning the same log group is a duplicate charge on
   * the customer's bill, so the authorization has to be revocable while the
   * work is running rather than only between days.
   *
   * When this aborts, a plugin must:
   *
   * 1. **Start no further billable work.** Not one more query, not for the day
   *    in hand.
   * 2. **Stop what is already running, at the provider**, where the provider
   *    offers it (`StopQuery`, `jobs.cancel`). Abandoning the result locally
   *    does not stop the meter.
   * 3. **Throw.** Do not return a partial day: the host advances a watermark
   *    per day and never revisits one, so a short answer accepted as complete
   *    is a permanent undercount. The host recognizes its own abort and ends
   *    the pass cleanly — no failure recorded, no backoff, the day left for
   *    next time.
   *
   * A plugin that ignores this behaves exactly as it did before the signal
   * existed, and the host still refuses to record a day it revoked mid-flight;
   * what it cannot do is stop that plugin from spending. Honouring it is the
   * difference between a bounded overrun and an unbounded one.
   *
   * Absent when nobody is competing for the account — a backfill, a test, a
   * host that does not lease.
   */
  signal?: AbortSignal;
}

/**
 * What a plugin returns for one account-day.
 *
 * The three arrays answer three different questions and none substitutes for
 * another: `sources` says whether we could look at all, `totals` says how much
 * there was, `flows` says who it was between.
 */
export interface NetworkFlowFetchResult {
  sources: NetworkFlowSource[];
  flows: NetworkFlowRecord[];
  /** Omit entirely when totals cannot be computed — see {@link NetworkFlowTotal}. */
  totals?: NetworkFlowTotal[];
  /**
   * Bytes the provider billed the *user* for answering this query, when the
   * provider reports it. Shown next to the data, because a diagnostic that
   * costs money should say how much.
   */
  queryBytesScanned?: number;
  /**
   * True when the pass ran but against a narrower source set than usual — one
   * region refused, one flow log was mid-rotation. The host records the day as
   * collected either way (flow collection is forward-only and never restates),
   * but marks it degraded so the surface does not present a partial day as a
   * quiet one.
   */
  degraded?: boolean;
}

/**
 * Normalize a plugin's answer. Mirrors `normalizeCostFetchResult`: a plugin may
 * answer with a bare array of flows when it has nothing else to say, and that
 * shape must keep behaving exactly as it did before totals and sources existed.
 */
export function normalizeNetworkFlowResult(value: NetworkFlowRecord[] | NetworkFlowFetchResult): {
  sources: NetworkFlowSource[];
  flows: NetworkFlowRecord[];
  totals: NetworkFlowTotal[] | undefined;
  queryBytesScanned: number | undefined;
  degraded: boolean;
} {
  if (Array.isArray(value)) {
    return {
      sources: [],
      flows: value,
      totals: undefined,
      queryBytesScanned: undefined,
      degraded: false,
    };
  }
  return {
    sources: value.sources ?? [],
    flows: value.flows ?? [],
    totals: value.totals,
    queryBytesScanned: value.queryBytesScanned,
    degraded: value.degraded === true,
  };
}

/**
 * Thrown when the account is missing the setup this capability needs — no flow
 * logs configured, a destination we cannot read, a missing permission. Distinct
 * from a transient failure: the host stops retrying on a tight loop and shows
 * the reason with its fix, the way `CostSetupError` does for cost collection.
 */
export class NetworkFlowSetupError extends Error {
  readonly helpUrl: string | undefined;

  constructor(message: string, helpUrl?: string) {
    super(message);
    this.name = "NetworkFlowSetupError";
    this.helpUrl = helpUrl;
  }
}

/** Bytes per GB as every provider's data-transfer pricing page defines it. */
export const BYTES_PER_PRICING_GB = 1_000_000_000;
