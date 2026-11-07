import {
  CostSetupError,
  CreditAccessError,
  type CostFetchRange,
  type CostRow,
  type CreditBalance,
  pathEncode,
} from "@infrawrench/plugin-base";
import { isPermissionGap, type IbmApi } from "./api.js";
import type { components } from "./api-types.usage.gen.js";
import { crnService } from "./regions.js";

/**
 * Usage Reports API v4 (`billing.cloud.ibm.com`). Costs come from
 * `GET /v4/accounts/{account}/resource_instances/usage/{yyyy-mm}`: one record
 * per resource instance and plan per month, each with per-metric `cost`
 * (after discounts) and `rated_cost` (before). What `billable` or
 * `non_chargeable` says is not charged counts as zero, with its usage kept. IBM
 * only reports usage by month, so rows are dated to the 1st and the declaration
 * is `periodNative`.
 * Credits are the account summary's `offers` (promotional credit).
 */

const ACCESS_DOCS = "https://cloud.ibm.com/iam/users";

type Schemas = components["schemas"];

/** A usage record as the mapper reads it: what a page leaves out reads as nothing. */
type Sketch<T> = { [K in keyof T]?: T[K] | undefined };

export type InstanceUsage = Sketch<Omit<Schemas["Instance_Usage"], "usage">> & {
  usage?: Array<Sketch<Schemas["Metric"]>> | undefined;
};

/** `yyyy-mm` for every month the inclusive range touches. */
export function monthsIn(range: CostFetchRange): string[] {
  const out: string[] = [];
  // A date with no month reads as NaN, which ends the loop before it starts.
  let [y = NaN, m = NaN] = range.fromDate.slice(0, 7).split("-").map(Number);
  const [ey = NaN, em = NaN] = range.toDate.slice(0, 7).split("-").map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

/**
 * The id this plugin's resources carry for a usage record: VPC resources are
 * `{region}/{id}` (the last CRN segment), Kubernetes clusters their cluster
 * id, everything else its CRN.
 */
export function resourceIdFor(crn: string, region: string | undefined): string {
  const service = crnService(crn);
  const parts = crn.split(":");
  if (service === "is") {
    const id = parts[parts.length - 1] ?? "";
    return id && region ? `${region}/${id}` : crn;
  }
  if (service === "containers-kubernetes") return parts[7] || crn;
  return crn;
}

export function usageToRows(month: string, records: InstanceUsage[]): CostRow[] {
  const date = `${month}-01`;
  const rows: CostRow[] = [];
  for (const r of records) {
    const crn = r.resource_instance_id ?? "";
    for (const m of r.usage ?? []) {
      // Both flags mean the cost is shown but never billed. A list price of zero
      // keeps a re-rated invoice from charging for it too.
      const charged = r.billable !== false && m.non_chargeable !== true;
      const amount = charged ? Number(m.cost ?? 0) : 0;
      const gross = charged ? Number(m.rated_cost ?? amount) : 0;
      if (!Number.isFinite(amount) || (amount === 0 && !m.quantity)) continue;
      const tags: Record<string, string> = {};
      if (r.plan_name) tags["plan"] = r.plan_name;
      if (r.resource_group_name) tags["resourceGroup"] = r.resource_group_name;
      if (m.metric_name || m.metric) tags["metric"] = m.metric_name || m.metric || "";
      const unit = m.unit_name || m.unit;
      if (r.resource_instance_name) tags["instance"] = r.resource_instance_name;
      rows.push({
        date,
        service: r.resource_name || r.resource_id || "Other",
        ...(r.region ? { region: r.region } : {}),
        ...(crn ? { resourceId: resourceIdFor(crn, r.region) } : {}),
        tags,
        currency: r.currency_code || "USD",
        amount,
        ...(Number.isFinite(gross) ? { listAmount: gross } : {}),
        ...(m.quantity !== undefined && Number.isFinite(m.quantity)
          ? { usageAmount: m.quantity }
          : {}),
        ...(unit ? { usageUnit: unit } : {}),
      });
    }
  }
  return rows;
}

export async function fetchCostData(api: IbmApi, range: CostFetchRange): Promise<CostRow[]> {
  const accountId = await api.accountId();
  const rows: CostRow[] = [];
  for (const month of monthsIn(range)) {
    let start: string | undefined;
    for (let page = 0; page < 500; page++) {
      let res;
      try {
        res = await api.usage.get(
          `/v4/accounts/${pathEncode(accountId)}/resource_instances/usage/${pathEncode(month)}`,
          {
            query: {
              _names: true,
              _limit: 200,
              ...(start ? { _start: start } : {}),
            },
          },
        );
      } catch (err) {
        if (isPermissionGap(err)) {
          throw new CostSetupError(
            "This API key cannot read usage reports. Give its user or service ID the Viewer role on the Billing account management service.",
            { label: "Open access settings", url: ACCESS_DOCS },
          );
        }
        throw err;
      }
      rows.push(...usageToRows(month, res.resources ?? []));
      start = res.next?.offset;
      if (!start) break;
    }
  }
  return rows;
}

async function summary(api: IbmApi, month: string) {
  const accountId = await api.accountId();
  return api.usage.get(`/v4/accounts/${pathEncode(accountId)}/summary/${pathEncode(month)}`);
}

export async function fetchCredits(api: IbmApi, now = new Date()): Promise<CreditBalance[]> {
  let s;
  try {
    s = await summary(api, now.toISOString().slice(0, 7));
  } catch (err) {
    if (isPermissionGap(err)) {
      throw new CreditAccessError(
        "This API key cannot read the account summary. Give it the Viewer role on Billing.",
        { label: "Open access settings", url: ACCESS_DOCS },
      );
    }
    throw err;
  }
  const currency = s.billing_currency_code || "USD";
  return (s.offers ?? [])
    .filter((o) => o.credits?.balance !== undefined)
    .map((o) => ({
      key: o.offer_id ?? o.offer_template ?? "offer",
      label: o.offer_template ? `Promotion ${o.offer_template}` : "Promotional credit",
      remaining: Number(o.credits?.balance ?? 0),
      currency,
      ...(o.credits?.starting_balance !== undefined
        ? { granted: Number(o.credits.starting_balance) }
        : {}),
      ...(o.expires_on ? { expiresAt: o.expires_on } : {}),
    }));
}

export async function monthToDate(
  api: IbmApi,
  now = new Date(),
): Promise<{ currency: string; billable: number; nonBillable: number }> {
  const s = await summary(api, now.toISOString().slice(0, 7));
  return {
    currency: s.billing_currency_code || "USD",
    billable: Number(s.resources?.billable_cost ?? 0),
    nonBillable: Number(s.resources?.non_billable_cost ?? 0),
  };
}
