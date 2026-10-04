/**
 * Twilio cost collection from the Usage Records API.
 *
 * `price` on a usage record is what Twilio billed (in `price_unit`, at the
 * account's own rates, after volume discounts), so these rows reconcile with
 * the invoice; nothing here multiplies usage by a rate card.
 *
 * Per scope (an account, with or without its subaccounts):
 *
 * 1. One `GET …/Usage/Records.json?StartDate&EndDate` returns one record per
 *    category for the whole range. That says which categories cost anything,
 *    and lets `selectLeafCategories` drop the rollups (`calls` over
 *    `calls-inbound` over `calls-inbound-local`) so nothing is counted twice.
 *    A scope whose `totalprice` is zero stops here, which is what keeps idle
 *    subaccounts at one request each.
 * 2. `…/Usage/Records/Daily.json?Category=<leaf>` per priced leaf, plus
 *    `Category=totalprice`, gives the daily split.
 * 3. Each day is reconciled against that day's `totalprice`: a shortfall
 *    (Twilio: "some Twilio costs may not be included in any usage category")
 *    becomes an `Other` row, and an excess (an overlap this plugin does not
 *    know about) scales the day's leaves down to the billed total. Either
 *    way the day sums to what Twilio billed.
 *
 * Subaccounts: with the auth token, the main account (`IncludeSubaccounts=false`)
 * and each subaccount are collected separately, `resourceId` set to the
 * account SID and a `subaccount` tag naming it; the parent's
 * `IncludeSubaccounts=true` total is then reconciled the same way, so usage
 * from subaccounts past the cap (or ones the credential could not read) lands
 * in an `Other subaccounts` row instead of vanishing. API keys cannot read
 * subaccount usage at all (Twilio: "Main account API Keys are only available
 * to access main account resources"), so with a key the whole account is one
 * scope and there is no per-subaccount split.
 */
import type { CostFetchRange, CostRow } from "@infrawrench/plugin-base";
import type { TwilioContext } from "./api.js";
import { accountPath, isAccessDenied, list2010 } from "./api.js";
import { TOTAL_CATEGORY, productOf, selectLeafCategories } from "./categories.js";
import type { TwUsageRecord } from "./mappers.js";
import { num } from "./mappers.js";

/** Most subaccounts collected individually; the rest reconcile into one row. */
export const MAX_SUBACCOUNT_SCOPES = 100;
/** Below this, a reconciliation difference is rounding, not money. */
const EPSILON = 0.005;
const CONCURRENCY = 4;

export interface SubaccountRef {
  sid: string;
  name: string;
}

interface Scope {
  accountSid: string;
  includeSubaccounts: boolean;
  /** Set when the scope is exactly one Twilio account. */
  resourceId?: string;
  /** `subaccount` tag value, in split mode. */
  label?: string;
}

interface ScopeResult {
  rows: CostRow[];
  /** Billed total per day (`totalprice`), for the parent reconciliation. */
  totals: Map<string, number>;
  currency: string;
}

const MAIN_LABEL = "(main account)";
const OTHER_SUBACCOUNTS = "Other subaccounts";

function rangeQuery(range: CostFetchRange, includeSubaccounts: boolean) {
  return {
    StartDate: range.fromDate,
    EndDate: range.toDate,
    IncludeSubaccounts: includeSubaccounts,
  };
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

/** Daily records for one category, keyed by date. */
async function daily(
  ctx: TwilioContext,
  scope: Scope,
  category: string,
  range: CostFetchRange,
): Promise<Map<string, TwUsageRecord>> {
  const records = await list2010<TwUsageRecord>(
    ctx,
    `${accountPath(scope.accountSid)}/Usage/Records/Daily.json`,
    "usage_records",
    { Category: category, ...rangeQuery(range, scope.includeSubaccounts) },
  );
  const out = new Map<string, TwUsageRecord>();
  for (const r of records) {
    const date = r.start_date ?? "";
    if (date < range.fromDate || date > range.toDate) continue;
    out.set(date, r);
  }
  return out;
}

async function collectScope(
  ctx: TwilioContext,
  scope: Scope,
  range: CostFetchRange,
): Promise<ScopeResult> {
  const summary = await list2010<TwUsageRecord>(
    ctx,
    `${accountPath(scope.accountSid)}/Usage/Records.json`,
    "usage_records",
    rangeQuery(range, scope.includeSubaccounts),
  );
  const priced = new Map<string, number>();
  let currency = "USD";
  for (const r of summary) {
    const price = num(r.price);
    if (!r.category || price === undefined || price === 0) continue;
    priced.set(r.category, price);
    if (r.price_unit) currency = r.price_unit.toUpperCase();
  }
  const empty: ScopeResult = { rows: [], totals: new Map(), currency };
  if (!priced.get(TOTAL_CATEGORY)) return empty;

  const leaves = selectLeafCategories(priced);
  const [totalDaily, ...leafDaily] = await mapLimit(
    [TOTAL_CATEGORY, ...leaves],
    CONCURRENCY,
    (category) => daily(ctx, scope, category, range),
  );

  const totals = new Map<string, number>();
  for (const [date, r] of totalDaily ?? new Map<string, TwUsageRecord>()) {
    const price = num(r.price) ?? 0;
    if (price !== 0) totals.set(date, price);
    if (r.price_unit) currency = r.price_unit.toUpperCase();
  }

  // date → leaf rows for that day, before reconciliation.
  const byDate = new Map<
    string,
    Array<{ category: string; record: TwUsageRecord; amount: number }>
  >();
  leaves.forEach((category, i) => {
    for (const [date, record] of leafDaily[i] ?? new Map<string, TwUsageRecord>()) {
      const amount = num(record.price) ?? 0;
      if (amount === 0) continue;
      const list = byDate.get(date) ?? [];
      list.push({ category, record, amount });
      byDate.set(date, list);
    }
  });

  const baseTags = (category: string): Record<string, string> => ({
    category,
    ...(scope.label ? { subaccount: scope.label } : {}),
  });
  const rows: CostRow[] = [];
  const dates = new Set([...byDate.keys(), ...totals.keys()]);
  for (const date of [...dates].sort()) {
    const items = byDate.get(date) ?? [];
    const leafSum = items.reduce((s, x) => s + x.amount, 0);
    const billed = totals.get(date) ?? leafSum;
    const scale = leafSum > billed + EPSILON && leafSum > 0 ? billed / leafSum : 1;
    for (const { category, record, amount } of items) {
      const usage = num(record.usage);
      rows.push({
        date,
        service: productOf(category),
        currency,
        amount: round(amount * scale),
        ...(scope.resourceId ? { resourceId: scope.resourceId } : {}),
        tags: baseTags(category),
        ...(usage !== undefined ? { usageAmount: usage } : {}),
        ...(usage !== undefined && record.usage_unit ? { usageUnit: record.usage_unit } : {}),
      });
    }
    const residual = billed - leafSum;
    if (residual > EPSILON) {
      rows.push({
        date,
        service: "Other",
        currency,
        amount: round(residual),
        ...(scope.resourceId ? { resourceId: scope.resourceId } : {}),
        tags: baseTags("unattributed"),
      });
    }
  }
  return { rows, totals, currency };
}

/** Sum rows that normalise to the same key; the cost store keeps one row per key. */
function aggregate(rows: CostRow[]): CostRow[] {
  const map = new Map<string, CostRow>();
  for (const row of rows) {
    const tags = row.tags
      ? Object.keys(row.tags)
          .sort()
          .map((k) => `${k}=${row.tags?.[k]}`)
          .join("&")
      : "";
    const key = [row.date, row.service, row.resourceId ?? "", row.currency, tags].join("|");
    const existing = map.get(key);
    if (!existing) {
      map.set(key, { ...row });
      continue;
    }
    existing.amount = round(existing.amount + row.amount);
    if (row.usageAmount !== undefined) {
      existing.usageAmount = (existing.usageAmount ?? 0) + row.usageAmount;
    }
  }
  return [...map.values()];
}

/**
 * Daily cost rows for `range`. `subaccounts` is the account's subaccount list
 * (null when it could not be read).
 */
export async function fetchTwilioCostData(
  ctx: TwilioContext,
  range: CostFetchRange,
  subaccounts: SubaccountRef[] | null,
): Promise<CostRow[]> {
  const subs = subaccounts ?? [];
  const split = ctx.authMode === "auth-token" && subs.length > 0;
  if (!split) {
    const whole = await collectScope(
      ctx,
      {
        accountSid: ctx.accountSid,
        includeSubaccounts: true,
        // Exactly the main account only when it has no subaccounts to fold in.
        ...(subs.length === 0 ? { resourceId: ctx.accountSid } : {}),
      },
      range,
    );
    return aggregate(whole.rows);
  }

  const scopes: Scope[] = [
    {
      accountSid: ctx.accountSid,
      includeSubaccounts: false,
      resourceId: ctx.accountSid,
      label: MAIN_LABEL,
    },
    ...subs.slice(0, MAX_SUBACCOUNT_SCOPES).map((s) => ({
      accountSid: s.sid,
      includeSubaccounts: false,
      resourceId: s.sid,
      label: s.name || s.sid,
    })),
  ];
  const results = await mapLimit(scopes, CONCURRENCY, async (scope) => {
    try {
      return await collectScope(ctx, scope, range);
    } catch (err) {
      // A subaccount this credential cannot read is reconciled below as
      // "Other subaccounts" rather than failing the whole pass. The main
      // account failing is a real failure.
      if (scope.accountSid !== ctx.accountSid && isAccessDenied(err)) return null;
      throw err;
    }
  });

  const rows = results.flatMap((r) => r?.rows ?? []);
  const currency = results.find((r) => r && r.rows.length > 0)?.currency ?? "USD";
  const parent = await daily(
    ctx,
    { accountSid: ctx.accountSid, includeSubaccounts: true },
    TOTAL_CATEGORY,
    range,
  );
  for (const [date, record] of parent) {
    const billed = num(record.price) ?? 0;
    const collected = results.reduce((s, r) => s + (r?.totals.get(date) ?? 0), 0);
    const residual = billed - collected;
    if (residual > EPSILON) {
      rows.push({
        date,
        service: "Other",
        currency: record.price_unit ? record.price_unit.toUpperCase() : currency,
        amount: round(residual),
        tags: { category: "unattributed", subaccount: OTHER_SUBACCOUNTS },
      });
    }
  }
  return aggregate(rows);
}

/** One category's totals over a period, for the account detail's spend table. */
export interface CategorySpend {
  category: string;
  description: string;
  product: string;
  price: number;
  usage?: number;
  usageUnit?: string;
  count?: number;
  countUnit?: string;
}

export interface PeriodSpend {
  total: number;
  currency: string;
  categories: CategorySpend[];
  products: Array<{ product: string; price: number }>;
}

/**
 * This month's (or last month's) spend, de-duplicated the same way as the
 * cost rows: `ThisMonth.json` / `LastMonth.json` return one record per
 * category for the calendar month.
 */
export async function fetchPeriodSpend(
  ctx: TwilioContext,
  accountSid: string,
  period: "ThisMonth" | "LastMonth",
  includeSubaccounts: boolean,
): Promise<PeriodSpend> {
  const records = await list2010<TwUsageRecord>(
    ctx,
    `${accountPath(accountSid)}/Usage/Records/${period}.json`,
    "usage_records",
    { IncludeSubaccounts: includeSubaccounts },
  );
  const priced = new Map<string, number>();
  const byCategory = new Map<string, TwUsageRecord>();
  let currency = "USD";
  for (const r of records) {
    const price = num(r.price);
    if (!r.category) continue;
    byCategory.set(r.category, r);
    if (price !== undefined && price !== 0) priced.set(r.category, price);
    if (r.price_unit) currency = r.price_unit.toUpperCase();
  }
  const total = priced.get(TOTAL_CATEGORY) ?? 0;
  const categories = selectLeafCategories(priced)
    .map<CategorySpend>((category) => {
      const r = byCategory.get(category) ?? {};
      const usage = num(r.usage);
      const count = num(r.count);
      return {
        category,
        description: r.description ?? category,
        product: productOf(category),
        price: priced.get(category) ?? 0,
        ...(usage !== undefined ? { usage } : {}),
        ...(r.usage_unit ? { usageUnit: r.usage_unit } : {}),
        ...(count !== undefined ? { count } : {}),
        ...(r.count_unit ? { countUnit: r.count_unit } : {}),
      };
    })
    .sort((a, b) => b.price - a.price);
  const products = new Map<string, number>();
  for (const c of categories) products.set(c.product, (products.get(c.product) ?? 0) + c.price);
  return {
    total,
    currency,
    categories,
    products: [...products.entries()]
      .map(([product, price]) => ({ product, price: round(price) }))
      .sort((a, b) => b.price - a.price),
  };
}
