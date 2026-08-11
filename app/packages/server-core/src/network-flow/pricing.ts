/**
 * Turning observed bytes into money.
 *
 * The arithmetic lives here, in the host, and the *numbers* live in the
 * plugin's `NetworkFlowCapabilityDeclaration.rates`. That split is deliberate:
 * every provider publishes different rates under different names, but they all
 * price the same handful of boundaries the same way — per GB, by boundary, with
 * regional variation — so there is exactly one correct implementation of the
 * multiplication and it should be tested once rather than in every plugin.
 *
 * **What this deliberately does not model**, because modelling it wrong is
 * worse than not modelling it and the surface says so out loud:
 *
 * - **Free tiers.** AWS gives every account 100 GB/month of internet egress
 *   free. That allowance is account-wide and consumed by services this feature
 *   cannot see (CloudFront, S3, load balancers), so subtracting it from flow
 *   bytes would credit the same 100 GB twice. Every priced byte here is priced.
 * - **Volume tiers.** Internet egress steps down above 10 TB/month. Applying a
 *   tier needs the month's running total *for the whole account*, which is a
 *   billing fact we hold in `cost_daily` and not a flow fact — and mixing the
 *   two would make a flow's price depend on when in the month it was collected.
 *   Everything is priced at the first tier, which over-states large bills.
 * - **Negotiated rates, private pricing, commitment discounts.** Invisible to
 *   us by construction.
 *
 * All three run in known directions, which is what makes the estimate usable
 * anyway: the ranking of flows by cost is right even when the absolute figure
 * is not, and the ranking is the finding.
 */
import {
  BYTES_PER_PRICING_GB,
  type NetworkFlowRateCard,
  type NetworkFlowScope,
} from "@infrawrench/plugin-base";

/** What one scope costs per GB, and where that number came from. */
export interface ResolvedRate {
  perGb: number;
  currency: string;
  /** True when a `perRegion` override supplied the rate rather than the base. */
  regional: boolean;
}

/**
 * The published per-GB rate for a boundary.
 *
 * A scope the card does not name resolves to **zero**, and that is the right
 * answer rather than a gap: the free boundaries (`intra_zone`,
 * `internet_ingress`) are genuinely free, and a boundary a plugin declines to
 * price is one it has no published number for — charging a guessed rate there
 * would put fabricated money on a screen people make decisions from. Bytes for
 * those rows are still stored and still shown; only the money is zero, and the
 * surface distinguishes "free" from "unpriced" by the scope itself.
 */
export function resolveRate(
  rates: NetworkFlowRateCard,
  scope: NetworkFlowScope,
  region?: string | undefined,
): ResolvedRate {
  const override = region ? rates.perRegion?.[region] : undefined;
  const regional = override !== undefined && override[scope] !== undefined;
  const perGb = (regional ? override[scope] : rates.perGb[scope]) ?? 0;
  return { perGb, currency: rates.currency, regional };
}

export interface PricedBytes {
  bytes: number;
  ratePerGb: number;
  currency: string;
  amount: number;
}

/**
 * Price a byte count at a boundary's rate.
 *
 * GB here is 10^9 bytes, not 2^30. Every provider's data-transfer pricing page
 * defines it that way, and using GiB would quietly under-report every figure by
 * 7.4% — small enough to look like normal estimate drift and therefore the
 * worst possible size of error.
 *
 * Negative byte counts are clamped to zero. They should never occur, but the
 * residual arithmetic in `aggregate.ts` can produce one when a provider's
 * reported totals disagree with the pairs it returned, and a negative cost row
 * would silently reduce the org's total egress bill.
 */
export function priceBytes(
  rates: NetworkFlowRateCard,
  scope: NetworkFlowScope,
  bytes: number,
  region?: string | undefined,
): PricedBytes {
  const safeBytes = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  const { perGb, currency } = resolveRate(rates, scope, region);
  return {
    bytes: safeBytes,
    ratePerGb: perGb,
    currency,
    amount: (safeBytes / BYTES_PER_PRICING_GB) * perGb,
  };
}

/**
 * Which boundaries a scope crossed, as the three questions people actually ask
 * of a network bill.
 *
 * Derived from the scope rather than stored alongside it, so the two can never
 * disagree — a stored `crossedZone` on a row whose scope later reads
 * `intra_zone` is a bug with no detectable symptom.
 *
 * `nat_gateway` sets none of them on purpose. A NAT charge is levied for
 * *processing*, and the same bytes then cross whatever boundary they were
 * headed for — counting the NAT hop as "left the cloud" would double the
 * apparent internet egress of every private subnet.
 */
export function boundaryFlags(scope: NetworkFlowScope): {
  crossedZone: boolean;
  crossedRegion: boolean;
  leftCloud: boolean;
} {
  switch (scope) {
    case "cross_zone":
      return { crossedZone: true, crossedRegion: false, leftCloud: false };
    case "cross_region":
      return { crossedZone: true, crossedRegion: true, leftCloud: false };
    case "internet_egress":
    case "internet_ingress":
    case "private_interconnect":
      return { crossedZone: false, crossedRegion: false, leftCloud: true };
    case "intra_zone":
    case "provider_service":
    case "nat_gateway":
    case "unknown":
      return { crossedZone: false, crossedRegion: false, leftCloud: false };
  }
}
