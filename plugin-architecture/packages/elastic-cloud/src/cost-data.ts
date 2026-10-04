/**
 * Actual-spend collection from the Elastic Cloud Billing API (v2).
 *
 * `GET /api/v2/billing/organizations/{org}/costs/instances?from=&to=` returns
 * every instance billed in the window (hosted deployments, serverless
 * projects, and organization-level services such as Synthetics or Cloud
 * Connect usage), each with its product line items: the SKU, the line-item
 * type (`capacity`, `data_in`, `data_out`, `data_internode`, `storage_api`,
 * `storage_bytes`, and the serverless dimensions), quantity, rate and
 * `total_ecu`.
 *
 * The response is an aggregate over the window with no daily buckets, so a
 * day is one request with a 24-hour window: the same shape Elastic's own
 * billing integration uses (`packages/ess_billing` in elastic/integrations).
 * Days that have not ended yet are skipped; the next pass picks them up.
 *
 * Amounts are Elastic Consumption Units. "The nominal value of one Elastic
 * Consumption Unit is $1.00" (Elastic billing docs), so rows are written in
 * USD at that rate. Prepaid ECUs bought at a discount therefore read at
 * nominal value, not the negotiated price.
 */

import type { CostFetchRange, CostRow, CreditBalance } from "@infrawrench/plugin-base";
import { CostSetupError, CreditAccessError } from "@infrawrench/plugin-base";
import type { EcContext } from "./api.js";
import { billingApi, cloudApi, isPermissionError, statusOf } from "./api.js";
import type { EcCostsOverview, EcInstanceCosts, EcOrganization } from "./types.js";

const DAY_MS = 86_400_000;
/** Day requests in flight at once, per organization. */
const DAY_CONCURRENCY = 4;

const BILLING_HELP = {
  label: "Elastic Cloud API keys",
  url: "https://cloud.elastic.co/account/keys",
};

/** Known line-item types to readable cost categories. */
const TYPE_LABELS: Record<string, string> = {
  capacity: "Capacity",
  data_in: "Data Transfer In",
  data_out: "Data Transfer Out",
  data_internode: "Data Transfer (Inter-Node)",
  storage_api: "Snapshot Storage Requests",
  storage_bytes: "Snapshot Storage",
};

/** "search_power_vcu" → "Search Power Vcu"; used for types added after this list. */
function humanize(value: string): string {
  return value
    .replace(/[_.-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function lineItemCategory(type: string | undefined): string {
  if (!type) return "Other";
  return TYPE_LABELS[type] ?? humanize(type);
}

/** Readable label for an instance `type` (`deployment`, `elasticsearch`, …). */
export function instanceTypeLabel(type: string | undefined): string {
  switch (type) {
    case "deployment":
      return "Hosted deployment";
    case "elasticsearch":
      return "Elasticsearch project";
    case "observability":
      return "Observability project";
    case "security":
      return "Security project";
    case "vectordb":
      return "Vector database project";
    default:
      return type ? humanize(type) : "Other";
  }
}

const SKU_REGION = /(?:^|_)((?:aws|gcp|azure)-[a-z0-9-]+?)(?=_|$)/;

/** Region id embedded in a capacity SKU (`gcp.es.ml.n2.68x32x45_gcp-europe-west1_8192_1`). */
export function regionFromSku(sku: string | undefined): string | undefined {
  if (!sku) return undefined;
  return SKU_REGION.exec(sku)?.[1];
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Every complete UTC day in the inclusive range, as `[from, to)` epoch-ms pairs. */
export function completeDays(range: CostFetchRange, nowMs: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const start = Date.parse(`${range.fromDate}T00:00:00Z`);
  const end = Date.parse(`${range.toDate}T00:00:00Z`);
  for (let d = start; d <= end; d += DAY_MS) {
    if (d + DAY_MS > nowMs) break;
    out.push([d, d + DAY_MS]);
  }
  return out;
}

/** The organizations the key can see. Most keys see exactly one. */
export async function listOrganizations(ctx: EcContext): Promise<EcOrganization[]> {
  const res = await cloudApi<{ organizations?: EcOrganization[] }>(ctx, "/api/v1/organizations");
  return (res.organizations ?? []).filter((o) => o.id);
}

/** Rows for one organization and one day, from that day's instance costs. */
export function rowsForDay(date: string, orgId: string, body: EcInstanceCosts): CostRow[] {
  const rows: CostRow[] = [];
  for (const inst of body.instances ?? []) {
    const instanceId = inst.id ?? "";
    for (const item of inst.product_line_items ?? []) {
      const amount = Number(item.total_ecu ?? 0);
      if (!Number.isFinite(amount) || amount === 0) continue;
      const region = regionFromSku(item.sku);
      const quantity = Number(item.quantity?.value);
      rows.push({
        date,
        service: lineItemCategory(item.type),
        ...(region ? { region } : {}),
        ...(instanceId ? { resourceId: instanceId } : {}),
        tags: {
          organization: orgId,
          instance_type: instanceTypeLabel(inst.type),
          ...(inst.name ? { instance: inst.name } : {}),
          ...(item.kind ? { component: item.kind } : {}),
        },
        currency: "USD",
        amount,
        ...(Number.isFinite(quantity) && item.unit
          ? { usageAmount: quantity, usageUnit: item.unit }
          : {}),
      });
    }
  }
  return aggregateRows(rows);
}

/** Sum rows that share every dimension, so two SKUs of one category become one row. */
export function aggregateRows(rows: CostRow[]): CostRow[] {
  const byKey = new Map<string, CostRow>();
  for (const row of rows) {
    const tags = row.tags
      ? Object.entries(row.tags)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => `${k}=${v}`)
          .join(",")
      : "";
    const key = [row.date, row.service, row.region, row.resourceId, tags].join("|");
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...row });
      continue;
    }
    existing.amount += row.amount;
    // Quantities only add up when they are in the same unit.
    if (
      existing.usageUnit &&
      existing.usageUnit === row.usageUnit &&
      existing.usageAmount !== undefined &&
      row.usageAmount !== undefined
    ) {
      existing.usageAmount += row.usageAmount;
    } else {
      delete existing.usageAmount;
      delete existing.usageUnit;
    }
  }
  return [...byKey.values()];
}

async function mapLimited<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export async function fetchElasticCostData(
  ctx: EcContext,
  range: CostFetchRange,
  nowMs: number = Date.now(),
): Promise<CostRow[]> {
  let orgs: EcOrganization[];
  try {
    orgs = await listOrganizations(ctx);
  } catch (err) {
    if (statusOf(err) === 401) throw err;
    if (isPermissionError(err)) {
      throw new CostSetupError(
        "This Elastic Cloud API key cannot read its organization. Create a key with the Billing admin role (or Organization owner) to collect costs.",
        BILLING_HELP,
      );
    }
    throw err;
  }
  const days = completeDays(range, nowMs);
  const rows: CostRow[] = [];
  for (const org of orgs) {
    const orgId = org.id!;
    const perDay = await mapLimited(days, DAY_CONCURRENCY, async ([from, to]) => {
      try {
        const body = await billingApi<EcInstanceCosts>(
          ctx,
          `/api/v2/billing/organizations/${encodeURIComponent(orgId)}/costs/instances`,
          {
            query: {
              from: new Date(from).toISOString(),
              to: new Date(to).toISOString(),
              include_names: true,
            },
          },
        );
        return rowsForDay(isoDay(from), orgId, body ?? {});
      } catch (err) {
        if (statusOf(err) === 403) {
          throw new CostSetupError(
            `This Elastic Cloud API key cannot read billing for organization ${org.name ?? orgId}. Give the key the Billing admin role (or Organization owner) under Organization, API keys.`,
            BILLING_HELP,
          );
        }
        throw err;
      }
    });
    for (const day of perDay) rows.push(...day);
  }
  return rows;
}

/**
 * Month-to-date overview for one organization (v1, still the only endpoint
 * that reports the hourly rate and the prepaid balance).
 */
export async function fetchCostsOverview(ctx: EcContext, orgId: string): Promise<EcCostsOverview> {
  return cloudApi<EcCostsOverview>(ctx, `/api/v1/billing/costs/${encodeURIComponent(orgId)}`);
}

/**
 * Prepaid ECU balances: one pot per active order line item of every
 * organization the key sees, from the overview's `balance.line_items`.
 * Pay-as-you-go and marketplace organizations have no balance and return
 * nothing.
 */
export async function fetchElasticCreditBalance(
  ctx: EcContext,
  nowMs: number = Date.now(),
): Promise<CreditBalance[]> {
  const orgs = await listOrganizations(ctx);
  const out: CreditBalance[] = [];
  for (const org of orgs) {
    let overview: EcCostsOverview;
    try {
      overview = await fetchCostsOverview(ctx, org.id!);
    } catch (err) {
      if (statusOf(err) === 403) {
        throw new CreditAccessError(
          "This Elastic Cloud API key cannot read the organization's billing. Give it the Billing admin role to see the prepaid balance.",
          BILLING_HELP,
        );
      }
      throw err;
    }
    const prefix = orgs.length > 1 ? `${org.name ?? org.id}: ` : "";
    for (const [i, item] of (overview.balance?.line_items ?? []).entries()) {
      const end = item.end ? Date.parse(item.end) : NaN;
      const start = item.start ? Date.parse(item.start) : NaN;
      if (Number.isFinite(end) && end < nowMs) continue;
      if (Number.isFinite(start) && start > nowMs) continue;
      out.push({
        key: `${org.id}:${item.id ?? i}`,
        label: `${prefix}Prepaid ECUs${item.end ? ` (until ${item.end.slice(0, 10)})` : ""}`,
        remaining: Number(item.ecu_balance ?? 0),
        // 1 ECU = $1.00 nominal, the conversion the cost collector uses.
        currency: "USD",
        ...(typeof item.ecu_quantity === "number" ? { granted: item.ecu_quantity } : {}),
        ...(item.end ? { expiresAt: item.end } : {}),
      });
    }
  }
  return out;
}
