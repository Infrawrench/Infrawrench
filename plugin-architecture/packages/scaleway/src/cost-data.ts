/**
 * Actual-spend collection via the Scaleway Billing API's consumption
 * endpoint.
 *
 * `GET /billing/v2beta1/consumptions?project_id=…&billing_period=YYYY-MM`
 * returns the (running) consumption of one monthly billing period, broken
 * down by product/SKU and resource, priced as a Money value (units + nanos).
 * Spend is period-native: every row is dated to the first day of its billing
 * period, and a chunk only reports the periods whose first day it contains —
 * chunks with no period start inside them return nothing — so month-aligned
 * chunks and restatement re-fetches stay exactly-once. The in-progress month
 * restates continuously; the host's trailing re-collection window absorbs it.
 *
 * The endpoint requires precisely one of organization_id or project_id. The
 * plugin's stored credentials carry a project ID (no organization ID), so
 * cost collection is scoped to that project and needs the Default Project ID
 * credential to be set. IAM-wise, the `BillingReadOnly` permission set on
 * the API key's principal is sufficient.
 */

import type { CostFetchRange, CostRow, HttpHostServices } from "@infrawrench/plugin-base";
import { jsonRestFetch } from "@infrawrench/plugin-base";

const CONSUMPTIONS_URL = "https://api.scaleway.com/billing/v2beta1/consumptions";
const PAGE_SIZE = 100;

/** google.type.Money as serialized by the Scaleway API. */
interface ScwMoney {
  currency_code?: string;
  units?: number | string;
  nanos?: number;
}

interface ScwConsumption {
  value?: ScwMoney;
  /** e.g. "VPC Public Gateway S" — the billed product. */
  product_name?: string;
  /** Invoice category, e.g. "Compute", "Network". */
  category_name?: string;
  /** Reference of the consuming resource (name/ID, category-dependent). */
  resource_name?: string;
  project_id?: string;
}

interface ScwConsumptionsResponse {
  consumptions?: ScwConsumption[];
  total_count?: number;
}

function moneyAmount(money: ScwMoney | undefined): number {
  if (!money) return 0;
  return Number(money.units ?? 0) + (money.nanos ?? 0) / 1e9;
}

/** First-of-month dates (`YYYY-MM-01`) inside the inclusive range. */
function periodStartsInRange(range: CostFetchRange): string[] {
  const out: string[] = [];
  const from = new Date(`${range.fromDate}T00:00:00.000Z`);
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  if (cursor.toISOString().slice(0, 10) < range.fromDate) {
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  while (cursor.toISOString().slice(0, 10) <= range.toDate) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return out;
}

export interface ScalewayCostCredentials {
  secretKey: string;
  projectId: string;
  http?: HttpHostServices;
}

export async function fetchScalewayCostData(
  creds: ScalewayCostCredentials,
  range: CostFetchRange,
): Promise<CostRow[]> {
  if (!creds.projectId) {
    throw new Error(
      "Scaleway plugin: cost collection requires the Default Project ID credential — " +
        "the billing consumption API is scoped to a single project or organization.",
    );
  }

  // Aggregate per (date, product, resource) so SKUs sharing a product and
  // resource collapse into one stable dimension key.
  const totals = new Map<string, { row: CostRow; amount: number }>();
  const add = (
    date: string,
    service: string,
    resourceId: string,
    projectId: string,
    currency: string,
    amount: number,
  ): void => {
    if (!Number.isFinite(amount) || amount === 0) return;
    const key = `${date} ${service} ${resourceId} ${projectId} ${currency}`;
    const entry = totals.get(key);
    if (entry) {
      entry.amount += amount;
      return;
    }
    totals.set(key, {
      row: {
        date,
        service,
        ...(resourceId ? { resourceId } : {}),
        ...(projectId ? { tags: { project: projectId } } : {}),
        currency,
        amount: 0,
      },
      amount,
    });
  };

  for (const periodStart of periodStartsInRange(range)) {
    const billingPeriod = periodStart.slice(0, 7); // YYYY-MM
    let page = 1;
    for (;;) {
      const params = new URLSearchParams({
        project_id: creds.projectId,
        billing_period: billingPeriod,
        page_size: String(PAGE_SIZE),
        page: String(page),
      });
      const res = await jsonRestFetch<ScwConsumptionsResponse>({
        vendor: "Scaleway",
        url: `${CONSUMPTIONS_URL}?${params.toString()}`,
        errorPath: "/billing/v2beta1/consumptions",
        headers: { "X-Auth-Token": creds.secretKey },
        ...(creds.http ? { http: creds.http } : {}),
      });
      const batch = res.consumptions ?? [];
      for (const consumption of batch) {
        add(
          periodStart,
          consumption.product_name || consumption.category_name || "",
          consumption.resource_name ?? "",
          consumption.project_id ?? creds.projectId,
          consumption.value?.currency_code ?? "EUR",
          moneyAmount(consumption.value),
        );
      }
      if (batch.length < PAGE_SIZE) break;
      page += 1;
    }
  }

  const rows: CostRow[] = [];
  for (const { row, amount } of totals.values()) {
    if (amount === 0) continue;
    rows.push({ ...row, amount });
  }
  return rows;
}
