import type { CostFetchRange, CostRow, HttpHostServices } from "@infrawrench/plugin-base";
import {
  CostSetupError,
  jsonRestFetch,
  ListTruncatedError,
  requireListPage,
} from "@infrawrench/plugin-base";
import { DynatraceApiError, statusOf, withQuery } from "./api.js";

/**
 * Dynatrace Platform Subscription (DPS) cost, from the Account Management API.
 *
 * - Auth is an OAuth client (client credentials) minted under Account
 *   Management, Identity & access management, OAuth clients, with the
 *   `account-uac-read` scope. The token comes from
 *   `https://sso.dynatrace.com/sso/oauth2/token` with
 *   `resource=urn:dtaccount:<account uuid>` and lives five minutes.
 * - `GET /sub/v2/accounts/{account}/subscriptions` lists subscriptions,
 *   `GET /sub/v3/accounts/{account}/subscriptions/{uuid}/environments/cost?startTime&endTime&environmentIds`
 *   returns one record per day and capability, per environment, with
 *   `currencyCode`. Only this account's environment is requested: one OAuth
 *   client usually covers every environment of the Dynatrace account, and
 *   reading them all from each connected environment would double count.
 */

export const SSO_TOKEN_URL = "https://sso.dynatrace.com/sso/oauth2/token";
export const ACCOUNT_API_URL = "https://api.dynatrace.com";
/** Per chunk of days. The API documents no page size, so this leaves room for a small one. */
const COST_MAX_PAGES = 1000;

interface CostRoute {
  version: "v2" | "v3";
  laterPage(key: string, query: Record<string, string>): Record<string, string>;
}

/** Only the timeframe may go once a `page-key` is sent. `environmentIds` has no such exception. */
const COST_ROUTE: CostRoute = {
  version: "v3",
  laterPage: (key, { environmentIds }) => ({
    "page-key": key,
    ...(environmentIds ? { environmentIds } : {}),
  }),
};

/** No longer documented, and kept for an account whose v3 route refuses the first page. */
const OLD_COST_ROUTE: CostRoute = {
  version: "v2",
  laterPage: (key) => ({ nextPageKey: key }),
};

/** A route refusal, where v2 may still answer. A 401, throttle or 5xx would say the same on both. */
const COST_ROUTE_REFUSALS = new Set([400, 403, 404, 405, 410]);

export interface DpsCredentials {
  accountUuid: string;
  clientId: string;
  clientSecret: string;
  environmentId: string;
  http?: HttpHostServices;
}

interface DpsSubscription {
  uuid?: string;
  name?: string;
  status?: string;
  startTime?: string;
  endTime?: string;
}

interface DpsCostRecord {
  startTime?: string;
  endTime?: string;
  value?: number;
  currencyCode?: string;
  capabilityKey?: string;
  capabilityName?: string;
  bookingDate?: string;
}

interface DpsEnvCost {
  environmentId?: string;
  cost?: DpsCostRecord[];
}

interface DpsEnvCostResponse {
  data?: DpsEnvCost[];
  nextPageKey?: string;
}

const HELP = {
  label: "Create an OAuth client",
  url: "https://docs.dynatrace.com/docs/manage/identity-access-management/access-tokens-and-oauth-clients/oauth-clients",
};

export function hasDpsCredentials(c: Partial<DpsCredentials>): boolean {
  return Boolean(c.accountUuid && c.clientId && c.clientSecret);
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export function resetDpsTokenCacheForTests(): void {
  tokenCache.clear();
}

async function accountToken(c: DpsCredentials): Promise<string> {
  const key = `${c.clientId}|${c.accountUuid}`;
  const hit = tokenCache.get(key);
  if (hit && hit.expiresAt > Date.now() + 20_000) return hit.token;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: c.clientId,
    client_secret: c.clientSecret,
    scope: "account-uac-read",
    resource: `urn:dtaccount:${c.accountUuid}`,
  }).toString();
  let res: { access_token?: string; expires_in?: number };
  try {
    res = await jsonRestFetch<{ access_token?: string; expires_in?: number }>({
      vendor: "Dynatrace SSO",
      url: SSO_TOKEN_URL,
      errorPath: "/sso/oauth2/token",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      init: { method: "POST", body },
      ...(c.http ? { http: c.http } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = Number(/API error (\d{3})/.exec(message)?.[1] ?? 0);
    if (status === 400 || status === 401 || status === 403) {
      throw new CostSetupError(
        "Dynatrace rejected the OAuth client. Check the client id, secret and account UUID, and that the client has the account-uac-read (View usage and consumption) permission.",
        HELP,
      );
    }
    throw err;
  }
  if (!res?.access_token) throw new Error("Dynatrace SSO returned no access token.");
  tokenCache.set(key, {
    token: res.access_token,
    expiresAt: Date.now() + (res.expires_in ?? 300) * 1000,
  });
  return res.access_token;
}

async function accountFetch<T>(c: DpsCredentials, path: string, query?: Record<string, string>) {
  const token = await accountToken(c);
  try {
    return await jsonRestFetch<T>({
      vendor: "Dynatrace Account",
      url: withQuery(`${ACCOUNT_API_URL}${path}`, query),
      errorPath: path,
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      ...(c.http ? { http: c.http } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = Number(/API error (\d{3})/.exec(message)?.[1] ?? 0);
    if (status) throw new DynatraceApiError(status, message);
    throw err;
  }
}

export function listSubscriptions(c: DpsCredentials): Promise<DpsSubscription[]> {
  const path = `/sub/v2/accounts/${encodeURIComponent(c.accountUuid)}/subscriptions`;
  return accountFetch<{ data?: DpsSubscription[] }>(c, path).then((r) =>
    requireListPage(r?.data, { vendor: "Dynatrace Account", path, key: "data" }),
  );
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Split an inclusive day range into chunks of at most `size` days. */
export function chunkRange(from: string, to: string, size = 31): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let start = from;
  while (start <= to) {
    const end = addDays(start, size - 1) < to ? addDays(start, size - 1) : to;
    out.push([start, end]);
    start = addDays(end, 1);
  }
  return out;
}

function overlaps(s: DpsSubscription, from: string, to: string): boolean {
  const start = (s.startTime ?? "").slice(0, 10) || "0000-01-01";
  const end = (s.endTime ?? "").slice(0, 10) || "9999-12-31";
  return start <= to && end >= from;
}

function costPath(c: DpsCredentials, subscription: string, route: CostRoute): string {
  return `/sub/${route.version}/accounts/${encodeURIComponent(c.accountUuid)}/subscriptions/${encodeURIComponent(subscription)}/environments/cost`;
}

/** The first page, from the documented route or, if it refuses, the older one. */
async function firstCostPage(
  c: DpsCredentials,
  subscription: string,
  route: CostRoute,
  query: Record<string, string>,
): Promise<{ route: CostRoute; res: DpsEnvCostResponse }> {
  try {
    const res = await accountFetch<DpsEnvCostResponse>(c, costPath(c, subscription, route), query);
    return { route, res };
  } catch (err) {
    if (route === OLD_COST_ROUTE || !COST_ROUTE_REFUSALS.has(statusOf(err))) throw err;
    const path = costPath(c, subscription, OLD_COST_ROUTE);
    const res = await accountFetch<DpsEnvCostResponse>(c, path, query);
    return { route: OLD_COST_ROUTE, res };
  }
}

/**
 * Every page of one chunk of days, and the route that answered. Throws past the cap:
 * a cost read is reconciled like a sync.
 */
async function readCostPages(
  c: DpsCredentials,
  subscription: string,
  preferred: CostRoute,
  query: Record<string, string>,
): Promise<{ route: CostRoute; envs: DpsEnvCost[] }> {
  const first = await firstCostPage(c, subscription, preferred, query);
  const { route } = first;
  const path = costPath(c, subscription, route);
  const envs: DpsEnvCost[] = [];
  let res = first.res;
  for (let page = 1; ; page++) {
    envs.push(...requireListPage(res?.data, { vendor: "Dynatrace Account", path, key: "data" }));
    const next = res?.nextPageKey;
    if (!next) return { route, envs };
    if (page >= COST_MAX_PAGES) {
      throw new ListTruncatedError({
        vendor: "Dynatrace Account",
        path,
        items: envs.length,
        maxPages: COST_MAX_PAGES,
      });
    }
    res = await accountFetch<DpsEnvCostResponse>(c, path, route.laterPage(next, query));
  }
}

export async function fetchDpsCostData(
  c: DpsCredentials,
  range: CostFetchRange,
): Promise<CostRow[]> {
  if (!hasDpsCredentials(c)) {
    throw new CostSetupError(
      "Cost data needs a Dynatrace OAuth client. Edit the account's credentials and fill in the account UUID, client id and client secret (account-uac-read).",
      HELP,
    );
  }
  let subs: DpsSubscription[];
  try {
    subs = await listSubscriptions(c);
  } catch (err) {
    if (statusOf(err) === 401 || statusOf(err) === 403) {
      throw new CostSetupError(
        "The OAuth client cannot read subscriptions. Give it the account-uac-read (View usage and consumption) permission.",
        HELP,
      );
    }
    throw err;
  }
  const merged = new Map<string, CostRow>();
  let route = COST_ROUTE;
  for (const sub of subs.filter((s) => s.uuid && overlaps(s, range.fromDate, range.toDate))) {
    for (const [from, to] of chunkRange(range.fromDate, range.toDate)) {
      const read = await readCostPages(c, sub.uuid ?? "", route, {
        startTime: `${from}T00:00:00Z`,
        endTime: `${addDays(to, 1)}T00:00:00Z`,
        ...(c.environmentId ? { environmentIds: c.environmentId } : {}),
      });
      route = read.route;
      for (const env of read.envs) {
        if (c.environmentId && env.environmentId && env.environmentId !== c.environmentId) {
          continue;
        }
        for (const rec of env.cost ?? []) {
          const date = (rec.startTime ?? "").slice(0, 10);
          if (!date || date < range.fromDate || date > range.toDate) continue;
          const value = typeof rec.value === "number" ? rec.value : Number(rec.value);
          if (!Number.isFinite(value)) continue;
          const service = rec.capabilityName || rec.capabilityKey || "Dynatrace";
          const currency = rec.currencyCode || "USD";
          const key = `${date}|${service}|${currency}|${sub.uuid}`;
          const prev = merged.get(key);
          if (prev) prev.amount += value;
          else
            merged.set(key, {
              date,
              service,
              currency,
              amount: value,
              tags: { subscription: sub.name || sub.uuid || "" },
            });
        }
      }
    }
  }
  return Array.from(merged.values());
}

/** Month-to-date cost of this environment, for the environment's detail view. */
export async function monthToDate(c: DpsCredentials): Promise<{
  total: number;
  currency: string;
  byCapability: Array<{ name: string; amount: number }>;
}> {
  const today = new Date().toISOString().slice(0, 10);
  const rows = await fetchDpsCostData(c, { fromDate: `${today.slice(0, 8)}01`, toDate: today });
  const by = new Map<string, number>();
  let total = 0;
  for (const r of rows) {
    total += r.amount;
    by.set(r.service ?? "Dynatrace", (by.get(r.service ?? "Dynatrace") ?? 0) + r.amount);
  }
  return {
    total,
    currency: rows[0]?.currency ?? "USD",
    byCapability: Array.from(by.entries())
      .map(([name, amount]) => ({ name, amount }))
      .sort((a, b) => b.amount - a.amount),
  };
}
