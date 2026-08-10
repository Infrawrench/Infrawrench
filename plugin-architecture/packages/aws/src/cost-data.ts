/**
 * Actual-spend collection via Cost Explorer `GetCostAndUsage`, with charge-type
 * attribution.
 *
 * Cost Explorer is a global service served from us-east-1 only, and AWS
 * charges $0.01 per paginated request — the host's collection cadence
 * (once daily + a chunked one-time backfill) keeps that bounded. Per-resource
 * granularity is deliberately not requested (CE only retains it for 14 days
 * and it explodes row counts).
 *
 * Requires the `ce:GetCostAndUsage` IAM action, which is NOT part of typical
 * read-only infra policies — surfaced in the plugin docs. **Charge-type
 * attribution needs no additional IAM action**: `RECORD_TYPE` is a grouping
 * and filter dimension of the same call, not a separate operation.
 *
 * ─── The two-GroupBy limit, and what it forces ──────────────────────────────
 *
 * `GetCostAndUsage` accepts at most two GroupBy entries ("You can group AWS
 * costs using up to two different groups"), and the valid DIMENSION keys for
 * grouping are `AZ`, `INSTANCE_TYPE`, `LEGAL_ENTITY_NAME`, `INVOICING_ENTITY`,
 * `LINKED_ACCOUNT`, `OPERATION`, `PLATFORM`, `PURCHASE_TYPE`, `SERVICE`,
 * `TENANCY`, `RECORD_TYPE` and `USAGE_TYPE` (`REGION` is absent from that
 * published list but is accepted, and has been in use here since the first
 * version of this collector).
 * https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_GetCostAndUsage.html
 *
 * We want three dimensions — SERVICE, REGION, RECORD_TYPE — and have two
 * slots. The split below spends them where each one is worth most:
 *
 *   Pass 1a  Filter RECORD_TYPE ∈ {Usage}         GroupBy SERVICE + REGION
 *   Pass 1b  Filter RECORD_TYPE ∈ {DiscountedUsage,
 *            SavingsPlanCoveredUsage}             GroupBy SERVICE + REGION
 *   Pass 2   Filter NOT(1a ∪ 1b)                  GroupBy SERVICE + RECORD_TYPE
 *
 * All three of 1a's and 1b's record types are consumption billed at some rate
 * — on demand, an RI's rate, or a Savings Plan's — so all three keep their
 * region, which is what a reader breaks consumption down by. But they do not
 * share a charge type: on-demand consumption is `usage`, and the other two are
 * `commitment_covered_usage`, because "was this hour covered" is the only thing
 * this API will ever say about commitment coverage (see below). That is the
 * whole reason 1a and 1b are separate requests rather than one — a single
 * filtered request cannot report which of its record types each row came from
 * without spending the second grouping slot on RECORD_TYPE and losing REGION.
 *
 * Within 1b the two covered record types *are* merged, and that is safe: they
 * do normalize to one charge type, so grouping them apart would produce rows
 * identical in every column the host keys on. Letting CE add them up is both
 * cheaper and the only correct thing.
 *
 * Pass 2 drops REGION rather than SERVICE. Taxes, credits, refunds, support and
 * commitment fees are read per service ("what did the Savings Plan cost", "how
 * much support"), and CE reports most of them under no region at all.
 *
 * The filters remain exact complements — pass 2 is the literal `Not` of
 * {@link AWS_USAGE_RECORD_TYPES}, which is exactly 1a's set plus 1b's — so
 * total spend is conserved no matter what CE's real `RECORD_TYPE` tokens turn
 * out to be. A token we guessed wrong simply falls into pass 2, where it loses
 * its region and gets charge-typed from the same table; it is never dropped and
 * never counted twice.
 *
 * ─── Request count ──────────────────────────────────────────────────────────
 *
 * Per month chunk: **3 paginated requests** (1 before charge types existed).
 *
 * - Typical one-time backfill (365 days ⇒ 13 calendar-month chunks):
 *   13 → 39 requests, about $0.13 → $0.39 per account, once.
 * - Steady state (3-day restatement window, 1–2 chunks): 1–2 → 3–6 requests a
 *   day, about $0.30 → $0.90–$1.80 a month per account.
 *
 * The third request buys coverage measurement for an org's entire AWS estate,
 * for well under a dollar a month. The considered alternative — one filtered
 * request per record type, which would keep REGION on every row — costs 1 + K
 * requests per chunk for the K record types an account uses (4–10 in practice),
 * i.e. 5–11× rather than 3×, for a region on tax and credit lines that CE
 * mostly reports as `NoRegion` anyway. Still rejected.
 *
 * ─── Coverage without `commitmentId` ────────────────────────────────────────
 *
 * `commitmentId` cannot be populated from this API. `SAVINGS_PLAN_ARN` and
 * `RESERVATION_ID` exist as `GetDimensionValues` / filter dimensions in the
 * `COST_AND_USAGE` context, but neither is a valid GroupBy key for
 * `GetCostAndUsage` (see the enumerated list above), so there is no grouping
 * that yields "this service, this region, this savings plan".
 * https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_GetDimensionValues.html
 *
 * Attribution by filtering — one request per held commitment — is the only
 * remaining route, and its cost grows with the size of the holding, which is
 * exactly backwards. It would also be partial: Savings Plans could be
 * attributed that way (there are usually few), Reserved Instances could not
 * (there are usually many), so coverage would be systematically understated
 * while *looking* complete. Left plainly unattributed instead.
 *
 * That is survivable because coverage does not need the id — it needs to know
 * *that* an hour was covered, which `RECORD_TYPE` says exactly, and what the
 * hour was worth, which `AmortizedCost` says exactly. Only per-commitment
 * utilization ("did savings plan #3 pay for itself") genuinely needs the id,
 * and that question is left unanswered rather than guessed at.
 *
 * ─── Metrics ────────────────────────────────────────────────────────────────
 *
 * Both `UnblendedCost` and `AmortizedCost` are requested. Metrics are per
 * request, not per metric, so the second one is free.
 *
 * - `UnblendedCost` — "the cost of the usage", cash as billed on the day.
 * - `AmortizedCost` — "the effective cost of the upfront and monthly
 *   reservation fees spread across the billing period".
 *   https://docs.aws.amazon.com/cost-management/latest/userguide/ce-advanced.html
 *
 * This is not a nicety: for RI-covered usage the unblended *rate* is zero
 * ("For Amazon EC2 and Amazon RDS line items that have an RI discount applied
 * to them, the `UnblendedRate` is zero"), so the previous collector — which
 * asked for `UnblendedCost` only and skipped zero-amount groups — dropped
 * every `DiscountedUsage` row on the floor. Amortized cost is what those rows
 * are actually worth.
 * https://docs.aws.amazon.com/cur/latest/userguide/Lineitem-columns.html
 *
 * ─── Re-collecting over already-stored rows ─────────────────────────────────
 *
 * The host folds charge type into `tags_hash` only when it is not `usage`, so
 * a usage row hashes exactly as it did before this file learned about charge
 * types, and re-collection replaces it. That covers the overwhelming majority
 * of the key space and is why nothing double-counts here.
 *
 * The residue is a `(day, service, region)` cell whose spend was *entirely*
 * non-usage, or (since 1b) entirely commitment-covered. It was stored once as
 * an undifferentiated `usage` row; from now on its money arrives at a different
 * hash, and the old row is never regenerated, so it lingers and the day reads
 * high.
 *
 * Nearly all of that residue sits at no region, because nearly everything that
 * is not consumption does: tax, credits, refunds, support, Savings Plan fees.
 * So after pass 2, for every `(day, service)` it saw where the consumption
 * passes produced no no-region `usage` row, a zero-amount `usage` row is
 * emitted at `(day, service, "")`. That is the exact key the old collector
 * would have used for that service's no-region spend, so the write lands on
 * the stale row and replaces it with nothing. On a dataset that never had one
 * it is an inert empty row.
 *
 * The remainder — a *regional* cell whose only spend was non-usage or
 * commitment-covered: an RI recurring fee in a region where nothing ran, a
 * fully-reserved fleet whose unblended cost is zero — is handled by the host,
 * generically, in `server-core/src/clickhouse/cost-reconcile.ts`: any key
 * stored for a day this collection restated and not rewritten by it is zeroed
 * in the same insert, so this file's upgrade needs no operator step. The
 * in-pass zero rows above are kept because they cost nothing and resolve the
 * common shape before the host has to look it up.
 *
 * The mechanism cuts both ways, which is why {@link fetchAwsCostData} reports a
 * degraded pass: a fallback to {@link fetchUnattributed} writes only coarse
 * `usage` rows, and read as authoritative it would zero every attribution row
 * for the chunk.
 */

import type {
  CostChargeType,
  CostFetchRange,
  CostFetchResult,
  CostRow,
} from "@infrawrench/plugin-base";
import type { AwsCredentials } from "./auth.js";
import { fetchSigned } from "./signed-request.js";

const CE_URL = "https://ce.us-east-1.amazonaws.com/";

/** One request carries both metrics; CE bills per request, not per metric. */
const CE_METRICS = ["UnblendedCost", "AmortizedCost"];

/**
 * Consumption billed on demand — pass 1a's filter.
 *
 * Spelled as the Cost and Usage Report's `lineItem/LineItemType` tokens, which
 * is what `RECORD_TYPE` carries. `Dimensions` filters match `EQUALS` and
 * `CASE_SENSITIVE` by default, so the casing matters — and a miss is harmless
 * by construction (the value lands in pass 2 instead).
 */
export const AWS_ON_DEMAND_RECORD_TYPES = ["Usage"];

/**
 * Consumption a commitment covered — pass 1b's filter. Both tokens map to
 * `commitment_covered_usage`, so CE may sum them together within the pass.
 */
export const AWS_COVERED_RECORD_TYPES = ["DiscountedUsage", "SavingsPlanCoveredUsage"];

/**
 * All consumption, whatever rate it was billed at: the union of the two lists
 * above, and the single place pass 2's complement is defined. Keeping it a
 * derived union is what guarantees 1a ∪ 1b ∪ 2 is still the whole bill.
 */
export const AWS_USAGE_RECORD_TYPES = [...AWS_ON_DEMAND_RECORD_TYPES, ...AWS_COVERED_RECORD_TYPES];

// ─── Record type → charge type ──────────────────────────────────────────────

/**
 * Fold a record type to a comparison key so the CUR token and the Cost
 * Explorer console's label for the same thing (`SavingsPlanCoveredUsage` vs
 * "Savings Plan covered usage") resolve to one entry. AWS is not consistent
 * about which spelling the API returns and the two docs disagree, so both are
 * accepted rather than guessed between.
 */
function recordTypeKey(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * The mapping table, built only from record types AWS actually documents —
 * the CUR's `lineItem/LineItemType` values
 * (https://docs.aws.amazon.com/cur/latest/userguide/Lineitem-columns.html)
 * and Cost Explorer's "Charge type" filter values
 * (https://docs.aws.amazon.com/cost-management/latest/userguide/ce-filtering.html).
 * Nothing here is invented; anything absent falls through to `other`.
 *
 * | AWS record type            | console label             | ours                  |
 * | -------------------------- | ------------------------- | --------------------- |
 * | `Usage`                    | Usage                     | `usage`                    |
 * | `DiscountedUsage`          | Reservation applied usage | `commitment_covered_usage` |
 * | `SavingsPlanCoveredUsage`  | Savings Plan covered usage| `commitment_covered_usage` |
 * | `SavingsPlanNegation`      | Savings Plan negation     | `commitment_discount` |
 * | `SavingsPlanUpfrontFee`    | Savings Plan upfront fee  | `commitment_fee`      |
 * | `SavingsPlanRecurringFee`  | Savings Plan recurring fee| `commitment_fee`      |
 * | `RIFee`                    | Recurring reservation fee | `commitment_fee`      |
 * | `Fee`                      | Upfront reservation fee   | `commitment_fee`      |
 * | `Credit`                   | Credit                    | `credit`              |
 * | `Refund`                   | Refund                    | `refund`              |
 * | `Tax`                      | Tax                       | `tax`                 |
 * | —                          | Support fee               | `support`             |
 * | `Discount`, `BundledDiscount`, `FlatRateSubscription`, "Other out-of-cycle charges", anything new | | `other` |
 *
 * Three notes on the awkward entries:
 *
 * - **`DiscountedUsage` and `SavingsPlanCoveredUsage` are
 *   `commitment_covered_usage`, not `commitment_discount` and not plain
 *   `usage`.** They are consumption that happens to be covered — the
 *   commitment's effect is in the rate, not in the row's nature — so calling
 *   them discounts would empty the consumption series of everything a
 *   commitment touches. But they are not indistinguishable from on-demand
 *   consumption either, and collapsing them into `usage` is what made coverage
 *   unmeasurable on AWS: `SAVINGS_PLAN_ARN` and `RESERVATION_ID` cannot be
 *   grouped by (see the header), so the record type is the *only* thing this
 *   API will ever say about coverage. The host's coverage numerator reads it
 *   directly.
 *
 *   Both still sit in {@link AWS_USAGE_RECORD_TYPES}, so pass 1 keeps its
 *   region and pass 2 keeps its exact complement. What changed is the charge
 *   type they are stamped with, not which pass they arrive in.
 *
 *   `SavingsPlanNegation` — the separate negative offset line AWS writes
 *   against covered usage — is the actual `commitment_discount`. RIs have no
 *   equivalent line; their discount is baked into `DiscountedUsage`'s rate.
 * - **`Fee` is `commitment_fee` despite covering more than commitments.** AWS
 *   documents it as "Any upfront annual fee that you paid for subscriptions.
 *   For example, the upfront fee that you paid for an All Upfront RI or a
 *   Partial Upfront RI", and the console's label for it is "Upfront
 *   reservation fee". Filing an RI purchase — the single largest one-day
 *   charge most accounts ever see — under `other` to protect against the
 *   occasional non-RI subscription is the worse trade.
 * - **The discount families go to `other`.** `Discount` (Enterprise Discount
 *   Program, private rate, solution-provider), `BundledDiscount` and
 *   `Distributor Discount` are a category the union has no member for. `credit`
 *   means a promotional or negotiated credit and would be a near-miss; taking
 *   it would make a negotiated rate reduction indistinguishable from spending
 *   promotional balance. They read as `other`, which is what `other` is for.
 *
 * `adjustment` has no AWS record type at all and is never produced here.
 */
const RECORD_TYPE_CHARGE_TYPES: Record<string, CostChargeType> = {
  // Consumption billed on demand.
  usage: "usage",
  // Consumption a commitment covered — still consumption, but identifiable as
  // covered, which is what makes coverage measurable without a commitment id.
  discountedusage: "commitment_covered_usage",
  reservationappliedusage: "commitment_covered_usage",
  savingsplancoveredusage: "commitment_covered_usage",
  // Buying a commitment.
  rifee: "commitment_fee",
  recurringreservationfee: "commitment_fee",
  fee: "commitment_fee",
  upfrontreservationfee: "commitment_fee",
  savingsplanupfrontfee: "commitment_fee",
  savingsplanrecurringfee: "commitment_fee",
  // The negative line a commitment produces against the usage it covers.
  savingsplannegation: "commitment_discount",
  // The rest of the bill.
  credit: "credit",
  refund: "refund",
  tax: "tax",
  support: "support",
  supportfee: "support",
};

/**
 * Normalize one Cost Explorer `RECORD_TYPE` value onto our union.
 *
 * Unrecognised values — AWS's discount families, flat-rate subscriptions,
 * out-of-cycle charges, and whatever AWS adds next — become `other` rather
 * than being folded into the nearest member. `usage` is the wrong default for
 * an unknown charge: it would quietly overstate consumption, which is the one
 * number every other reading is built on.
 */
export function mapAwsRecordType(raw: string): CostChargeType {
  return RECORD_TYPE_CHARGE_TYPES[recordTypeKey(raw)] ?? "other";
}

// ─── Request plumbing ───────────────────────────────────────────────────────

interface CeGroup {
  Keys?: string[];
  Metrics?: Record<string, { Amount?: string; Unit?: string }>;
}

interface CeResultByTime {
  TimePeriod?: { Start?: string };
  Groups?: CeGroup[];
}

interface CeResponse {
  ResultsByTime?: CeResultByTime[];
  NextPageToken?: string;
}

interface CeGroupVisit {
  date: string;
  keys: string[];
  unblended: number;
  amortized: number;
  /**
   * Whether CE actually returned an `AmortizedCost` figure for this group, as
   * opposed to {@link amount} defaulting it to 0. The host stores "reported"
   * separately from the value precisely so a reported 0 (a purchase, which
   * amortizes to nothing on its purchase day) stays distinguishable from an
   * absent one (fall back to cash) — so this collector must not claim the
   * first when it has the second.
   */
  amortizedReported: boolean;
  currency: string;
}

/** CE's pseudo-regions for global/unattributed spend map to "no region". */
function normalizeRegion(raw: string): string {
  if (!raw || raw === "NoRegion" || raw === "global") return "";
  return raw;
}

function amount(metric: { Amount?: string } | undefined): number {
  const n = Number(metric?.Amount ?? "0");
  return Number.isFinite(n) ? n : 0;
}

/**
 * True only when CE returned a parseable figure for this metric. `undefined`
 * and an unparseable string both mean "no opinion" — {@link amount} floors
 * them to 0, and a 0 that is really an absence must not be stamped as a
 * reported amortized amount.
 */
function reported(metric: { Amount?: string } | undefined): boolean {
  return metric?.Amount !== undefined && Number.isFinite(Number(metric.Amount));
}

/**
 * Run one `GetCostAndUsage` query to exhaustion, handing every group to
 * `visit`. The filter and grouping stay byte-identical across pages — CE
 * rejects a paginated request whose parameters changed (`RequestChangedException`).
 */
async function eachCeGroup(
  creds: AwsCredentials,
  timePeriod: { Start: string; End: string },
  groupBy: Array<{ Type: string; Key: string }>,
  filter: unknown,
  visit: (group: CeGroupVisit) => void,
): Promise<void> {
  let nextPageToken: string | undefined;
  do {
    const body = JSON.stringify({
      TimePeriod: timePeriod,
      Granularity: "DAILY",
      Metrics: CE_METRICS,
      GroupBy: groupBy,
      Filter: filter,
      ...(nextPageToken ? { NextPageToken: nextPageToken } : {}),
    });

    const res = await fetchSigned({
      method: "POST",
      url: CE_URL,
      headers: {
        "content-type": "application/x-amz-json-1.1",
        "x-amz-target": "AWSInsightsIndexService.GetCostAndUsage",
      },
      body,
      service: "ce",
      // Cost Explorer only exists in us-east-1 — sign for that region
      // regardless of where the account's resources live.
      credentials: { ...creds, region: "us-east-1" },
    });
    const data = (await res.json()) as CeResponse;

    for (const result of data.ResultsByTime ?? []) {
      const date = result.TimePeriod?.Start;
      if (!date) continue;
      for (const group of result.Groups ?? []) {
        const unblendedMetric = group.Metrics?.["UnblendedCost"];
        const amortizedMetric = group.Metrics?.["AmortizedCost"];
        visit({
          date,
          keys: group.Keys ?? [],
          unblended: amount(unblendedMetric),
          amortized: amount(amortizedMetric),
          amortizedReported: reported(amortizedMetric),
          currency: unblendedMetric?.Unit ?? amortizedMetric?.Unit ?? "USD",
        });
      }
    }
    nextPageToken = data.NextPageToken;
  } while (nextPageToken);
}

// ─── Accumulation ───────────────────────────────────────────────────────────

interface Bucket {
  date: string;
  service: string;
  region: string;
  chargeType: CostChargeType;
  currency: string;
  amount: number;
  amortizedAmount: number;
  /**
   * Whether any CE group folded into this bucket reported an amortized figure.
   * A bucket nothing reported one for emits **no** `amortizedAmount` at all —
   * see {@link Buckets.rows}.
   */
  amortizedReported: boolean;
}

function bucketKey(b: Omit<Bucket, "amount" | "amortizedAmount" | "amortizedReported">): string {
  // NUL-joined: service names carry spaces and dashes ("Amazon Elastic Compute
  // Cloud - Compute"), and a printable separator would let ("A B", region "C")
  // collide with ("A", region "B C").
  return [b.date, b.service, b.region, b.chargeType, b.currency].join("\u0000");
}

/**
 * Rows are accumulated rather than pushed because several record types share
 * one charge type: an account with both an RI recurring fee and a Savings Plan
 * upfront fee on the same service and day produces two CE groups that are one
 * `commitment_fee` row here. Emitting them separately would hand the host two
 * rows identical in every column it keys on, and its ReplacingMergeTree would
 * keep whichever arrived last — silently losing one of the two fees.
 */
class Buckets {
  private readonly map = new Map<string, Bucket>();

  add(bucket: Bucket): void {
    const key = bucketKey(bucket);
    const existing = this.map.get(key);
    if (existing) {
      existing.amount += bucket.amount;
      existing.amortizedAmount += bucket.amortizedAmount;
      existing.amortizedReported ||= bucket.amortizedReported;
      return;
    }
    this.map.set(key, { ...bucket });
  }

  has(bucket: Omit<Bucket, "amount" | "amortizedAmount" | "amortizedReported">): boolean {
    return this.map.has(bucketKey(bucket));
  }

  /**
   * `amortizedAmount` is **omitted** for a bucket CE never reported one for,
   * because absent and zero are different answers and the host keeps them
   * apart (`amortized_reported` in `server-core/src/clickhouse/migrate.ts`).
   * Emitting it unconditionally would stamp `amortized_reported = 1` on every
   * row this file produces — including {@link fetchUnattributed}'s, whose
   * groups aggregate all record types — so a response that carried
   * `UnblendedCost` but no `AmortizedCost` would read as *zero* in every
   * amortized view instead of falling back to the cash figure it has.
   */
  rows(): CostRow[] {
    return [...this.map.values()].map((b) => ({
      date: b.date,
      service: b.service,
      region: b.region,
      currency: b.currency,
      amount: b.amount,
      chargeType: b.chargeType,
      ...(b.amortizedReported ? { amortizedAmount: b.amortizedAmount } : {}),
    }));
  }
}

// ─── Entry point ────────────────────────────────────────────────────────────

/** True for the 400 CE returns when it rejects the shape of a request. */
function isValidationError(err: unknown): boolean {
  return /ValidationException/i.test(err instanceof Error ? err.message : String(err));
}

/**
 * The pre-attribution query: one unfiltered request grouped by SERVICE +
 * REGION, every row `usage`. Used only when CE rejects the attributed
 * requests, so an account in a partition that does not support `RECORD_TYPE`
 * keeps reporting spend instead of failing collection outright.
 */
async function fetchUnattributed(
  creds: AwsCredentials,
  timePeriod: { Start: string; End: string },
): Promise<CostRow[]> {
  const buckets = new Buckets();
  await eachCeGroup(
    creds,
    timePeriod,
    [
      { Type: "DIMENSION", Key: "SERVICE" },
      { Type: "DIMENSION", Key: "REGION" },
    ],
    undefined,
    (group) => {
      if (group.unblended === 0 && group.amortized === 0) return;
      buckets.add({
        date: group.date,
        service: group.keys[0] ?? "",
        region: normalizeRegion(group.keys[1] ?? ""),
        // No charge type is claimed here, so rows hash exactly as they did
        // before this file existed and replace their predecessors cleanly.
        chargeType: "usage",
        currency: group.currency,
        amount: group.unblended,
        amortizedAmount: group.amortized,
        amortizedReported: group.amortizedReported,
      });
    },
  );
  // `usage` is what these rows already were, and the host hashes a `usage`
  // row exactly as it hashes one with no charge type at all — so falling
  // back here replaces prior rows rather than shadowing them.
  return buckets.rows();
}

/**
 * The attributed collection, with the pre-attribution single-request shape as a
 * fallback.
 *
 * The fallback is flagged `degraded`, and that flag is load-bearing rather than
 * informational. `ValidationException` fires both for an account that can never
 * group by `RECORD_TYPE` and for a *transient* rejection, and the fallback
 * writes a strictly coarser key space than the collection before it: one
 * undifferentiated `usage` row per cell, no attribution rows at all.
 *
 * The host reconciles by zeroing stored keys a collection did not rewrite, so
 * unflagged, one bad request would tombstone every attribution row for the days
 * in the chunk — and since a backfilled account only re-fetches
 * `restatementDays` (3), a flap that ages past that window would never be
 * repaired. Flagged, the host skips tombstoning for the pass and the stored
 * rows survive, which is what happened before reconciliation existed. See
 * `CostFetchResult.degraded` in `@infrawrench/plugin-base`.
 */
export async function fetchAwsCostData(
  creds: AwsCredentials,
  range: CostFetchRange,
): Promise<CostFetchResult> {
  // TimePeriod.End is exclusive; the host's range is inclusive.
  const endExclusive = new Date(`${range.toDate}T00:00:00.000Z`);
  endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
  const timePeriod = {
    Start: range.fromDate,
    End: endExclusive.toISOString().slice(0, 10),
  };

  const consumptionGroupBy = [
    { Type: "DIMENSION", Key: "SERVICE" },
    { Type: "DIMENSION", Key: "REGION" },
  ];
  // Pass 2's complement is taken against the *union*, so the three filters
  // partition the bill exactly however the two consumption passes are split.
  const usageFilter = {
    Dimensions: { Key: "RECORD_TYPE", Values: AWS_USAGE_RECORD_TYPES },
  };

  const buckets = new Buckets();
  // Services pass 2 saw, so a service whose whole spend is non-usage can be
  // zeroed at region "" — see the module header on stale rows.
  const nonUsageServices = new Map<string, { date: string; service: string; currency: string }>();

  /**
   * One consumption pass: same grouping, same accumulation, different
   * `RECORD_TYPE` filter and therefore a different charge type.
   *
   * Unlike the previous collector these keep groups that price to zero: CE
   * only returns a group when the filter matched something there, so a zero
   * here means "this cell's consumption is now nothing", and writing it is what
   * replaces a stored row that used to hold this cell's tax or fees. It matters
   * doubly for 1b, whose unblended amounts are zero *by definition* — an RI's
   * `UnblendedRate` is zero — and whose whole value is in `AmortizedCost`.
   */
  const consumptionPass = (recordTypes: string[], chargeType: CostChargeType): Promise<void> =>
    eachCeGroup(
      creds,
      timePeriod,
      consumptionGroupBy,
      { Dimensions: { Key: "RECORD_TYPE", Values: recordTypes } },
      (group) => {
        buckets.add({
          date: group.date,
          service: group.keys[0] ?? "",
          region: normalizeRegion(group.keys[1] ?? ""),
          chargeType,
          currency: group.currency,
          amount: group.unblended,
          amortizedAmount: group.amortized,
          amortizedReported: group.amortizedReported,
        });
      },
    );

  try {
    // Pass 1a — consumption billed on demand, with its region.
    await consumptionPass(AWS_ON_DEMAND_RECORD_TYPES, "usage");

    // Pass 1b — consumption an RI or Savings Plan covered, with its region.
    // Separated from 1a only so the two can carry different charge types;
    // together they are exactly pass 2's complement.
    await consumptionPass(AWS_COVERED_RECORD_TYPES, "commitment_covered_usage");

    // Pass 2 — everything else, split by what kind of charge it is. The `Not`
    // makes this the exact complement of 1a ∪ 1b, so no line is dropped and
    // none is counted twice.
    await eachCeGroup(
      creds,
      timePeriod,
      [
        { Type: "DIMENSION", Key: "SERVICE" },
        { Type: "DIMENSION", Key: "RECORD_TYPE" },
      ],
      { Not: usageFilter },
      (group) => {
        const service = group.keys[0] ?? "";
        buckets.add({
          date: group.date,
          service,
          // One grouping slot went to RECORD_TYPE, so these rows carry no
          // region. CE reports most of them as NoRegion regardless.
          region: "",
          chargeType: mapAwsRecordType(group.keys[1] ?? ""),
          currency: group.currency,
          amount: group.unblended,
          amortizedAmount: group.amortized,
          amortizedReported: group.amortizedReported,
        });
        const key = `${group.date}\u0000${service}\u0000${group.currency}`;
        if (!nonUsageServices.has(key)) {
          nonUsageServices.set(key, { date: group.date, service, currency: group.currency });
        }
      },
    );
  } catch (err) {
    if (!isValidationError(err)) throw err;
    // CE will not attribute for this account — report spend unattributed
    // rather than reporting nothing, and say so, so the host does not read a
    // coarser pass as evidence that the finer rows are gone.
    return { rows: await fetchUnattributed(creds, timePeriod), degraded: true };
  }

  // Zero out the `(day, service, "")` usage row a previous, unattributed
  // collection left behind wherever that cell turns out to hold no on-demand
  // usage —
  // the whole of a Savings Plan fee service, or just the no-region tax of a
  // service whose usage is all regional. Same key, so this replaces rather
  // than adds; on a dataset that never had one it is an inert empty row.
  for (const { date, service, currency } of nonUsageServices.values()) {
    const identity = {
      date,
      service,
      region: "",
      chargeType: "usage" as const,
      currency,
    };
    if (buckets.has(identity)) continue;
    // Not "amortized to zero": this row has no money on any basis, so leaving
    // the amortized figure unreported and letting readers fall back to `amount`
    // finds zero either way. Same reasoning as the host's tombstone rows in
    // `server-core/src/clickhouse/cost-reconcile.ts`.
    buckets.add({ ...identity, amount: 0, amortizedAmount: 0, amortizedReported: false });
  }

  return { rows: buckets.rows() };
}
