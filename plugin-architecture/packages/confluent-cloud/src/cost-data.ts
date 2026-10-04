/**
 * Cost collection from the Billing Costs API (`GET /billing/v1/costs`).
 *
 * Verified 2026-10 against the published spec and Confluent's billing docs
 * (https://docs.confluent.io/cloud/current/billing/invoices-and-costs.html,
 * https://docs.confluent.io/cloud/current/billing/billing-dimensions.html):
 *
 * - The key's owner must hold OrganizationAdmin or BillingAdmin.
 * - `start_date` is inclusive, `end_date` exclusive, both `YYYY-MM-DD` UTC.
 *   The start can be at most one year back and one request may span at most
 *   one month, so a range is walked in windows of at most 28 days.
 * - Line items are aggregated daily (`granularity: DAILY`), one per product,
 *   line type, resource and network access type, with `original_amount`,
 *   `discount_amount` and the net `amount`. Data can take 72 hours to land.
 * - `PROMO_CREDIT` lines are credits issued by Confluent; `SUPPORT` lines are
 *   the support plan prorated hourly.
 * - Organizations created before 2024-05-15 receive a legacy shape (the
 *   environment at the top level), and Confluent's community forum reports
 *   that `amount` / `discount_amount` can be absent there; `amount` then
 *   falls back to `original_amount - discount_amount`, then to
 *   `quantity * price`.
 */

import type { CostChargeType, CostFetchRange, CostRow } from "@infrawrench/plugin-base";
import { CostSetupError } from "@infrawrench/plugin-base";
import type { ConfluentContext } from "./api.js";
import { ccList, statusOf } from "./api.js";
import type { CcCost } from "./types.js";

/** Max days per request: Confluent allows "one month", 28 is safe for every month. */
const WINDOW_DAYS = 28;
const DAY_MS = 86_400_000;

const PRODUCT_LABELS: Record<string, string> = {
  KAFKA: "Kafka",
  CONNECT: "Connect",
  CUSTOM_CONNECT: "Custom Connectors",
  KSQL: "ksqlDB",
  FLINK: "Flink",
  STREAM_GOVERNANCE: "Stream Governance",
  CLUSTER_LINK: "Cluster Linking",
  AUDIT_LOG: "Audit Log",
  TABLEFLOW: "Tableflow",
  USM: "Unified Stream Manager",
  SUPPORT_CLOUD_BASIC: "Support",
  SUPPORT_CLOUD_DEVELOPER: "Support",
  SUPPORT_CLOUD_BUSINESS: "Support",
  SUPPORT_CLOUD_PREMIER: "Support",
};

const LINE_TYPE_LABELS: Record<string, string> = {
  KAFKA_NUM_CKUS: "CKUs",
  KAFKA_BASE: "Cluster base",
  KAFKA_PARTITION: "Partitions",
  KAFKA_STORAGE: "Storage",
  KAFKA_NETWORK_READ: "Egress",
  KAFKA_NETWORK_WRITE: "Ingress",
  KAFKA_REST_PRODUCE: "REST produce",
  KSQL_NUM_CSUS: "CSUs",
  CONNECT_CAPACITY: "Connect capacity",
  CONNECT_NUM_TASKS: "Connector tasks",
  CONNECT_THROUGHPUT: "Connector throughput",
  CONNECT_NUM_RECORDS: "Connector records",
  CUSTOM_CONNECT_NUM_TASKS: "Custom connector tasks",
  CUSTOM_CONNECT_THROUGHPUT: "Custom connector throughput",
  SUPPORT: "Support plan",
  CLUSTER_LINKING_PER_LINK: "Cluster links",
  CLUSTER_LINKING_WRITE: "Cluster link ingress",
  CLUSTER_LINKING_READ: "Cluster link egress",
  AUDIT_LOG_READ: "Audit log reads",
  GOVERNANCE_BASE: "Governance base",
  SCHEMA_REGISTRY: "Schemas",
  NUM_RULES: "Data quality rules",
  PROMO_CREDIT: "Promotional credit",
  FLINK_NUM_CFUS: "CFUs",
  TABLEFLOW_DATA_PROCESSED: "Tableflow data processed",
  TABLEFLOW_NUM_TOPICS: "Tableflow topics",
  TABLEFLOW_STORAGE: "Tableflow storage",
  USM_CONNECTED_NODE: "Connected nodes",
  KAFKA_STREAMS: "Kafka Streams",
};

const NETWORK_LABELS: Record<string, string> = {
  INTERNET: "Internet",
  TRANSIT_GATEWAY: "Transit gateway",
  PRIVATE_LINK: "Private link",
  PEERED_VPC: "VPC peering",
  PNI: "Private network interface",
  MULTI: "Multiple",
};

function titleCase(raw: string): string {
  return raw
    .toLowerCase()
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Product id to the service name cost rows are filed under. */
export function productLabel(product: string | undefined, lineType?: string): string {
  if (lineType === "PROMO_CREDIT") return "Credits";
  if (lineType === "SUPPORT") return "Support";
  if (!product) return "Other";
  // Schema Registry is billed under STREAM_GOVERNANCE but is what people look for.
  if (product === "STREAM_GOVERNANCE" && lineType === "SCHEMA_REGISTRY") return "Schema Registry";
  return PRODUCT_LABELS[product] ?? titleCase(product);
}

export function lineTypeLabel(lineType: string | undefined): string {
  if (!lineType) return "";
  return LINE_TYPE_LABELS[lineType] ?? titleCase(lineType);
}

export function chargeTypeFor(lineType: string | undefined, product?: string): CostChargeType {
  if (lineType === "PROMO_CREDIT") return "credit";
  if (lineType === "SUPPORT" || (product ?? "").startsWith("SUPPORT_")) return "support";
  return "usage";
}

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/** Net amount of a line item, tolerating the legacy shape's missing fields. */
export function netAmount(c: CcCost): number | null {
  if (finite(c.amount)) return c.amount;
  if (finite(c.original_amount)) {
    return c.original_amount - (finite(c.discount_amount) ? c.discount_amount : 0);
  }
  if (finite(c.quantity) && finite(c.price)) return c.quantity * c.price;
  return null;
}

function environmentOf(c: CcCost): string {
  const nested = c.resource?.environment;
  if (nested && typeof nested === "object" && nested.id) return nested.id;
  return c.environment?.id ?? "";
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** `[start, endExclusive)` windows covering the inclusive range. */
export function costWindows(range: CostFetchRange): Array<{ start: string; end: string }> {
  const from = Date.parse(`${range.fromDate}T00:00:00Z`);
  const toExclusive = Date.parse(`${range.toDate}T00:00:00Z`) + DAY_MS;
  if (!Number.isFinite(from) || !Number.isFinite(toExclusive) || toExclusive <= from) return [];
  const out: Array<{ start: string; end: string }> = [];
  for (let cursor = from; cursor < toExclusive; cursor += WINDOW_DAYS * DAY_MS) {
    const end = Math.min(cursor + WINDOW_DAYS * DAY_MS, toExclusive);
    out.push({ start: isoDay(cursor), end: isoDay(end) });
  }
  return out;
}

/** Fetch every line item in the range, window by window. */
export async function fetchCostLines(
  ctx: ConfluentContext,
  range: CostFetchRange,
): Promise<CcCost[]> {
  const lines: CcCost[] = [];
  try {
    for (const w of costWindows(range)) {
      const batch = await ccList<CcCost>(
        ctx,
        "/billing/v1/costs",
        { start_date: w.start, end_date: w.end },
        5000,
      );
      lines.push(...batch);
    }
  } catch (err) {
    const status = statusOf(err);
    if (status === 401 || status === 403) {
      throw new CostSetupError(
        "Confluent Cloud refused the Billing Costs API. The Cloud API key's owner needs the OrganizationAdmin or BillingAdmin role.",
        {
          label: "Costs API requirements",
          url: "https://docs.confluent.io/cloud/current/billing/invoices-and-costs.html#costs-api",
        },
      );
    }
    throw err;
  }
  return lines;
}

/** Where a billed resource lives, from the inventory listing. */
export interface ResourceLocation {
  region?: string;
  cloud?: string;
  environmentName?: string;
}

export interface CostContext {
  /** Billing resource id (`lkc-…`, `lcc-…`, `lfcp-…`) to its location. */
  locations: Map<string, ResourceLocation>;
  /** Environment id to display name. */
  environments: Map<string, string>;
}

/**
 * Normalize line items into daily cost rows. Rows that share every key are
 * summed, since two rows with one key would collapse in storage.
 *
 * - service: product label ("Kafka", "Connect", "Flink", ...).
 * - region: the billed resource's region, joined from inventory, because the
 *   Costs API itself does not carry one.
 * - resourceId: the provider id (`lkc-…`), which is also the externalId of
 *   the matching inventory row.
 * - tags: environment, line type (what the charge is for), network access
 *   type, and cloud.
 */
export function normalizeCosts(lines: CcCost[], context?: CostContext): CostRow[] {
  const rows = new Map<string, CostRow>();
  for (const c of lines) {
    const date = (c.start_date ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const amount = netAmount(c);
    if (amount === null) continue;
    const resourceId = c.resource?.id ?? "";
    const env = environmentOf(c);
    const location = resourceId ? context?.locations.get(resourceId) : undefined;
    const service = productLabel(c.product, c.line_type);
    const chargeType = chargeTypeFor(c.line_type, c.product);
    const tags: Record<string, string> = {};
    if (env) tags["environment"] = context?.environments.get(env) ?? env;
    const lineType = lineTypeLabel(c.line_type);
    if (lineType) tags["lineType"] = lineType;
    if (c.network_access_type) {
      tags["network"] = NETWORK_LABELS[c.network_access_type] ?? titleCase(c.network_access_type);
    }
    if (location?.cloud) tags["cloud"] = location.cloud.toUpperCase();
    const region = location?.region ?? "";
    const key = [date, service, region, resourceId, chargeType, JSON.stringify(tags)].join("|");
    const existing = rows.get(key);
    const unit = c.unit ?? "";
    if (existing) {
      existing.amount += amount;
      if (existing.usageUnit === unit && finite(c.quantity) && existing.usageAmount !== undefined) {
        existing.usageAmount += c.quantity;
      } else {
        delete existing.usageAmount;
        delete existing.usageUnit;
      }
      continue;
    }
    rows.set(key, {
      date,
      service,
      ...(region ? { region } : {}),
      ...(resourceId ? { resourceId } : {}),
      ...(Object.keys(tags).length > 0 ? { tags } : {}),
      currency: "USD",
      amount,
      ...(finite(c.quantity) && unit ? { usageAmount: c.quantity, usageUnit: unit } : {}),
      ...(chargeType !== "usage" ? { chargeType } : {}),
    });
  }
  return [...rows.values()].map((r) => ({ ...r, amount: Math.round(r.amount * 1e6) / 1e6 }));
}

export async function fetchConfluentCostData(
  ctx: ConfluentContext,
  range: CostFetchRange,
  context?: CostContext,
): Promise<CostRow[]> {
  const lines = await fetchCostLines(ctx, range);
  return normalizeCosts(lines, context);
}

/**
 * Effective (post-discount) hourly CKU price per placement, from the CKU
 * line items of the last 30 days that have landed. Used to price the
 * rightsizing catalog: Confluent publishes no pricing API, but every billed
 * CKU-hour states what it cost this organization, discounts included.
 */
export async function ckuHourlyRates(
  ctx: ConfluentContext,
  placements: Map<string, string>,
  now = Date.now(),
): Promise<Map<string, number>> {
  const toDate = isoDay(now - 4 * DAY_MS);
  const fromDate = isoDay(now - 34 * DAY_MS);
  const lines = await fetchCostLines(ctx, { fromDate, toDate });
  const totals = new Map<string, { amount: number; hours: number }>();
  for (const c of lines) {
    if (c.line_type !== "KAFKA_NUM_CKUS") continue;
    const placement = c.resource?.id ? placements.get(c.resource.id) : undefined;
    const amount = netAmount(c);
    if (!placement || amount === null || !finite(c.quantity) || c.quantity <= 0) continue;
    const t = totals.get(placement) ?? { amount: 0, hours: 0 };
    t.amount += amount;
    t.hours += c.quantity;
    totals.set(placement, t);
  }
  const rates = new Map<string, number>();
  for (const [placement, t] of totals) {
    if (t.hours > 0 && t.amount > 0) rates.set(placement, t.amount / t.hours);
  }
  return rates;
}
