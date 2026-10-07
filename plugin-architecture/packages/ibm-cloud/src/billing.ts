import {
  CostSetupError,
  CreditAccessError,
  type CostFetchRange,
  type CostRow,
  type CreditBalance,
} from "@infrawrench/plugin-base";
import { isPermissionGap, type IbmApi } from "./api.js";
import { BILLING, crnService } from "./regions.js";

/**
 * Usage Reports API v4 (`billing.cloud.ibm.com`). Costs come from
 * `GET /v4/accounts/{account}/resource_instances/usage/{yyyy-mm}`: one record
 * per resource instance and plan per month, each with per-metric `cost`
 * (after discounts) and `rated_cost` (before). IBM only reports usage by
 * month, so rows are dated to the 1st and the declaration is `periodNative`.
 * Credits are the account summary's `offers` (promotional credit).
 */

const ACCESS_DOCS = "https://cloud.ibm.com/iam/users";

interface UsageMetric {
  metric?: string;
  metric_name?: string;
  quantity?: number;
  cost?: number;
  rated_cost?: number;
  unit?: string;
  unit_name?: string;
  non_chargeable?: boolean;
}

export interface InstanceUsage {
  resource_instance_id?: string;
  resource_instance_name?: string;
  resource_id?: string;
  resource_name?: string;
  resource_group_name?: string;
  region?: string;
  currency_code?: string;
  plan_name?: string;
  usage?: UsageMetric[];
  pending?: boolean;
}

/** `yyyy-mm` for every month the inclusive range touches. */
export function monthsIn(range: CostFetchRange): string[] {
  const out: string[] = [];
  let [y, m] = range.fromDate.slice(0, 7).split("-").map(Number) as [number, number];
  const [ey, em] = range.toDate.slice(0, 7).split("-").map(Number) as [number, number];
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
      const amount = Number(m.cost ?? 0);
      const gross = Number(m.rated_cost ?? amount);
      if (!Number.isFinite(amount) || (amount === 0 && !m.quantity)) continue;
      const tags: Record<string, string> = {};
      if (r.plan_name) tags["plan"] = r.plan_name;
      if (r.resource_group_name) tags["resourceGroup"] = r.resource_group_name;
      if (m.metric_name || m.metric) tags["metric"] = m.metric_name || m.metric || "";
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
        ...(m.unit_name || m.unit ? { usageUnit: m.unit_name || m.unit } : {}),
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
      let res: { resources?: InstanceUsage[]; next?: { offset?: string } };
      try {
        res = await api.get(
          `${BILLING}/v4/accounts/${accountId}/resource_instances/usage/${month}`,
          {
            _names: true,
            _limit: 200,
            ...(start ? { _start: start } : {}),
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

interface Summary {
  billing_currency_code?: string;
  resources?: { billable_cost?: number; non_billable_cost?: number };
  offers?: Array<{
    offer_id?: string;
    offer_template?: string;
    expires_on?: string;
    credits?: { starting_balance?: number; used?: number; balance?: number };
  }>;
}

async function summary(api: IbmApi, month: string): Promise<Summary> {
  const accountId = await api.accountId();
  return api.get<Summary>(`${BILLING}/v4/accounts/${accountId}/summary/${month}`);
}

export async function fetchCredits(api: IbmApi, now = new Date()): Promise<CreditBalance[]> {
  let s: Summary;
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
