/**
 * Actual-spend collection via Cloudflare's Billable Usage API.
 *
 * `GET /accounts/{account_id}/billable-usage` (v1) returns FOCUS 1.3-aligned
 * charge records for self-serve accounts: `ContractedCost` money per
 * `ChargePeriodStart..End`, `ServiceName`/`ServiceFamilyName`, consumed and
 * pricing quantities, and zone attribution. Charge periods follow the
 * subscription billing cycle rather than calendar days, so rows are dated to
 * the charge-period start and the manifest declares `periodNative`.
 *
 * The companion `GET /accounts/{account_id}/billable-usage/info` reports
 * whether the account is covered and each subscription's billing-cycle
 * anchor. Both matter here: uncovered accounts get a CostSetupError instead
 * of silent emptiness, and the usage query returns **nothing** unless the
 * requested range includes a subscription's billing-cycle anchor day, so
 * `from` is widened back to the most recent anchor on or before the chunk
 * start and rows outside the chunk are filtered client-side.
 *
 * Verified against the Cloudflare OpenAPI spec, August 2026. This replaces
 * the retired `/billing/usage/paygo` alpha path (SDK `cf.billing.usage.paygo`)
 * announced as its successor in Cloudflare's billable-usage launch; the
 * installed SDK has no wrapper for the new path yet, so requests go through
 * the SDK client's generic `get` to keep its auth, retry, and 429 behavior.
 *
 * NOTE: rows keep the exact identity shape of the paygo-era rows; date,
 * service, `zone` tag, currency. `ServiceFamilyName` is deliberately NOT
 * emitted as a tag: `tags_hash` is part of the frozen `cost_daily` sort key,
 * so changing the tag set would let re-fetched restatement-window rows land
 * beside their old versions instead of replacing them, permanently
 * double-counting those days.
 */

import type { CostFetchRange, CostRow } from "@infrawrench/plugin-base";
import { CostSetupError } from "@infrawrench/plugin-base";
import { BillingTokenError, withBillingToken } from "./billing-token.js";
import { CloudflareApi, formatCloudflareError } from "./clients/shared.js";

const BILLABLE_USAGE_HELP = {
  label: "Cloudflare billable-usage docs",
  url: "https://developers.cloudflare.com/billing/manage/billable-usage/",
};

const ACCOUNT_TOKENS_HELP = {
  label: "Cloudflare account API tokens docs",
  url: "https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/",
};

export interface CloudflareCostOptions {
  /**
   * The client holds an OAuth access token, which can never read billing
   * (see billing-token.ts): each run mints a short-lived Billing Read token.
   */
  oauth?: boolean;
  /** Wait between retries while a freshly minted token propagates. Tests set 0. */
  retryDelayMs?: number;
}

/** Envelope shared by both billable-usage endpoints. */
interface Envelope<T> {
  success: boolean;
  result: T;
  errors?: Array<{ code?: number; message: string }> | null;
}

/**
 * One usage record from `GET /accounts/{id}/billable-usage`. Only the fields
 * read here are declared; the API carries the full FOCUS 1.3 mandatory set.
 */
interface BillableUsageRecord {
  ServiceName: string;
  ServiceFamilyName?: string | null;
  ChargePeriodStart: string;
  ChargePeriodEnd: string;
  BillingCurrency: string;
  ContractedCost: number;
  ConsumedQuantity: number;
  /** May be empty when the unit is implicit in the service name. */
  ConsumedUnit: string;
  PricingQuantity: number;
  /** Never empty per spec: falls back to "Count". */
  PricingUnit?: string | null;
  ZoneId?: string | null;
  ZoneName?: string | null;
}

interface BillableUsageInfo {
  covered: boolean;
  subscriptions: Array<{
    id: string;
    start_timestamp: string;
    billing_cycle_anchor_timestamp: string;
    end_timestamp?: string;
  }>;
}

/**
 * Info is per-account, not per-range; the collector calls fetchCostData once
 * per month chunk on one client, so cache the lookup for the client's life.
 */
const infoCache = new WeakMap<CloudflareApi, Promise<BillableUsageInfo>>();

/**
 * `cacheKey` is the account's long-lived client; `requester` makes the call,
 * which for an OAuth connection is a per-run minted-token client.
 */
function getBillableUsageInfo(
  cacheKey: CloudflareApi,
  requester: CloudflareApi,
  accountId: string,
  retryDelayMs: number,
): Promise<BillableUsageInfo> {
  let cached = infoCache.get(cacheKey);
  if (!cached) {
    cached = retryWhileUnauthorized(
      () =>
        requester.cf.get<undefined, Envelope<BillableUsageInfo>>(
          `/accounts/${accountId}/billable-usage/info`,
        ),
      retryDelayMs,
    ).then((env) => env.result);
    cached.catch(() => infoCache.delete(cacheKey));
    infoCache.set(cacheKey, cached);
  }
  return cached;
}

/**
 * A newly created token can be refused for a moment while it propagates.
 * `retryDelayMs` of -1 (pasted tokens) disables the retry: there a 403 is the
 * real answer.
 */
async function retryWhileUnauthorized<T>(call: () => Promise<T>, retryDelayMs: number): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (err) {
      const status = (err as { status?: unknown }).status;
      if (retryDelayMs < 0 || attempt >= 2 || (status !== 401 && status !== 403)) throw err;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs * (attempt + 1)));
    }
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * The most recent monthly cycle boundary on or before `isoDate` for a cycle
 * anchored on day-of-month `anchorDay`. Anchor days 29-31 clamp to the last
 * day of shorter months, matching how billing providers roll such anchors.
 */
function latestAnchorOnOrBefore(isoDate: string, anchorDay: number): string {
  let year = Number(isoDate.slice(0, 4));
  let month = Number(isoDate.slice(5, 7));
  const candidate = () =>
    `${year}-${pad2(month)}-${pad2(Math.min(anchorDay, daysInMonth(year, month)))}`;
  let anchor = candidate();
  if (anchor > isoDate) {
    month -= 1;
    if (month === 0) {
      month = 12;
      year -= 1;
    }
    anchor = candidate();
  }
  return anchor;
}

/**
 * Widen the query start so [from, to] contains a billing-cycle anchor day for
 * every subscription that could have usage in the range: the API returns no
 * data for a subscription whose anchor day the range misses. Rows pulled in
 * by the widening are filtered back out against the original range.
 */
function widenFromForAnchors(range: CostFetchRange, info: BillableUsageInfo): string {
  let from = range.fromDate;
  for (const sub of info.subscriptions) {
    if (sub.end_timestamp && sub.end_timestamp.slice(0, 10) < range.fromDate) continue;
    const anchorDay = Number(sub.billing_cycle_anchor_timestamp.slice(8, 10));
    if (!Number.isInteger(anchorDay) || anchorDay < 1) continue;
    const anchor = latestAnchorOnOrBefore(range.toDate, anchorDay);
    if (anchor >= range.fromDate) continue; // range already contains an anchor
    if (anchor < from) from = anchor;
  }
  return from;
}

function isSetupStatus(err: unknown): boolean {
  const status = (err as { status?: unknown }).status;
  return status === 400 || status === 403 || status === 404;
}

function setupError(err: unknown, oauth: boolean): CostSetupError {
  const status = (err as { status?: unknown }).status;
  const reason =
    status === 403
      ? oauth
        ? "Cloudflare refused the temporary Billing Read token this connection created; " +
          "the member who connected it may have lost billing access"
        : "the API token is missing the Billing Read permission; re-create the token " +
          "with that scope added"
      : "the Billable Usage API is not available for this account yet; Cloudflare is " +
        "rolling it out to self-serve accounts first";
  return new CostSetupError(
    `Cloudflare plugin: ${reason}. (${formatCloudflareError(err)})`,
    BILLABLE_USAGE_HELP,
  );
}

export async function fetchCloudflareCostData(
  api: CloudflareApi,
  range: CostFetchRange,
  options: CloudflareCostOptions = {},
): Promise<CostRow[]> {
  const accountId = await api.getAccountId();
  if (!options.oauth) return collectCostRows(api, api, accountId, range, -1, false);

  try {
    return await withBillingToken(api, accountId, (billingApi) =>
      collectCostRows(api, billingApi, accountId, range, options.retryDelayMs ?? 1500, true),
    );
  } catch (err) {
    if (err instanceof BillingTokenError) {
      throw new CostSetupError(`Cloudflare plugin: ${err.message}.`, ACCOUNT_TOKENS_HELP);
    }
    throw err;
  }
}

async function collectCostRows(
  cacheKey: CloudflareApi,
  api: CloudflareApi,
  accountId: string,
  range: CostFetchRange,
  retryDelayMs: number,
  oauth: boolean,
): Promise<CostRow[]> {
  let info: BillableUsageInfo;
  try {
    info = await getBillableUsageInfo(cacheKey, api, accountId, retryDelayMs);
  } catch (err) {
    if (isSetupStatus(err)) throw setupError(err, oauth);
    throw new Error(formatCloudflareError(err), { cause: err });
  }
  if (!info.covered) {
    throw new CostSetupError(
      "Cloudflare plugin: this account is not yet covered by the Billable Usage API; " +
        "Cloudflare is rolling it out to self-serve accounts first, then Enterprise.",
      BILLABLE_USAGE_HELP,
    );
  }

  let records: BillableUsageRecord[];
  try {
    const env = await api.cf.get<{ from: string; to: string }, Envelope<BillableUsageRecord[]>>(
      `/accounts/${accountId}/billable-usage`,
      { query: { from: widenFromForAnchors(range, info), to: range.toDate } },
    );
    records = env.result ?? [];
  } catch (err) {
    if (isSetupStatus(err)) throw setupError(err, oauth);
    throw new Error(formatCloudflareError(err), { cause: err });
  }

  // Aggregate per (date, service, zone, currency): an account can hold several
  // subscriptions of the same service whose charge periods start on the same
  // day, and those must collapse into one stable dimension key.
  const buckets = new Map<string, CostRow>();
  for (const item of records) {
    const amount = item.ContractedCost;
    if (!Number.isFinite(amount) || amount === 0) continue;
    const date = (item.ChargePeriodStart ?? "").slice(0, 10);
    // Keep only periods starting inside the requested chunk: anchor widening
    // and month-aligned chunks would otherwise write overlapping rows.
    if (!date || date < range.fromDate || date > range.toDate) continue;

    const service = item.ServiceName ?? "";
    const zoneName = item.ZoneName ?? "";
    const currency = item.BillingCurrency || "USD";
    const usageAmount = Number.isFinite(item.ConsumedQuantity)
      ? item.ConsumedQuantity
      : Number.isFinite(item.PricingQuantity)
        ? item.PricingQuantity
        : undefined;
    const usageUnit = item.ConsumedUnit || item.PricingUnit || "";

    const key = `${date}|${service}|${zoneName}|${currency}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.amount += amount;
      // Quantities only stay meaningful while every merged record shares a
      // unit; otherwise drop them and keep the money.
      if (existing.usageUnit === usageUnit && usageAmount !== undefined) {
        existing.usageAmount = (existing.usageAmount ?? 0) + usageAmount;
      } else {
        delete existing.usageAmount;
        delete existing.usageUnit;
      }
    } else {
      buckets.set(key, {
        date,
        service,
        ...(zoneName ? { tags: { zone: zoneName } } : {}),
        currency,
        amount,
        ...(usageAmount !== undefined && usageUnit ? { usageAmount, usageUnit } : {}),
      });
    }
  }
  return [...buckets.values()].filter((row) => row.amount !== 0);
}
