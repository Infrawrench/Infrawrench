/**
 * Extended-support findings with the billed overlay: server-core's list-price
 * computation (`extended-support/feed.ts`), then, for every account holding a
 * billable finding whose plugin implements `fetchExtendedSupportCharges`,
 * what the provider actually charged over the trailing window, attributed by
 * `applyExtendedSupportBilling` (client-core, pure and tested).
 *
 * The billing half is credentialed and some providers bill per request (AWS
 * Cost Explorer is $0.01 a call), so the whole response is cached in memory
 * per org for a few minutes with in-flight dedupe, the rightsizing shape. One
 * account's failing read costs only that account's billed figures (its
 * findings keep list price and the response names the failure); it never
 * fails the list.
 */
import {
  applyExtendedSupportBilling,
  type ExtendedSupportAccountBilling,
  type ExtendedSupportListResponse,
  summarizeExtendedSupport,
} from "@infrawrench/client-core";
import { listExtendedSupport } from "@infrawrench/server-core/extended-support/feed";
import { filterToVisibleAccounts } from "./cost-visibility-filter";
import { getClientForAccount } from "./plugin-clients";

const CACHE_TTL_MS = 10 * 60 * 1000;
/** Trailing days of billing read. Billing lags, so the window ends yesterday. */
export const EXTENDED_SUPPORT_BILLING_WINDOW_DAYS = 30;

interface CacheEntry {
  expiresAt: number;
  promise: Promise<ExtendedSupportListResponse>;
}

const cache = new Map<string, CacheEntry>();

export async function listExtendedSupportWithBilling(
  organizationId: string,
  opts: { refresh?: boolean } = {},
): Promise<ExtendedSupportListResponse> {
  const feed = await orgExtendedSupport(organizationId, opts);
  // The cache is org-wide; a cost-scoped caller sees only findings (and so
  // billed surcharges) on accounts its scope grants in full.
  const visible = filterToVisibleAccounts(organizationId, feed.findings, (f) => f.accountId);
  if (visible.length === feed.findings.length) return feed;
  return summarizeExtendedSupport(visible, {
    leadDays: feed.leadDays,
    generatedAt: feed.generatedAt,
    ...(feed.billing ? { billing: feed.billing } : {}),
  });
}

async function orgExtendedSupport(
  organizationId: string,
  { refresh = false }: { refresh?: boolean },
): Promise<ExtendedSupportListResponse> {
  const cached = cache.get(organizationId);
  if (cached && !refresh && cached.expiresAt > Date.now()) return cached.promise;
  const promise = compute(organizationId);
  const entry: CacheEntry = { expiresAt: Date.now() + CACHE_TTL_MS, promise };
  cache.set(organizationId, entry);
  promise.catch(() => {
    if (cache.get(organizationId) === entry) cache.delete(organizationId);
  });
  return promise;
}

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

async function compute(organizationId: string): Promise<ExtendedSupportListResponse> {
  const feed = await listExtendedSupport(organizationId);
  const billable = new Map<string, string>();
  for (const f of feed.findings) {
    if (f.charged && (f.status === "surcharged" || f.status === "end-of-life"))
      billable.set(f.accountId, f.accountName);
  }
  if (billable.size === 0) return feed;

  const now = Date.now();
  const range = {
    start: day(now - (EXTENDED_SUPPORT_BILLING_WINDOW_DAYS + 1) * 86_400_000),
    end: day(now - 86_400_000),
  };
  const billing = (
    await Promise.all(
      [...billable].map(
        async ([accountId, accountName]): Promise<ExtendedSupportAccountBilling | null> => {
          try {
            const ctx = await getClientForAccount(accountId, organizationId);
            if (!ctx?.client.fetchExtendedSupportCharges) return null;
            const charges = await ctx.client.fetchExtendedSupportCharges(accountId, range);
            return { accountId, accountName, charges };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(
              `[extended-support] billing read failed for account ${accountId}:`,
              message,
            );
            return { accountId, accountName, charges: null, error: message };
          }
        },
      ),
    )
  ).filter((b): b is ExtendedSupportAccountBilling => b !== null);

  if (billing.length === 0) return feed;
  return applyExtendedSupportBilling(feed, billing, EXTENDED_SUPPORT_BILLING_WINDOW_DAYS);
}
