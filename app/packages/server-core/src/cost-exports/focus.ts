/**
 * FOCUS 1.3 cost rows: the `focus-1.3` export schema and the ad-hoc FOCUS
 * download both stream through here.
 *
 * FOCUS (the FinOps Open Cost and Usage Specification) fixes the columns, the
 * row grain and the vocabulary of a cost dataset, so a file written here loads
 * into any tool that reads FOCUS without a mapping step. The source of truth
 * for everything below is the v1.3 specification
 * (https://github.com/FinOps-Open-Cost-and-Usage-Spec/FOCUS_Spec/tree/v1.3);
 * the column list itself is `FOCUS_1_3_COLUMNS` in client-core.
 *
 * ## How our rows map
 *
 * - **Grain.** One FOCUS row per `cost_daily` row identity: day, account,
 *   service, region, resource, tag set, currency, charge type and commitment.
 *   A FOCUS export does not aggregate: `ResourceId` must be set on every charge
 *   that is related to a resource, which an aggregated row cannot honour.
 * - **BilledCost is cash, EffectiveCost is amortized**, using the same
 *   `amortizedAmountExpr` the graphs and the native export use, so the two
 *   reconcile by construction. Commitment-covered usage therefore reads 0
 *   billed and its share of the commitment as effective cost, and a commitment
 *   purchase reads its price as billed and 0 effective, exactly the shape the
 *   specification's discount-handling section requires; provided the plugin
 *   reports amortization. One that does not falls back to cash on both sides.
 * - **ListCost and ContractedCost.** No collector reads a price list, so there
 *   are no unit prices. The specification says a charge with no unit price
 *   takes its list and contracted cost from BilledCost (Credit, Tax…) or, for
 *   usage, from the cost it actually incurred; we write EffectiveCost for usage
 *   and BilledCost for everything else. That understates the savings a
 *   commitment produced rather than inventing a list price.
 * - **Charge categories** fold our ten charge types onto FOCUS's five; see
 *   {@link focusChargeCategory}. The original type rides along as
 *   `x_InfrawrenchChargeType`.
 * - **Quantities.** `PricingQuantity`/`PricingUnit` must be null when there is
 *   no `SkuPriceId`, and no collector supplies one, so they are null and the
 *   provider's reported usage travels as `x_UsageQuantity`/`x_UsageUnit`.
 * - **Billing period** is the calendar month (UTC) containing the charge day.
 *   That is every provider we collect from today; the specification's
 *   invoice-matching requirement on BilledCost is about InvoiceId, which we do
 *   not emit.
 * - **Accounts.** The connected Infrawrench account is the billing account:
 *   its id is unique across every invoice issuer, which the specification
 *   requires, and its display name is the name the user gave it.
 */
import type { CostChargeType, CostFilter } from "@infrawrench/client-core";
import { FOCUS_1_3_COLUMNS, FOCUS_CUSTOM_COLUMNS } from "@infrawrench/client-core";
import {
  resolveFocusService,
  type FocusCapabilityDeclaration,
  type FocusServiceClassification,
} from "@infrawrench/plugin-base";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/clickhouse-core";
import { amortizedAmountExpr } from "../clickhouse/cost-readers";
import { costDaily } from "../clickhouse/schema";
import {
  DEPLOYMENT_COST_PLUGIN_ID,
  DEPLOYMENT_COST_PROVIDER_LABEL,
  deploymentCostAccountLabels,
} from "../cost/deployment-cost-ids";
import {
  EXTERNAL_COST_PLUGIN_ID,
  EXTERNAL_COST_TAG,
  sourceFromCostAccountId,
} from "../cost/external-cost-ids";
import { WORKFLOW_COST_PLUGIN_ID } from "../cost/workflow-cost-ids";
import { db } from "../db/client";
import { accountCommitments, accounts, resources } from "../db/schema";
import { loadPlugins } from "../plugin-loader";
import { costExportScope, streamExportQuery } from "./rows";
import { csvCell } from "./serialize";

/* ------------------------------------------------------------------ *
 * The raw row
 * ------------------------------------------------------------------ */

/** One grouped `cost_daily` identity, as the FOCUS query returns it. */
export interface FocusSourceRow {
  day: string;
  account_id: string;
  plugin_id: string;
  service: string;
  region: string;
  resource_id: string;
  tags: Record<string, string>;
  currency: string;
  charge_type: string;
  commitment_id: string;
  billed: number | string;
  effective: number | string;
  usage_amount: number | string;
  usage_unit: string;
}

export interface FocusRowQuery {
  organizationId: string;
  from: string;
  to: string;
  filters: CostFilter[];
  chargeTypes?: CostChargeType[] | undefined;
}

/**
 * The SELECT behind a FOCUS object. Exported for the tests that assert its
 * shape.
 *
 * Grouped by the table's full row identity plus the two columns folded into
 * `tags_hash` (charge type and commitment), so nothing is aggregated away;
 * the GROUP BY is there to make the grain explicit rather than to sum. The
 * ORDER BY is total for the same reason the native export's is: two runs of
 * one period must write byte-identical objects.
 */
export function buildFocusExportQuery(q: FocusRowQuery): string {
  const keys = [
    costDaily.day,
    costDaily.account_id,
    costDaily.plugin_id,
    costDaily.service,
    costDaily.region,
    costDaily.resource_id,
    costDaily.tags_hash,
    costDaily.currency,
    costDaily.charge_type,
    costDaily.commitment_id,
  ];
  const query = new QueryBuilder()
    .select({
      day: sql<string>`toString(${costDaily.day})`.as("day"),
      account_id: costDaily.account_id,
      plugin_id: costDaily.plugin_id,
      service: costDaily.service,
      region: costDaily.region,
      resource_id: costDaily.resource_id,
      tags: sql<Record<string, string>>`any(${costDaily.tags})`.as("tags"),
      currency: costDaily.currency,
      charge_type: costDaily.charge_type,
      commitment_id: costDaily.commitment_id,
      billed: sql<number>`sum(${costDaily.amount})`.as("billed"),
      effective: sql<number>`sum(${amortizedAmountExpr()})`.as("effective"),
      usage_amount: sql<number>`sum(${costDaily.usage_amount})`.as("usage_amount"),
      usage_unit:
        sql<string>`if(uniqExact(${costDaily.usage_unit}) = 1, any(${costDaily.usage_unit}), '')`.as(
          "usage_unit",
        ),
    })
    .from(costDaily)
    .final()
    .where(costExportScope(q))
    .groupBy(...keys)
    .orderBy(...keys.map((k) => asc(k)));
  return query.toSQL().sql;
}

/** Stream the raw rows for one FOCUS object. */
export function streamFocusSourceRows(
  q: FocusRowQuery,
): AsyncGenerator<FocusSourceRow, void, undefined> {
  return streamExportQuery<FocusSourceRow>(buildFocusExportQuery(q));
}

/* ------------------------------------------------------------------ *
 * Lookups: the names FOCUS wants that `cost_daily` does not carry
 * ------------------------------------------------------------------ */

interface ProviderInfo {
  name: string;
  focus: FocusCapabilityDeclaration | undefined;
  estimated: boolean;
  resourceTypeNames: Map<string, string>;
}

interface CommitmentInfo {
  kind: string;
  description: string;
}

interface ResourceInfo {
  name: string;
  type: string | null;
}

/**
 * Everything a row needs from Postgres and the plugin registry, loaded once per
 * run (or per download) rather than per row. Plain maps so the mapping below
 * stays a pure function the tests can drive without a database.
 */
export interface FocusLookups {
  providers: Map<string, ProviderInfo>;
  accountNames: Map<string, string>;
  commitments: Map<string, CommitmentInfo>;
  /** `${accountId}\u0000${externalId}` → the inventory's name and type. */
  resources: Map<string, ResourceInfo>;
}

export function emptyFocusLookups(): FocusLookups {
  return {
    providers: new Map(),
    accountNames: new Map(),
    commitments: new Map(),
    resources: new Map(),
  };
}

function resourceKey(accountId: string, externalId: string): string {
  return `${accountId}\u0000${externalId}`;
}

/**
 * Load the org's names.
 *
 * Resources are matched on `(account, external id)`, the provider-native id
 * the inventory stores, which is what most collectors put in `resource_id`.
 * Deleted resources are included on purpose: last month's bill still names
 * the machine that was destroyed last week, and its name is still its name.
 */
export async function loadFocusLookups(organizationId: string): Promise<FocusLookups> {
  const lookups = emptyFocusLookups();

  for (const { plugin } of await loadPlugins()) {
    lookups.providers.set(plugin.manifest.id, {
      name: plugin.manifest.displayName,
      focus: plugin.manifest.costs?.focus,
      estimated: plugin.manifest.costs?.estimated === true,
      resourceTypeNames: new Map(plugin.resourceTypes.map((t) => [t.id, t.displayName])),
    });
  }
  // Rows Infrawrench itself attributes, which have no plugin behind them.
  // Named the way the provider dimension names them in the graphs.
  for (const [id, name] of [
    [WORKFLOW_COST_PLUGIN_ID, "Workflow"],
    [EXTERNAL_COST_PLUGIN_ID, "External"],
    [DEPLOYMENT_COST_PLUGIN_ID, DEPLOYMENT_COST_PROVIDER_LABEL],
  ] as const) {
    lookups.providers.set(id, {
      name,
      focus: undefined,
      estimated: false,
      resourceTypeNames: new Map(),
    });
  }

  const accountRows = await db
    .select({ id: accounts.id, displayName: accounts.displayName })
    .from(accounts)
    .where(eq(accounts.organizationId, organizationId));
  for (const row of accountRows) lookups.accountNames.set(row.id, row.displayName);

  const commitmentRows = await db
    .select({
      commitmentId: accountCommitments.commitmentId,
      kind: accountCommitments.kind,
      description: accountCommitments.description,
    })
    .from(accountCommitments)
    .where(eq(accountCommitments.organizationId, organizationId));
  for (const row of commitmentRows) {
    lookups.commitments.set(row.commitmentId, { kind: row.kind, description: row.description });
  }

  const resourceRows = await db
    .select({
      accountId: resources.accountId,
      pluginId: resources.pluginId,
      externalId: resources.externalId,
      displayName: resources.displayName,
      resourceTypeId: resources.resourceTypeId,
    })
    .from(resources)
    .where(and(eq(resources.organizationId, organizationId), isNotNull(resources.externalId)));
  for (const row of resourceRows) {
    if (!row.externalId) continue;
    const typeName = lookups.providers.get(row.pluginId)?.resourceTypeNames.get(row.resourceTypeId);
    lookups.resources.set(resourceKey(row.accountId, row.externalId), {
      name: row.displayName,
      type: typeName ?? null,
    });
  }

  return lookups;
}

/* ------------------------------------------------------------------ *
 * Value mapping
 * ------------------------------------------------------------------ */

export type FocusChargeCategory = "Usage" | "Purchase" | "Tax" | "Credit" | "Adjustment";

/**
 * Our charge types onto FOCUS's five categories.
 *
 * - Both kinds of consumption are `Usage`; whether a commitment covered it is
 *   what `CommitmentDiscountStatus` says.
 * - `commitment_discount` (e.g. AWS's Savings Plan negation line) is a price
 *   reduction applied to usage, so it is `Usage` too. The specification would
 *   rather the discount were folded into the row it discounts; our collectors
 *   receive it as its own line and we do not rewrite provider data.
 * - A commitment fee and a support fee are both something bought, `Purchase`.
 * - `refund` is `Credit`: FOCUS defines Credit as charges the provider grants
 *   and we cannot tell which usage or purchase a refund reverses, which is
 *   what booking it under Usage or Purchase would claim.
 * - `adjustment` and `other` are `Adjustment`, the specification's category
 *   for "charges that do not fall into other category values".
 */
export function focusChargeCategory(chargeType: string): FocusChargeCategory {
  switch (chargeType) {
    case "usage":
    case "commitment_covered_usage":
    case "commitment_discount":
      return "Usage";
    case "commitment_fee":
    case "support":
      return "Purchase";
    case "tax":
      return "Tax";
    case "credit":
    case "refund":
      return "Credit";
    default:
      return "Adjustment";
  }
}

/**
 * `ChargeFrequency`. Must not be null, and must not be `Usage-Based` on a
 * `Purchase` row. A commitment fee is `Recurring` (monthly reservation and
 * savings-plan fees are the common case); an all-upfront purchase would be
 * `One-Time` but no collector reports a payment option on the fee row itself.
 */
export function focusChargeFrequency(chargeType: string): "One-Time" | "Recurring" | "Usage-Based" {
  switch (focusChargeCategory(chargeType)) {
    case "Usage":
      return "Usage-Based";
    case "Purchase":
      return "Recurring";
    default:
      return "One-Time";
  }
}

/** `CommitmentDiscountType`: a readable display value, consistent per kind. */
const COMMITMENT_TYPE_LABELS: Record<string, string> = {
  reservation: "Reservation",
  savings_plan: "Savings Plan",
  committed_use: "Committed Use Discount",
};

/**
 * `CommitmentDiscountCategory`: `Spend` for a commitment to an amount of money
 * per hour (a savings plan), `Usage` for one to an amount of capacity (a
 * reservation, a committed-use discount).
 *
 * The inventory says which when the commitment is in it. When it is not (a
 * holding the account cannot list, or one that has expired out of the
 * inventory) the id is the only evidence: an AWS Savings Plan ARN contains
 * `savingsplan`. Anything else is read as a capacity commitment, the far more
 * common kind, because the column may not be null while an id is present.
 */
function commitmentCategory(id: string, info: CommitmentInfo | undefined): "Spend" | "Usage" {
  if (info) return info.kind === "savings_plan" ? "Spend" : "Usage";
  return /savings.?plan/i.test(id) ? "Spend" : "Usage";
}

function commitmentType(id: string, info: CommitmentInfo | undefined): string {
  if (info) return COMMITMENT_TYPE_LABELS[info.kind] ?? info.kind;
  return /savings.?plan/i.test(id) ? "Savings Plan" : "Reservation";
}

/** `YYYY-MM-DD` → `YYYY-MM-DDT00:00:00Z`. */
function startOfDay(day: string): string {
  return `${day}T00:00:00Z`;
}

/** The day after `day`, as an exclusive end bound. */
function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** `[first of month, first of next month)` for the month containing `day`. */
function billingPeriod(day: string): { start: string; end: string } {
  const [y, m] = day.split("-").map(Number) as [number, number];
  const start = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-01`;
  const endYear = m === 12 ? y + 1 : y;
  const endMonth = m === 12 ? 1 : m + 1;
  const end = `${String(endYear).padStart(4, "0")}-${String(endMonth).padStart(2, "0")}-01`;
  return { start: startOfDay(start), end: startOfDay(end) };
}

/**
 * A number in FOCUS NumericFormat. JavaScript's own scientific notation writes
 * `1e+21` and `1e-7`; the specification wants `mEn` with no `+` on a positive
 * exponent, so the exponent marker is rewritten. Non-finite values cannot
 * occur from a sum of finite floats but would be a lie in a cost column, so
 * they become 0 rather than `NaN`.
 */
export function focusNumber(raw: number | string): number | string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  const text = String(n);
  if (!/e/.test(text)) return n;
  return text.replace("e+", "E").replace("e-", "E-");
}

/** One output cell. `null` is FOCUS's null; CSV writes it as an empty field. */
export type FocusCell = string | number | boolean | null;
export type FocusRow = Record<string, FocusCell>;

export interface FocusStamp {
  exportedAt: string;
  collectionWatermark: string;
}

type FocusColumn = (typeof FOCUS_1_3_COLUMNS)[number] | (typeof FOCUS_CUSTOM_COLUMNS)[number];

/** The full header, FOCUS columns first and custom columns after, unmixed. */
export const FOCUS_OUTPUT_COLUMNS: readonly FocusColumn[] = [
  ...FOCUS_1_3_COLUMNS,
  ...FOCUS_CUSTOM_COLUMNS,
];

/** `ChargeDescription`: should not be null, so it is always composed. */
function chargeDescription(service: string, chargeType: string, provider: string): string {
  const what = service || provider;
  switch (chargeType) {
    case "commitment_covered_usage":
      return `${what} usage covered by a commitment`;
    case "commitment_fee":
      return `${what} commitment fee`;
    case "commitment_discount":
      return `${what} commitment discount`;
    case "credit":
      return `${what} credit`;
    case "tax":
      return `${what} tax`;
    case "refund":
      return `${what} refund`;
    case "adjustment":
      return `${what} adjustment`;
    case "support":
      return `${what} support`;
    case "other":
      return `${what} charge`;
    default:
      return `${what} usage`;
  }
}

/**
 * The account's display name. Synthetic accounts (rows pushed over the API,
 * deployment builds) have a readable label derived from the id; a workflow
 * account and any account deleted since are left null, which the
 * specification allows when no display name is available.
 */
function accountName(accountId: string, lookups: FocusLookups): string | null {
  const known = lookups.accountNames.get(accountId);
  if (known) return known;
  const source = sourceFromCostAccountId(accountId);
  if (source) return source;
  return deploymentCostAccountLabels([accountId]).get(accountId) ?? null;
}

/**
 * Map one raw row onto the FOCUS columns. Pure: everything it reads is the row
 * and the lookups, so the tests exercise it directly.
 */
export function toFocusRow(
  raw: FocusSourceRow,
  lookups: FocusLookups,
  stamp: FocusStamp,
): FocusRow {
  const chargeType = raw.charge_type || "usage";
  const category = focusChargeCategory(chargeType);
  const provider = lookups.providers.get(raw.plugin_id);
  // Rows pushed over the API name their source in a reserved tag; that source
  // is who actually provided the service, not "External".
  const providerName =
    (raw.plugin_id === EXTERNAL_COST_PLUGIN_ID && raw.tags?.[EXTERNAL_COST_TAG]) ||
    provider?.name ||
    raw.plugin_id ||
    "Unknown";
  const service: FocusServiceClassification = resolveFocusService(
    raw.service || providerName,
    provider?.focus,
  );

  const billed = Number(raw.billed) || 0;
  // "EffectiveCost of a charge unrelated to other charges (e.g. Credit) MUST
  // match the BilledCost." Amortization has nothing to spread on a credit or
  // an adjustment, so a provider that reported a different figure for one is
  // overruled rather than written into a non-conformant row.
  const effective =
    category === "Credit" || category === "Adjustment" ? billed : Number(raw.effective) || 0;
  const listCost = category === "Usage" ? effective : billed;

  const day = raw.day;
  const period = billingPeriod(day);

  const commitmentId = raw.commitment_id || null;
  const commitment = commitmentId ? lookups.commitments.get(commitmentId) : undefined;

  // A commitment purchase is its own resource: "The CommitmentDiscountId and
  // ResourceId MUST be set to the ID assigned to the commitment discount" on
  // the row that buys it. Usage keeps the resource that received the discount.
  const resourceId =
    raw.resource_id || (commitmentId && category === "Purchase" ? commitmentId : null);
  const resource = resourceId
    ? lookups.resources.get(resourceKey(raw.account_id, resourceId))
    : undefined;
  // "MUST NOT duplicate ResourceId when the resource only has a
  // system-generated id": an inventory name that is just the id is no name.
  const resourceName = resource && resource.name !== resourceId ? resource.name : null;

  const region = raw.region || null;
  const tags = Object.keys(raw.tags ?? {}).length > 0 ? JSON.stringify(raw.tags) : null;
  const usageQuantity = Number(raw.usage_amount) || 0;

  const row: Record<FocusColumn, FocusCell> = {
    BilledCost: focusNumber(billed),
    BillingAccountId: raw.account_id,
    BillingAccountName: accountName(raw.account_id, lookups),
    BillingCurrency: raw.currency,
    BillingPeriodEnd: period.end,
    BillingPeriodStart: period.start,
    ChargeCategory: category,
    // Null unless the row corrects a previously invoiced period, which no
    // collector reports; a refund may well be one, but we cannot tell.
    ChargeClass: null,
    ChargeDescription: chargeDescription(raw.service, chargeType, providerName),
    ChargeFrequency: focusChargeFrequency(chargeType),
    ChargePeriodEnd: startOfDay(nextDay(day)),
    ChargePeriodStart: startOfDay(day),
    CommitmentDiscountCategory: commitmentId ? commitmentCategory(commitmentId, commitment) : null,
    CommitmentDiscountId: commitmentId,
    CommitmentDiscountName: commitment?.description || null,
    // "Used" on usage a commitment applied to. We never see the unused
    // portion as a row of its own (no collector reports one), so "Unused"
    // never appears; on a purchase row the status is null by definition.
    CommitmentDiscountStatus: commitmentId && category === "Usage" ? "Used" : null,
    CommitmentDiscountType: commitmentId ? commitmentType(commitmentId, commitment) : null,
    ContractedCost: focusNumber(listCost),
    EffectiveCost: focusNumber(effective),
    HostProviderName: providerName,
    InvoiceIssuerName: providerName,
    ListCost: focusNumber(listCost),
    PricingQuantity: null,
    PricingUnit: null,
    // Deprecated in 1.3 in favour of ServiceProviderName / HostProviderName,
    // but still Mandatory: written with the same value.
    ProviderName: providerName,
    PublisherName: providerName,
    RegionId: region,
    RegionName: region,
    ResourceId: resourceId,
    ResourceName: resourceName,
    ServiceCategory: service.category,
    ServiceName: raw.service || providerName,
    ServiceProviderName: providerName,
    ServiceSubcategory: service.subcategory,
    Tags: tags,
    x_InfrawrenchProviderId: raw.plugin_id,
    x_InfrawrenchChargeType: chargeType,
    x_UsageQuantity: usageQuantity !== 0 ? focusNumber(usageQuantity) : null,
    x_UsageUnit: usageQuantity !== 0 && raw.usage_unit ? raw.usage_unit : null,
    x_ResourceType: resource?.type ?? null,
    x_CostEstimated: provider?.estimated ?? false,
    x_ExportedAt: stamp.exportedAt,
    x_CollectionWatermark: stamp.collectionWatermark || null,
  };
  return row;
}

/* ------------------------------------------------------------------ *
 * Serialisation
 * ------------------------------------------------------------------ */

function csvValue(cell: FocusCell): string {
  if (cell === null) return "";
  return csvCell(typeof cell === "boolean" ? String(cell) : cell);
}

/** CSV with a header line; FOCUS null is an empty field. */
export async function* toFocusCsv(rows: AsyncIterable<FocusRow>): AsyncGenerator<string> {
  yield `${FOCUS_OUTPUT_COLUMNS.join(",")}\n`;
  for await (const row of rows) {
    yield `${FOCUS_OUTPUT_COLUMNS.map((c) => csvValue(row[c] ?? null)).join(",")}\n`;
  }
}

/** One JSON object per line, keys in column order; FOCUS null is JSON null. */
export async function* toFocusNdjson(rows: AsyncIterable<FocusRow>): AsyncGenerator<string> {
  for await (const row of rows) {
    const obj: FocusRow = {};
    for (const c of FOCUS_OUTPUT_COLUMNS) obj[c] = row[c] ?? null;
    yield `${JSON.stringify(obj)}\n`;
  }
}

/** Map a raw stream onto FOCUS rows. */
export async function* mapFocusRows(
  source: AsyncIterable<FocusSourceRow>,
  lookups: FocusLookups,
  stamp: FocusStamp,
): AsyncGenerator<FocusRow, void, undefined> {
  for await (const raw of source) yield toFocusRow(raw, lookups, stamp);
}

/** Pick the FOCUS serialiser and the MIME type for a format. */
export function serializeFocusRows(
  format: "csv" | "ndjson",
  rows: AsyncIterable<FocusRow>,
): { body: AsyncIterable<string>; contentType: string } {
  return format === "ndjson"
    ? { body: toFocusNdjson(rows), contentType: "application/x-ndjson" }
    : { body: toFocusCsv(rows), contentType: "text/csv; charset=utf-8" };
}
