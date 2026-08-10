/**
 * Actual-spend collection via the Cost Management Query API.
 *
 * `POST {scope}/providers/Microsoft.CostManagement/query`
 * (https://learn.microsoft.com/en-us/rest/api/cost-management/query/usage),
 * `ActualCost` at subscription scope, Daily granularity. The response is
 * columnar (`properties.columns` + `properties.rows`) with no guaranteed
 * column order, so indices are resolved dynamically from the column metadata,
 * and long results page through `properties.nextLink` (which carries the
 * `$skiptoken`).
 *
 * The service principal needs the "Cost Management Reader" role on the
 * subscription — the plain "Reader" role used for ARM resource listing is
 * NOT sufficient for cost queries. Azure serves ~13 months of history and
 * rate-limits this API aggressively; a 429 surfaces as a thrown error from
 * the HTTP helper and the host backs off.
 *
 * ─── Why this takes three queries ────────────────────────────────────────
 *
 * The constraint that shapes everything below is in Azure's own API contract
 * for `QueryDataset.grouping`:
 *
 *   "Array of group by expression to use in the query. Query can have up to
 *    2 group by clauses."
 *   — Microsoft.CostManagement TypeSpec, `@maxItems(2)` on QueryDataset.grouping
 *     (https://github.com/Azure/azure-rest-api-specs — specification/cost-management/
 *      resource-manager/Microsoft.CostManagement/CostManagement/models.tsp)
 *
 * Two slots, and this plugin already declares two cost dimensions (service and
 * region). There is no way to get `(ServiceName, ResourceLocation, ChargeType,
 * BenefitId)` out of one query, so charge type and commitment attribution
 * cannot simply be bolted onto the existing grouping. Instead:
 *
 * - {@link USAGE_GROUPING} over `ActualCost` — `[ServiceName,
 *   ResourceLocation]` filtered to `ChargeType In ("Usage")`. This is the
 *   consumption backbone and produces rows shaped exactly like the ones this
 *   collector produced before charge types existed.
 * - {@link USAGE_GROUPING} over `AmortizedCost` — the same cells on the other
 *   dataset. See "The amortized pass" below; this is what makes commitment
 *   coverage measurable at all.
 * - {@link ATTRIBUTION_GROUPING} — `[ChargeType, BenefitId]`, unfiltered.
 *   Everything that is not consumption, attributed to the commitment that
 *   caused it. Spending the second slot on `BenefitId` rather than
 *   `ServiceName` costs nothing real, because Azure does not report a service
 *   or a region for these rows anyway: "Purchases and Marketplace usage will
 *   show as **No service name** or **unassigned**" and "Purchases and
 *   Marketplace usage may be shown as unassigned, or **No resource location**"
 *   (https://learn.microsoft.com/en-us/azure/cost-management-billing/costs/group-filter).
 * - {@link ATTRIBUTION_GROUPING} over `AmortizedCost`, filtered to
 *   {@link UNUSED_COMMITMENT_FILTER} — the committed hours nothing consumed.
 *   See "Unused commitment hours" below.
 *
 * The attribution query is deliberately *unfiltered* rather than filtered to a
 * hard-coded list of non-usage charge types: `QueryOperatorType` only has `In`
 * (no `NotIn`), so a filtered complement would silently drop money under any
 * charge type Azure adds later. Unfiltered, the `Usage` rows are discarded
 * here and anything unrecognised lands in `"other"` — see
 * {@link mapAzureChargeType}. (The unused-commitment query *is* filtered, and
 * safely so: it asks for two named charge types rather than for a complement,
 * so a charge type Azure adds later is still caught by the unfiltered pass.)
 *
 * Four queries per month-chunk instead of one. Azure prices this API in query
 * processing units, "one QPU is deducted for one month of data queried", with
 * per-*tenant* quotas of 12 QPU/10s, 60 QPU/min and 600 QPU/hour
 * (https://learn.microsoft.com/en-us/azure/cost-management-billing/costs/manage-automation).
 * A daily incremental collection goes from 1 request to 4 — 3 on a subscription
 * that refuses the amortized dataset, which skips both amortized passes; a
 * 395-day backfill from 13 to 52. Both are well inside the hourly quota for a
 * single account; a tenant with dozens of subscriptions backfilling at once was
 * already past the per-minute quota before this change and relies on the host's
 * backoff.
 *
 * ─── The amortized pass, and why coverage needs it ───────────────────────
 *
 * `type` also accepts `AmortizedCost`, the dataset where a reservation
 * purchase is spread across the term it buys. It is not a second opinion on
 * the same numbers — for a committed estate it is the **only** dataset that
 * prices covered consumption at all.
 *
 * In `ActualCost`, usage a reservation covers has an `EffectivePrice` of zero:
 * the money left the account when the reservation was bought. So on cash
 * figures a fully-reserved fleet costs nothing and the reservation looks like
 * a pure expense — and commitment coverage, which is covered spend over total
 * spend, is 0 ÷ something for every org that has ever bought anything. A ratio
 * that is structurally zero is worse than no ratio, because 0% looks like an
 * answer.
 *
 * The decomposition that makes it measurable needs **no extra grouping slot**,
 * which is what makes it affordable here. For one `(day, service, region,
 * currency)` cell:
 *
 *     cash      = on-demand consumption            (covered priced at 0)
 *     amortized = on-demand consumption + covered  (covered priced at its rate)
 *     covered   = amortized − cash
 *
 * so the cell is emitted as a `usage` row worth `cash` on both bases plus a
 * `commitment_covered_usage` row worth `0` cash and `covered` amortized. The
 * identity holds only while both figures are non-negative — a negative `Usage`
 * correction that has reached one dataset and not the other would otherwise
 * "decompose" into coverage that was never bought — so a cell holding one is
 * emitted whole instead. Those
 * covered rows carry no `commitmentId` — which reservation covered the hour is
 * not in this response — and they do not need one: the host's coverage
 * numerator reads the charge type. That is also why this works on any
 * agreement, while `BenefitId` (the attribution pass's second grouping) exists
 * only on EA and MCA.
 *
 * The pass is **optional**, and a refusal is a normal state rather than a
 * failure: "Cost Analysis doesn't support viewing amortized reservation costs
 * for a pay-as-you-go subscription"
 * (https://learn.microsoft.com/en-us/azure/cost-management-billing/reservations/view-amortized-costs),
 * and MOSA accounts "don't include Marketplace or commitment discounts
 * purchases" at all
 * (https://learn.microsoft.com/en-us/azure/cost-management-billing/costs/understand-cost-mgt-data).
 * When it is refused, every cell falls back to one undifferentiated `usage` row
 * with no `amortizedAmount` — absent, meaning "no opinion", so the host uses
 * the cash figure — and nothing else about collection changes.
 *
 * One consequence worth stating plainly:
 *
 * - **Purchase rows are stamped `amortizedAmount: 0`, and only when the
 *   amortized pass ran.** The `AmortizedCost` dataset contains no `Purchase`
 *   row; that money *is* the covered-usage rows (and, below, the unused ones).
 *   Zero is therefore the honest amortized value of a purchase on its purchase
 *   day, and stating it (rather than omitting it, which means "no opinion" and
 *   falls back to cash) is what keeps the amortized view from showing the
 *   purchase at full price *and* every amortized slice of it. This is only
 *   representable because the host stores "reported" separately from the value
 *   — see the `amortized_reported` column in
 *   `server-core/src/clickhouse/migrate.ts`.
 *
 * ─── Unused commitment hours ──────────────────────────────────────────────
 *
 * The consumption passes above filter to `ChargeType In ("Usage")`, so they see
 * only the value a commitment *delivered*. What a commitment wasted arrives as
 * `UnusedReservation` / `UnusedSavingsPlan`, charge types that exist **only in
 * the amortized dataset** — Cost Analysis lists them among the amortized-only
 * values
 * (https://learn.microsoft.com/en-us/azure/cost-management-billing/costs/group-filter) —
 * and are therefore invisible to the `ActualCost` attribution pass as well.
 * Without them an amortized grand total is short by exactly the money a
 * reservation wasted, which is the single number a commitments feature exists
 * to expose. Pass 2b collects them, and three properties keep the rest of the
 * picture intact:
 *
 * - **Cash is untouched.** These rows are amortized-only by construction, so
 *   they are emitted with `amount: 0` and their value on `amortizedAmount`
 *   alone. No cash total anywhere moves.
 * - **They cannot enter the covered-usage decomposition.** That subtraction is
 *   computed from the two `ChargeType In ("Usage")` queries; an unused row is
 *   not a `Usage` row on either dataset and so is in neither map. Feeding it in
 *   would be a straight double count: the same committed money would appear
 *   once as delivered and once as wasted.
 * - **They are `commitment_fee`, not covered usage**, per the mapping table in
 *   {@link mapAzureChargeType} — obligation the provider billed and nothing
 *   claimed. The host counts only `usage` and `commitment_covered_usage` toward
 *   coverage and toward a commitment's delivered total
 *   (`CONSUMPTION_SQL` in `server-core/src/clickhouse/commitment-readers.ts`),
 *   so an unused row raises neither ratio — which is the point: unused hours
 *   are obligation *not* delivered, and utilization must fall when they appear,
 *   never rise.
 *
 * An unused row shares its whole host key — `(day, "", "", currency,
 * commitment_fee, benefitId)` — with the `Purchase` row of the same commitment
 * on a day that carries both. They are therefore merged rather than pushed
 * separately: cash from the purchase, amortized from the unused hours. Two rows
 * would be two versions of one ReplacingMergeTree row and `FINAL` would keep
 * whichever landed last.
 *
 * ─── Re-collecting over already-stored rows ──────────────────────────────
 *
 * `cost_daily` is a ReplacingMergeTree whose sort key cannot carry charge type
 * or commitment id, so `server-core/src/clickhouse/cost-writers.ts` folds them
 * into `tags_hash` — but only when they are non-default, precisely so that a
 * plain usage row keeps hashing the way it always did.
 *
 * The consequence: a `(day, service, region)` cell that used to be one row
 * (usage + purchases + tax, summed by the unfiltered query) becomes a usage row
 * at the *same* hash plus attribution rows at *new* hashes. Cells that contain
 * any on-demand consumption re-state correctly and the day's total is
 * preserved. A cell that contained *only* non-consumption money — or, now,
 * only commitment-covered consumption — does not: nothing is written at its old
 * key any more, and a ReplacingMergeTree never deletes what is not rewritten.
 *
 * **This is the host's problem and the host solves it**, in
 * `server-core/src/clickhouse/cost-reconcile.ts`: any key stored for a day a
 * collection restated, which that collection did not rewrite, is superseded by
 * a zero-amount row in the same insert. It is generic (the hazard belongs to
 * every plugin that ever changes what it stamps, not to this one) and it
 * happens on the next collection of each affected day, so this file's upgrade
 * needs no operator step.
 *
 * The mechanism cuts both ways, which is why {@link fetchAzureCostData} reports
 * a degraded pass. A fallback to {@link fetchLegacy} writes only coarse `usage`
 * rows; read as authoritative it would zero every attribution row for the
 * chunk, and a transient flap that ages past `restatementDays` would never be
 * repaired. Flagged, the host skips tombstoning for that pass.
 *
 * The third query this file once considered — re-running the old unfiltered
 * grouping purely to enumerate cells needing a tombstone — is not what the
 * third query above is. That one could not have worked anyway: the attribution
 * pass groups `[ChargeType, BenefitId]` and so cannot name the service a stale
 * row is filed under, which is exactly the kind of key-space knowledge a plugin
 * does not have and the host does.
 */

import type {
  CostChargeType,
  CostFetchRange,
  CostFetchResult,
  CostRow,
} from "@infrawrench/plugin-base";
import { normalizeAzureCommitmentId } from "./commitments.js";
import { ARM, type AzureHttpContext } from "./shared.js";

const COST_API_VERSION = "2025-03-01";

/** Consumption, broken down by the two dimensions this plugin declares. */
const USAGE_GROUPING = [
  { type: "Dimension", name: "ServiceName" },
  { type: "Dimension", name: "ResourceLocation" },
] as const;

/**
 * Everything else, attributed to the commitment that caused it. `BenefitId` is
 * the column that spans both commitment kinds — the FOCUS conversion rules key
 * off its resource-provider segment, `/microsoft.capacity/` for reservations
 * and `/microsoft.billingbenefits/` for savings plans
 * (https://learn.microsoft.com/en-us/cloud-computing/finops/focus/convert) —
 * which is also why it is an ARM resource id and therefore joinable against
 * the reservation ids `commitments.ts` reports. `ReservationId` is the wrong
 * choice here: it is a bare identifier scoped to a reservation order, matches
 * nothing in our inventory, and says nothing about savings plans.
 */
const ATTRIBUTION_GROUPING = [
  { type: "Dimension", name: "ChargeType" },
  { type: "Dimension", name: "BenefitId" },
] as const;

interface QueryColumn {
  name?: string;
  type?: string;
}

interface QueryResponse {
  properties?: {
    columns?: QueryColumn[];
    rows?: Array<Array<string | number>>;
    /** Full URL (with $skiptoken) for the next page, when more rows exist. */
    nextLink?: string;
  };
}

interface QueryGrouping {
  readonly type: string;
  readonly name: string;
}

/**
 * Azure's `ChargeType` → our {@link CostChargeType}.
 *
 * No single Microsoft page enumerates the column's values; the complete set is
 * the one the FOCUS conversion rules explicitly handle —
 * `Usage`, `Purchase`, `Refund`, `UnusedReservation`, `UnusedSavingsPlan`,
 * `Credit`, `Tax`, and otherwise `RoundingAdjustment`
 * (https://learn.microsoft.com/en-us/cloud-computing/finops/focus/convert,
 * https://learn.microsoft.com/en-us/azure/cost-management-billing/automate/understand-usage-details-fields).
 *
 *   Azure                  had a BenefitId?   ours               why
 *   ─────────────────────  ────────────────   ─────────────────  ──────────────────────────────
 *   Usage                  —                  usage              consumption; the default
 *   Purchase               yes                commitment_fee     a reservation or savings plan
 *   Purchase               no                 other              Marketplace / support / other
 *                                                                Azure purchase — real money, but
 *                                                                not a commitment and not usage
 *   Refund                 —                  refund             MCA only; EA and PAYG never emit it
 *   UnusedReservation      —                  commitment_fee     committed money no usage claimed
 *   UnusedSavingsPlan      —                  commitment_fee     same, for a savings plan
 *   Credit                 —                  credit
 *   Tax                    —                  tax
 *   RoundingAdjustment     —                  adjustment         billing-profile / enrollment scope
 *   anything else          —                  other              never usage: a near-miss here
 *                                                                overstates consumption
 *
 * Two entries deserve their reasoning spelled out.
 *
 * **`Purchase` is not synonymous with a commitment.** It covers Marketplace
 * offerings and support plans as well as reservations and savings plans, and
 * nothing else in the response distinguishes them — `PricingModel` is no help,
 * because "Purchases show as OnDemand"
 * (https://learn.microsoft.com/en-us/azure/cost-management-billing/costs/group-filter).
 * The presence of a `BenefitId` is the distinguishing evidence, so a purchase
 * without one is `other` rather than a `commitment_fee` that would inflate
 * every commitment report. It is not mapped to `support` either: some of those
 * purchases genuinely are support plans and some are Marketplace software, and
 * this data cannot tell which.
 *
 * **`UnusedReservation` / `UnusedSavingsPlan` cannot appear in `ActualCost`**
 * — they exist only in the amortized dataset
 * (https://learn.microsoft.com/en-us/azure/cost-management-billing/costs/group-filter) —
 * so they reach this function only from the amortized unused-commitment pass,
 * never from the unfiltered `ActualCost` attribution pass. Mapping them to
 * `usage` (which is what FOCUS does) would be actively wrong for us: the host
 * counts commitment-stamped `usage` rows as spend *delivered* against the
 * commitment, and unused hours are the precise opposite of that.
 */
export function mapAzureChargeType(chargeType: string, commitmentId: string): CostChargeType {
  switch (chargeType) {
    case "Usage":
      return "usage";
    case "Purchase":
      return commitmentId ? "commitment_fee" : "other";
    case "Refund":
      return "refund";
    case "UnusedReservation":
    case "UnusedSavingsPlan":
      return "commitment_fee";
    case "Credit":
      return "credit";
    case "Tax":
      return "tax";
    case "RoundingAdjustment":
      return "adjustment";
    default:
      return "other";
  }
}

/** UsageDate arrives as a yyyyMMdd integer (e.g. 20260701) → "2026-07-01". */
function formatUsageDate(raw: string | number | undefined): string {
  const s = String(raw ?? "");
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  // Defensive: some scopes return ISO date-times instead of integers.
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return "";
}

/** ResourceLocation placeholders for global/unattributed spend map to "no region". */
function normalizeRegion(raw: string): string {
  if (!raw || raw === "Unassigned" || raw === "Unknown" || raw === "All Regions") return "";
  return raw;
}

/**
 * Azure spells "this row has no benefit" several ways depending on scope and
 * dataset — an absent column, an empty string, or one of the placeholder
 * labels Cost Analysis renders. All of them mean "not attributable", and an
 * attribution to the literal string "No benefit" would be worse than none.
 */
function normalizeBenefitId(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const lower = trimmed.toLowerCase();
  if (lower === "unassigned" || lower === "no benefit" || lower === "no reservation") return "";
  // Only an ARM resource id can join against the commitment inventory; a bare
  // label is not an id and pretending otherwise produces an unmatchable key.
  if (!trimmed.startsWith("/")) return "";
  return normalizeAzureCommitmentId(trimmed);
}

/** One page-following POST loop over the query endpoint. */
async function runQuery(
  ctx: AzureHttpContext,
  range: CostFetchRange,
  grouping: readonly QueryGrouping[],
  filter: unknown,
  onPage: (rows: Array<Array<string | number>>, idx: ColumnIndices) => void,
  type: "ActualCost" | "AmortizedCost" = "ActualCost",
): Promise<void> {
  // Both timePeriod bounds are inclusive, matching the host's range semantics.
  const body = {
    type,
    timeframe: "Custom",
    timePeriod: {
      from: `${range.fromDate}T00:00:00+00:00`,
      to: `${range.toDate}T23:59:59+00:00`,
    },
    dataset: {
      granularity: "Daily",
      aggregation: { totalCost: { name: "Cost", function: "Sum" } },
      grouping,
      ...(filter ? { filter } : {}),
    },
  };

  let url: string | undefined =
    `${ARM}/subscriptions/${ctx.subscriptionId}` +
    `/providers/Microsoft.CostManagement/query?api-version=${COST_API_VERSION}`;

  while (url) {
    const data: QueryResponse = await ctx.post<QueryResponse>(url, body);
    const props = data.properties;
    // 204 No Content (no spend in the window) comes back as {} from the
    // HTTP helper — nothing to parse.
    if (!props) break;

    const columns = props.columns ?? [];
    const rows = props.rows ?? [];
    // Column order is not guaranteed, so indices are resolved from the
    // metadata — once per page rather than once per row.
    if (rows.length > 0) onPage(rows, indices(columns));

    url = props.nextLink || undefined;
  }
}

interface ColumnIndices {
  columns: QueryColumn[];
  cost: number;
  date: number;
  service: number;
  region: number;
  currency: number;
  chargeType: number;
  benefit: number;
}

/** Column index resolution, shared by every pass. */
function indices(columns: QueryColumn[]): ColumnIndices {
  return {
    columns,
    cost: columns.findIndex((c) => c.name === "Cost" || c.name === "PreTaxCost"),
    date: columns.findIndex((c) => c.name === "UsageDate"),
    service: columns.findIndex((c) => c.name === "ServiceName"),
    region: columns.findIndex((c) => c.name === "ResourceLocation"),
    currency: columns.findIndex((c) => c.name === "Currency"),
    chargeType: columns.findIndex((c) => c.name === "ChargeType"),
    benefit: columns.findIndex((c) => c.name === "BenefitId"),
  };
}

function assertCoreColumns(idx: ColumnIndices): void {
  if (idx.cost === -1 || idx.date === -1) {
    throw new Error(
      `Azure cost query: unexpected column set [${idx.columns.map((c) => c.name).join(", ")}]`,
    );
  }
}

/** `row[i]` as a string, tolerating an absent column. */
function cell(row: Array<string | number>, index: number): string {
  return index === -1 ? "" : String(row[index] ?? "");
}

/**
 * The pre-attribution query: one unfiltered pass grouped by service and
 * region, every charge type summed together. Used as a fallback when the
 * two-pass shape is rejected — `BenefitId` is documented as an EA/MCA column
 * (https://learn.microsoft.com/en-us/azure/cost-management-billing/automate/understand-usage-details-fields),
 * so a pay-as-you-go subscription can legitimately refuse to group by it, and
 * losing charge types is enormously better than losing the spend data.
 *
 * The fallback is self-limiting: an error that is *not* about the query shape
 * — a 403 from a missing Cost Management Reader role, a 429, a gateway
 * timeout — fails this pass too and propagates, so nothing is swallowed.
 */
async function fetchLegacy(ctx: AzureHttpContext, range: CostFetchRange): Promise<CostRow[]> {
  const rows: CostRow[] = [];
  await runQuery(ctx, range, USAGE_GROUPING, undefined, (page, idx) => {
    assertCoreColumns(idx);
    for (const row of page) {
      const amount = Number(row[idx.cost] ?? 0);
      if (amount === 0 || Number.isNaN(amount)) continue;
      const date = formatUsageDate(row[idx.date]);
      if (!date) continue;
      rows.push({
        date,
        service: cell(row, idx.service),
        region: normalizeRegion(cell(row, idx.region)),
        currency: cell(row, idx.currency) || "USD",
        amount,
      });
    }
  });
  return rows;
}

/** Consumption only — the filter both consumption passes share. */
const CONSUMPTION_FILTER = {
  dimensions: { name: "ChargeType", operator: "In", values: ["Usage"] },
};

/**
 * Committed hours nothing consumed. Both values exist only on `AmortizedCost`,
 * so this filter is meaningless against `ActualCost` and is only ever paired
 * with it.
 *
 * Naming the two charge types is safe where naming a complement would not be
 * (see the header): a charge type Azure adds later is still collected whole by
 * the unfiltered attribution pass, and would only be missing from *this*
 * pass's specialism — unused commitment value — which is a gap that shows up
 * as a smaller number rather than as vanished money.
 */
const UNUSED_COMMITMENT_FILTER = {
  dimensions: {
    name: "ChargeType",
    operator: "In",
    values: ["UnusedReservation", "UnusedSavingsPlan"],
  },
};

/** One `(day, service, region, currency)` consumption cell. */
interface ConsumptionCell {
  date: string;
  service: string;
  region: string;
  currency: string;
  amount: number;
}

/**
 * One attribution cell: a consumption cell's dimensions plus the two the host
 * folds into `tags_hash`. Together they are the *whole* identity `cost_daily`
 * keys a non-usage row on, which is exactly why pass 2 accumulates into it.
 */
interface AttributionCell {
  date: string;
  service: string;
  region: string;
  currency: string;
  chargeType: CostChargeType;
  commitmentId: string;
  /** Cash, from the `ActualCost` pass. Zero for a cell only pass 2b saw. */
  amount: number;
  /**
   * Amortized-only money for the same key: `UnusedReservation` /
   * `UnusedSavingsPlan`. Kept apart from {@link AttributionCell.amount} because
   * the two are different bases — summing them would put amortized money into a
   * cash total — and because a `commitment_fee` cell can legitimately hold both
   * (a purchase in cash, its wasted hours in amortized) on the same day.
   */
  unusedAmortized: number;
}

/**
 * The key pass 2 accumulates on — deliberately the same tuple the host's
 * ReplacingMergeTree treats as one row.
 *
 * **Both of this file's normalizers are many-to-one**, so distinct provider
 * rows genuinely do collapse here. {@link mapAzureChargeType} sends every
 * unrecognised charge type *and* a benefit-less `Purchase` to `"other"`, and
 * {@link normalizeBenefitId} sends `""`, `"Unassigned"`, `"No benefit"`,
 * `"No reservation"` and any label that is not an ARM id to `""`. A Marketplace
 * purchase alongside any charge type Azure has added since the table in
 * {@link mapAzureChargeType} was written is enough: two provider rows, one key.
 *
 * Pushed straight into `rows[]` they would reach the host as two rows identical
 * in every column it keys on, its ReplacingMergeTree would treat them as two
 * versions of one row, and `FINAL` would keep whichever paged in last —
 * silently dropping the other's money. Summing here is the discipline AWS's
 * `Buckets` applies for exactly the same reason (`aws/src/cost-data.ts`).
 */
function attributionKey(c: Omit<AttributionCell, "amount" | "unusedAmortized">): string {
  return [c.date, c.service, c.region, c.currency, c.chargeType, c.commitmentId].join("\u0000");
}

function cellKey(c: Omit<ConsumptionCell, "amount">): string {
  // NUL-joined: service names and region labels both carry spaces.
  return [c.date, c.service, c.region, c.currency].join("\u0000");
}

/**
 * Accumulate one consumption pass into `into`. Zero-amount groups are kept
 * here rather than skipped: a cell that is zero in `ActualCost` and non-zero
 * in `AmortizedCost` is precisely a fully-covered cell, and dropping the zero
 * side would lose the cell's dimensions.
 */
function accumulateConsumption(into: Map<string, ConsumptionCell>) {
  return (page: Array<Array<string | number>>, idx: ColumnIndices): void => {
    assertCoreColumns(idx);
    for (const row of page) {
      const amount = Number(row[idx.cost] ?? 0);
      if (Number.isNaN(amount)) continue;
      const date = formatUsageDate(row[idx.date]);
      if (!date) continue;
      const dims = {
        date,
        service: cell(row, idx.service),
        region: normalizeRegion(cell(row, idx.region)),
        currency: cell(row, idx.currency) || "USD",
      };
      const key = cellKey(dims);
      const existing = into.get(key);
      if (existing) existing.amount += amount;
      else into.set(key, { ...dims, amount });
    }
  };
}

async function fetchAttributed(ctx: AzureHttpContext, range: CostFetchRange): Promise<CostRow[]> {
  const rows: CostRow[] = [];

  // Pass 1 — cash consumption, with service and region.
  const cash = new Map<string, ConsumptionCell>();
  await runQuery(ctx, range, USAGE_GROUPING, CONSUMPTION_FILTER, accumulateConsumption(cash));

  // Pass 1b — the same cells on the amortized dataset. Optional: Cost Analysis
  // "doesn't support viewing amortized reservation costs for a pay-as-you-go
  // subscription", and MOSA accounts have no commitment purchases at all, so a
  // refusal here is a normal state and not a failure. Losing it costs the
  // covered/on-demand split and nothing else — the cash figures stand alone.
  let amortized: Map<string, ConsumptionCell> | null = new Map();
  try {
    await runQuery(
      ctx,
      range,
      USAGE_GROUPING,
      CONSUMPTION_FILTER,
      accumulateConsumption(amortized),
      "AmortizedCost",
    );
  } catch {
    amortized = null;
  }

  for (const key of new Set([...cash.keys(), ...(amortized?.keys() ?? [])])) {
    const cashCell = cash.get(key);
    const amortizedCell = amortized?.get(key);
    const dims = cashCell ?? amortizedCell;
    if (!dims) continue;
    const { date, service, region, currency } = dims;
    const cashAmount = cashCell?.amount ?? 0;

    if (!amortizedCell) {
      // No amortized opinion about this cell — either the pass was refused, or
      // it simply returned nothing here. Emit one undifferentiated consumption
      // row with **no** `amortizedAmount`: absent means "no opinion" and the
      // host falls back to the cash figure, whereas an explicit 0 would erase
      // the cell from every amortized view.
      if (cashAmount !== 0) {
        rows.push({ date, service, region, currency, amount: cashAmount, chargeType: "usage" });
      }
      continue;
    }

    const amortizedAmount = amortizedCell.amount;
    // The decomposition. On-demand consumption is priced identically on both
    // datasets, and commitment-covered consumption is priced at *zero* cash
    // (the money left when the commitment was bought) and at its amortized
    // rate on the other. So the gap between the two totals for one cell is
    // exactly what commitments delivered into it — no third grouping slot
    // needed, which is what makes this affordable inside Azure's two-group
    // limit.
    //
    // It only holds while **both** figures are consumption-shaped, i.e. not
    // negative. Azure restates by emitting negative `Usage` corrections, and
    // the two datasets do not have to receive one in the same collection: a
    // −5 that has landed in `ActualCost` but not yet in `AmortizedCost` reads
    // as `cash = −5, amortized = 0`, whose "gap" is a fabricated 5 of covered
    // spend. The totals would still be conserved (the usage row goes to −5),
    // but the coverage numerator would be poisoned and — worse — the cell
    // would be marked commitment-*eligible* on that evidence, dragging the
    // narrow ratio down for every sibling account sharing the cell. A
    // correction is not a commitment; fall through to the single-row branch
    // and carry both figures as they are.
    const decomposable = cashAmount >= 0 && amortizedAmount >= 0;
    const covered = amortizedAmount - cashAmount;
    if (decomposable && covered > 0) {
      if (cashAmount !== 0) {
        rows.push({
          date,
          service,
          region,
          currency,
          amount: cashAmount,
          amortizedAmount: cashAmount,
          chargeType: "usage",
        });
      }
      rows.push({
        date,
        service,
        region,
        currency,
        // Zero cash and a real amortized amount — the shape the host's coverage
        // numerator reads. No `commitmentId`: which reservation covered the
        // hour is not in this response, and coverage does not need it.
        amount: 0,
        amortizedAmount: covered,
        chargeType: "commitment_covered_usage",
      });
    } else if (cashAmount !== 0 || amortizedAmount !== 0) {
      // Nothing covered here — no gap, a gap the wrong way, or a cell holding
      // a correction on either dataset. Emit one row carrying both figures as
      // reported rather than inventing coverage or a negative covered amount.
      rows.push({
        date,
        service,
        region,
        currency,
        amount: cashAmount,
        amortizedAmount,
        chargeType: "usage",
      });
    }
  }

  // Pass 2 — everything that is not consumption, attributed to its benefit.
  // Unfiltered so an unrecognised charge type still lands (as `other`) rather
  // than being silently dropped; the `Usage` rows it also returns are pass 1's
  // money at a coarser grain and are discarded here.
  const attribution = new Map<string, AttributionCell>();
  await runQuery(ctx, range, ATTRIBUTION_GROUPING, undefined, (page, idx) => {
    assertCoreColumns(idx);
    if (idx.chargeType === -1) {
      throw new Error(
        `Azure cost query: no ChargeType column in [${idx.columns.map((c) => c.name).join(", ")}]`,
      );
    }
    for (const row of page) {
      const rawChargeType = cell(row, idx.chargeType);
      if (rawChargeType === "Usage") continue;
      const amount = Number(row[idx.cost] ?? 0);
      if (amount === 0 || Number.isNaN(amount)) continue;
      const date = formatUsageDate(row[idx.date]);
      if (!date) continue;
      const commitmentId = normalizeBenefitId(cell(row, idx.benefit));
      const dims = {
        date,
        // No service and no region: this query spent both grouping slots on
        // the charge type and the benefit, and Azure reports neither for
        // these rows in the first place.
        service: "",
        region: "",
        currency: cell(row, idx.currency) || "USD",
        chargeType: mapAzureChargeType(rawChargeType, commitmentId),
        commitmentId,
      };
      const key = attributionKey(dims);
      const existing = attribution.get(key);
      if (existing) existing.amount += amount;
      else attribution.set(key, { ...dims, amount, unusedAmortized: 0 });
    }
  });

  // Pass 2b — committed hours nothing consumed. Amortized-only by nature, so
  // it is skipped entirely when the subscription refused that dataset above
  // (no point spending a QPU learning the same refusal twice), and its own
  // failure is survivable for the same reason pass 1b's is: the rest of the
  // collection is unaffected and only the wasted-commitment figure is lost.
  //
  // These land in the *same* map as pass 2 because they share a host key with
  // the purchase rows above, and they contribute to `unusedAmortized` rather
  // than to `amount` because they are not cash — see the header.
  let unusedFound = false;
  if (amortized) {
    try {
      await runQuery(
        ctx,
        range,
        ATTRIBUTION_GROUPING,
        UNUSED_COMMITMENT_FILTER,
        (page, idx) => {
          assertCoreColumns(idx);
          for (const row of page) {
            const amount = Number(row[idx.cost] ?? 0);
            if (amount === 0 || Number.isNaN(amount)) continue;
            const date = formatUsageDate(row[idx.date]);
            if (!date) continue;
            const commitmentId = normalizeBenefitId(cell(row, idx.benefit));
            const dims = {
              date,
              service: "",
              region: "",
              currency: cell(row, idx.currency) || "USD",
              // Both values map to `commitment_fee`; the raw charge type is
              // read anyway so a response that ignored the filter cannot
              // smuggle something else in under this pass's assumptions.
              chargeType: mapAzureChargeType(cell(row, idx.chargeType), commitmentId),
              commitmentId,
            };
            if (dims.chargeType !== "commitment_fee") continue;
            unusedFound = true;
            const key = attributionKey(dims);
            const existing = attribution.get(key);
            if (existing) existing.unusedAmortized += amount;
            else attribution.set(key, { ...dims, amount: 0, unusedAmortized: amount });
          }
        },
        "AmortizedCost",
      );
    } catch {
      // Same posture as pass 1b: a refusal is a state, not a failure.
    }
  }

  // A purchase's amortized value is only claimable as zero when the amortized
  // dataset actually produced the rows that value was redistributed into —
  // covered consumption, unused hours, or both. An empty amortized result is
  // not evidence of redistribution.
  const amortizationLanded = (amortized?.size ?? 0) > 0 || unusedFound;

  for (const c of attribution.values()) {
    // A cell only pass 2b saw, whose unused figure was then discarded for want
    // of an amortized basis to state it on, carries no money at all.
    if (c.amount === 0 && !(amortizationLanded && c.unusedAmortized !== 0)) continue;
    rows.push({
      date: c.date,
      service: c.service,
      region: c.region,
      currency: c.currency,
      // Cash, and cash only. Unused commitment hours never reach this: they
      // exist on the amortized dataset alone and no cash total may move
      // because they were collected.
      amount: c.amount,
      chargeType: c.chargeType,
      // A commitment purchase's honest amortized value on its purchase day
      // is **zero plus whatever it wasted**: the AmortizedCost dataset contains
      // no `Purchase` row at all, because that money has been redistributed to
      // the covered-usage rows above and to the unused hours pass 2b collected.
      // Stating that (rather than omitting it, which means "no opinion" and
      // falls back to cash) is what keeps the amortized view from showing the
      // purchase at full price alongside every slice of it.
      //
      // Only claimable when the amortized dataset actually landed — without it
      // there are no rows holding the redistributed value, and zeroing the
      // purchase would delete it from amortized views entirely.
      //
      // Everything else here (tax, credits, refunds, Marketplace purchases)
      // is priced identically on both datasets, so it states its cash amount
      // rather than leaving readers to infer it.
      ...(amortizationLanded
        ? { amortizedAmount: c.chargeType === "commitment_fee" ? c.unusedAmortized : c.amount }
        : {}),
      ...(c.commitmentId ? { commitmentId: c.commitmentId } : {}),
    });
  }

  return rows;
}

/**
 * The attributed collection, with the legacy single-query shape as a fallback.
 *
 * The fallback is flagged `degraded`, and that flag is load-bearing rather than
 * informational. It fires for two populations that look identical from here: a
 * subscription that can *never* group by `BenefitId` (pay-as-you-go, where the
 * column does not exist), and one that merely had a bad minute — a 429, a
 * gateway timeout, a transient 500. For the second, the pass writes a strictly
 * *coarser* key space than the collection before it: one undifferentiated
 * `usage` row per cell and no attribution rows at all.
 *
 * The host reconciles by zeroing stored keys a collection did not rewrite, so
 * without the flag that one bad minute would tombstone every attribution row
 * for the days in the chunk — and, because a backfilled account only re-fetches
 * `restatementDays` (3), a flap that ages past that window would never be
 * repaired. Flagged, the host skips tombstoning for the pass and the existing
 * rows survive untouched, which is exactly what happened before reconciliation
 * existed. See `CostFetchResult.degraded` in `@infrawrench/plugin-base`.
 */
export async function fetchAzureCostData(
  ctx: AzureHttpContext,
  range: CostFetchRange,
): Promise<CostFetchResult> {
  try {
    return { rows: await fetchAttributed(ctx, range) };
  } catch {
    return { rows: await fetchLegacy(ctx, range), degraded: true };
  }
}
