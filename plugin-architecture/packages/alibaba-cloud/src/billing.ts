import {
  CostSetupError,
  CreditAccessError,
  QuotaAccessError,
  type CostChargeType,
  type CostFetchRange,
  type CostRow,
  type CreditBalance,
  type QuotaUsage,
} from "@infrawrench/plugin-base";
import { isPermissionGap, type AliApi } from "./api.js";
import { regionIdForLabel } from "./regions.js";

/**
 * Billing through BSS OpenAPI (BssOpenApi 2017-12-14), which on the
 * international site lives at `business.ap-southeast-1.aliyuncs.com` for
 * every region.
 *
 * Cost rows come from `DescribeInstanceBill` with `Granularity=DAILY`, one
 * request (plus pages of 300) per day. Alibaba's limits, from the API's own
 * description: 18 months of history, data 24 hours behind (instance
 * attributes 48), the current month provisional until the 3rd of the next
 * month at noon, 10 requests per second per user. Shared products (CDN, OSS,
 * shared bandwidth) are billed per instance here, not per split item.
 */

const DAY_MS = 86_400_000;
const BILLING_CONSOLE = "https://usercenter2-intl.aliyun.com/billing";
const RAM_CONSOLE = "https://ram.console.alibabacloud.com/users";

export interface BillItem {
  BillingDate?: string;
  ProductCode?: string;
  ProductName?: string;
  ProductDetail?: string;
  InstanceID?: string;
  Region?: string;
  PretaxAmount?: number;
  PretaxGrossAmount?: number;
  Currency?: string;
  Tag?: string;
  ResourceGroup?: string;
  BillingItem?: string;
  SubscriptionType?: string;
  Item?: string;
  Usage?: string;
  UsageUnit?: string;
}

function days(range: CostFetchRange): string[] {
  const out: string[] = [];
  let t = Date.parse(`${range.fromDate}T00:00:00Z`);
  const end = Date.parse(`${range.toDate}T00:00:00Z`);
  for (; t <= end; t += DAY_MS) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/** `key:env value:prod; key:team value:core` → `{ env: "prod", team: "core" }`. */
export function parseBillTags(tag: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!tag) return out;
  for (const part of tag.split(";")) {
    const m = /key:\s*(.*?)\s+value:\s*(.*)$/.exec(part.trim());
    if (m && m[1]) out[m[1]] = m[2] ?? "";
  }
  return out;
}

function chargeTypeOf(item: string | undefined): CostChargeType | undefined {
  switch (item) {
    case "Refund":
      return "refund";
    case "Adjustment":
      return "adjustment";
    default:
      return undefined;
  }
}

function setupError(err: unknown): never {
  if (isPermissionGap(err)) {
    throw new CostSetupError(
      "This AccessKey cannot read bills. Attach the AliyunBSSReadOnlyAccess policy to its RAM user.",
      { label: "Open RAM users", url: RAM_CONSOLE },
    );
  }
  throw err;
}

export async function fetchDayBill(api: AliApi, day: string): Promise<BillItem[]> {
  const items: BillItem[] = [];
  let token: string | undefined;
  for (let page = 0; page < 200; page++) {
    const res = await api.rpc<{ Data?: { Items?: BillItem[]; NextToken?: string } }>(
      "bss",
      "",
      "DescribeInstanceBill",
      {
        BillingCycle: day.slice(0, 7),
        BillingDate: day,
        Granularity: "DAILY",
        IsHideZeroCharge: true,
        MaxResults: 300,
        NextToken: token,
      },
    );
    items.push(...(res.Data?.Items ?? []));
    token = res.Data?.NextToken;
    if (!token) break;
  }
  return items;
}

export function billToRows(day: string, items: BillItem[]): CostRow[] {
  const rows = new Map<string, CostRow>();
  for (const it of items) {
    const amount = Number(it.PretaxAmount ?? 0);
    if (!Number.isFinite(amount)) continue;
    const service = it.ProductName || it.ProductCode || "Other";
    const region = it.Region ? regionIdForLabel(it.Region) : undefined;
    const rawId = it.InstanceID ?? "";
    const resourceId = rawId ? (region ? `${region}/${rawId}` : rawId) : "";
    const currency = it.Currency || "USD";
    const chargeType = chargeTypeOf(it.Item);
    const tags: Record<string, string> = { ...parseBillTags(it.Tag) };
    if (it.BillingItem) tags["billingItem"] = it.BillingItem;
    if (it.SubscriptionType) tags["subscriptionType"] = it.SubscriptionType;
    if (it.ResourceGroup) tags["resourceGroup"] = it.ResourceGroup;
    if (it.ProductDetail && it.ProductDetail !== service) tags["productDetail"] = it.ProductDetail;
    const key = [
      service,
      region ?? "",
      resourceId,
      currency,
      chargeType ?? "",
      JSON.stringify(tags),
    ].join("\u0000");
    const usage = it.Usage !== undefined && it.Usage !== "" ? Number(it.Usage) : undefined;
    const gross = Number(it.PretaxGrossAmount ?? amount);
    const existing = rows.get(key);
    if (existing) {
      existing.amount += amount;
      if (existing.listAmount !== undefined && Number.isFinite(gross)) existing.listAmount += gross;
      if (usage !== undefined && Number.isFinite(usage) && existing.usageAmount !== undefined) {
        existing.usageAmount += usage;
      }
      continue;
    }
    rows.set(key, {
      date: day,
      service,
      ...(region ? { region } : {}),
      ...(resourceId ? { resourceId } : {}),
      ...(Object.keys(tags).length ? { tags } : {}),
      currency,
      amount,
      ...(Number.isFinite(gross) ? { listAmount: gross } : {}),
      ...(usage !== undefined && Number.isFinite(usage) ? { usageAmount: usage } : {}),
      ...(it.UsageUnit ? { usageUnit: it.UsageUnit } : {}),
      ...(chargeType ? { chargeType } : {}),
    });
  }
  return [...rows.values()];
}

export async function fetchCostData(api: AliApi, range: CostFetchRange): Promise<CostRow[]> {
  const out: CostRow[] = [];
  for (const day of days(range)) {
    let items: BillItem[];
    try {
      items = await fetchDayBill(api, day);
    } catch (err) {
      setupError(err);
    }
    out.push(...billToRows(day, items));
  }
  return out;
}

/** Strings like "1,234.56" or "-12.00". */
export function parseMoney(value: string | undefined): number {
  if (!value) return 0;
  const n = Number(value.replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

export async function fetchBalance(api: AliApi): Promise<CreditBalance[]> {
  let data:
    { AvailableAmount?: string; AvailableCashAmount?: string; Currency?: string } | undefined;
  try {
    data = (await api.rpc<{ Data?: typeof data }>("bss", "", "QueryAccountBalance")).Data;
  } catch (err) {
    if (isPermissionGap(err)) {
      throw new CreditAccessError(
        "This AccessKey cannot read the account balance. Attach AliyunBSSReadOnlyAccess to its RAM user.",
        { label: "Open RAM users", url: RAM_CONSOLE },
      );
    }
    throw err;
  }
  if (!data) return [];
  return [
    {
      key: "balance",
      label: "Account balance",
      remaining: parseMoney(data.AvailableAmount),
      currency: data.Currency || "USD",
    },
  ];
}

/** Month-to-date billed spend from `QueryBillOverview`, for the account detail view. */
export async function monthToDate(
  api: AliApi,
  now = new Date(),
): Promise<{ currency: string; spent: number; gross: number }> {
  const res = await api.rpc<{
    Data?: {
      Items?: {
        Item?: Array<{ PretaxAmount?: number; PretaxGrossAmount?: number; Currency?: string }>;
      };
    };
  }>("bss", "", "QueryBillOverview", { BillingCycle: now.toISOString().slice(0, 7) });
  let spent = 0;
  let gross = 0;
  let currency = "USD";
  for (const i of res.Data?.Items?.Item ?? []) {
    spent += Number(i.PretaxAmount ?? 0) || 0;
    gross += Number(i.PretaxGrossAmount ?? 0) || 0;
    if (i.Currency) currency = i.Currency;
  }
  return { currency, spent, gross };
}

/**
 * Quota Center (`quotas` 2020-05-10, `ListProductQuotas`) for ECS and VPC in
 * the default region. Only quotas Alibaba reports both a limit and a usage
 * for are returned; the list is a representative subset (`partial`).
 */
export async function fetchQuotas(api: AliApi, region: string): Promise<QuotaUsage[]> {
  const out: QuotaUsage[] = [];
  for (const product of ["ecs", "vpc"]) {
    let token: string | undefined;
    for (let page = 0; page < 5; page++) {
      let res: {
        Quotas?: Array<{
          QuotaActionCode?: string;
          QuotaName?: string;
          TotalQuota?: number;
          TotalUsage?: number;
          Consumable?: boolean;
          Adjustable?: boolean;
          QuotaUnit?: string;
        }>;
        NextToken?: string;
      };
      try {
        res = await api.rpc(
          "quotas",
          "",
          "ListProductQuotas",
          {
            ProductCode: product,
            MaxResults: 100,
            NextToken: token,
            Dimensions: [{ Key: "regionId", Value: region }],
          },
          { form: true },
        );
      } catch (err) {
        if (isPermissionGap(err)) {
          throw new QuotaAccessError(
            "This AccessKey cannot read Quota Center. Attach the AliyunQuotasReadOnlyAccess policy to its RAM user.",
            { label: "Open RAM users", url: RAM_CONSOLE },
          );
        }
        throw err;
      }
      for (const q of res.Quotas ?? []) {
        const limit = Number(q.TotalQuota);
        const used = Number(q.TotalUsage);
        if (!q.QuotaActionCode || !q.Consumable) continue;
        if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(used)) continue;
        out.push({
          id: `${product}/${q.QuotaActionCode}/${region}`,
          service: product,
          name: q.QuotaName || q.QuotaActionCode,
          region,
          limit,
          used,
          ...(q.QuotaUnit && q.QuotaUnit !== "AMOUNT" ? { unit: q.QuotaUnit } : {}),
          ...(q.Adjustable !== undefined ? { adjustable: q.Adjustable } : {}),
        });
      }
      token = res.NextToken;
      if (!token) break;
    }
  }
  return out;
}

export { BILLING_CONSOLE };
