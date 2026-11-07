import {
  createApiClient,
  restRequest,
  type ApiClient,
  type HttpHostServices,
  type ParamValue,
} from "@infrawrench/plugin-base";
import type { paths } from "./api-types.gen.js";

/**
 * Stripe REST API (https://docs.stripe.com/api, OpenAPI spec at
 * https://github.com/stripe/openapi, verified 2026-10).
 *
 * - One host, `api.stripe.com`, for both API generations. The key goes in a
 *   Bearer header; secret (`sk_`) and restricted (`rk_`) keys both work.
 * - v1 takes `application/x-www-form-urlencoded` bodies with bracketed nesting
 *   (`recurring[interval]=month`, `enabled_events[0]=*`) and pages with
 *   `has_more` + `starting_after=<last id>`.
 * - v2 takes JSON bodies and pages with an opaque `next_page_url`.
 * - Every request pins `Stripe-Version` so response shapes cannot drift with
 *   the account's default version. v2 rejects a request without one.
 */
export const API_BASE = "https://api.stripe.com";

/** The API version every request is pinned to (latest GA on 2026-10-06). */
export const STRIPE_API_VERSION = "2026-09-30.endive";

export const DASHBOARD_BASE = "https://dashboard.stripe.com";

export interface StripeContext {
  apiKey: string;
  http?: HttpHostServices;
  caCert?: string;
}

/** Thrown for any non-2xx answer, carrying the status the poller classifies on. */
export class StripeApiError extends Error {
  readonly status: number;
  /** Stripe's `error.type` (`invalid_request_error`, `api_error`, …). */
  readonly type: string;
  /** Stripe's `error.code`, when it sent one (`resource_missing`, …). */
  readonly code: string;
  constructor(status: number, message: string, type = "", code = "") {
    super(message);
    this.name = "StripeApiError";
    this.status = status;
    this.type = type;
    this.code = code;
  }
}

export function statusOf(err: unknown): number {
  if (err instanceof StripeApiError) return err.status;
  if (typeof err !== "object" || err === null || !("status" in err)) return 0;
  return typeof err.status === "number" ? err.status : 0;
}

/** 401/403: the key is wrong, or a restricted key lacks the permission. */
export function isPermissionError(err: unknown): boolean {
  const status = statusOf(err);
  return status === 401 || status === 403;
}

/**
 * True when the account simply does not have the feature: a non-platform
 * listing connected accounts, an account without Sigma, a 404 on a product
 * area the account never enabled. Listers treat these as "nothing here".
 */
export function isFeatureUnavailable(err: unknown): boolean {
  const status = statusOf(err);
  if (status === 403 || status === 404) return true;
  if (status === 400 && err instanceof StripeApiError) {
    return /platform|connect|not enabled|not available|sigma|signed up/i.test(err.message);
  }
  return false;
}

/**
 * Stripe's v1 form encoding: nested objects as `a[b]`, arrays indexed as
 * `a[0]`. `undefined` is skipped; `""` is sent, which is how v1 unsets a
 * field (for instance `description=`).
 */
export function encodeForm(body: Record<string, ParamValue>): string {
  const params = new URLSearchParams();
  const walk = (prefix: string, value: ParamValue) => {
    if (value === undefined) return;
    if (value === null) {
      params.append(prefix, "");
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(`${prefix}[${i}]`, item));
      return;
    }
    if (typeof value === "object") {
      for (const [k, v] of Object.entries(value)) walk(`${prefix}[${k}]`, v);
      return;
    }
    params.append(prefix, String(value));
  };
  for (const [k, v] of Object.entries(body)) walk(k, v);
  return params.toString();
}

/**
 * Stripe's query dialect, without the leading `?`: nested objects as `a[b]`,
 * arrays indexed as `a[0]`, and `undefined`, `null` and `""` left out.
 */
export function buildQuery(query: Record<string, ParamValue> = {}): string {
  const params = new URLSearchParams();
  const walk = (prefix: string, value: ParamValue) => {
    if (value === undefined || value === null || value === "") return;
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(`${prefix}[${i}]`, item));
      return;
    }
    if (typeof value === "object") {
      for (const [k, v] of Object.entries(value)) walk(`${prefix}[${k}]`, v);
      return;
    }
    params.set(prefix, String(value));
  };
  for (const [k, v] of Object.entries(query)) walk(k, v);
  return params.toString();
}

interface StripeErrorBody {
  error?: { message?: string; type?: string; code?: string; param?: string };
}

function parseError(text: string): { message: string; type: string; code: string } {
  try {
    const parsed: StripeErrorBody | null = JSON.parse(text);
    const e = parsed?.error;
    if (e && typeof e.message === "string") {
      return {
        message: e.param ? `${e.message} (${e.param})` : e.message,
        type: e.type ?? "",
        code: e.code ?? "",
      };
    }
  } catch {
    // Not JSON: fall through to the raw body.
  }
  return { message: text.slice(0, 500), type: "", code: "" };
}

function stripeError(status: number, path: string, body: string): StripeApiError {
  const { message, type, code } = parseError(body);
  return new StripeApiError(
    status,
    `Stripe API error ${status} for ${path}: ${message}`,
    type,
    code,
  );
}

function stripeHeaders(ctx: StripeContext): Record<string, string> {
  return {
    Authorization: `Bearer ${ctx.apiKey}`,
    Accept: "application/json",
    "Stripe-Version": STRIPE_API_VERSION,
  };
}

export type StripeApi = ApiClient<paths>;

/**
 * Both API generations, from one document: it says form for v1 bodies and JSON
 * for v2 ones. Routed through the host HTTP service whenever there is one: that
 * is the only path that honours bastion egress and a custom CA.
 */
export function stripeApi(ctx: StripeContext): StripeApi {
  return createApiClient<paths>({
    vendor: "Stripe",
    baseUrl: API_BASE,
    headers: stripeHeaders(ctx),
    http: ctx.http,
    caCert: ctx.caCert,
    contentType: "with-body",
    emptyBodyIsUndefined: true,
    serializeQuery: buildQuery,
    serializeForm: encodeForm,
    httpError: ({ status, path, body }) => stripeError(status, path, body),
  });
}

interface V1List<T> {
  data?: T[];
  has_more?: boolean;
}

/**
 * Every page of a v1 list, up to `maxPages` × 100 objects, so a huge account
 * cannot turn one listing into thousands of requests. `fetchPage` makes the
 * request, spreading `paging` last in its query.
 *
 * A loop rather than `withCursorPagination`, for two things that helper does
 * differently. This has always sent `limit`, the caller's query, then
 * `starting_after`, and the helper puts the query at one end. And it reads a
 * `data` that is not an array as the end of the list, where this throws, so a
 * sync fails rather than prunes everything it stopped seeing.
 */
export async function listV1<T extends { id?: string }>(
  fetchPage: (paging: { starting_after?: string }) => Promise<V1List<T> | undefined>,
  maxPages = 10,
): Promise<T[]> {
  const out: T[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const res = await fetchPage(startingAfter ? { starting_after: startingAfter } : {});
    const data = res?.data ?? [];
    out.push(...data);
    const last = data[data.length - 1]?.id;
    if (!res?.has_more || !last) break;
    startingAfter = last;
  }
  return out;
}

interface V2List<T> {
  data?: T[];
  next_page_url?: string | null;
}

/**
 * Every page of a v2 list by following `next_page_url`, up to `maxPages`.
 * `firstPage` makes the first request; each one after is the link as written,
 * prefixed with the host unless it starts with `http`, wherever that leads.
 * A link is no route of the document, hence `restRequest` for those.
 */
export async function listV2<T>(
  ctx: StripeContext,
  firstPage: () => Promise<V2List<T> | undefined>,
  maxPages = 10,
): Promise<T[]> {
  const first = await firstPage();
  const out: T[] = [];
  out.push(...(first?.data ?? []));
  let next = first?.next_page_url ?? null;
  for (let page = 1; page < maxPages && next; page++) {
    const url: string = next.startsWith("http") ? next : `${API_BASE}${next}`;
    const { body: res } = await restRequest<V2List<T> | undefined>({
      vendor: "Stripe",
      url,
      headers: stripeHeaders(ctx),
      init: { method: "GET" },
      ...(ctx.http ? { http: ctx.http } : {}),
      ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
      contentType: "with-body",
      emptyBodyIsUndefined: true,
      httpError: ({ status, body }) => stripeError(status, new URL(url).pathname, body),
    });
    out.push(...(res?.data ?? []));
    next = res?.next_page_url ?? null;
  }
  return out;
}

/** `sk_live_…` / `rk_live_…` → live; anything else (test, sandbox) → test. */
export function keyMode(apiKey: string): "live" | "test" {
  return /^(sk|rk)_live_/.test(apiKey) ? "live" : "test";
}

/** Dashboard deep link, honouring test mode (`/test/` prefix). */
export function dashboardUrl(apiKey: string, path: string): string {
  const clean = path.startsWith("/") ? path : `/${path}`;
  return keyMode(apiKey) === "live"
    ? `${DASHBOARD_BASE}${clean}`
    : `${DASHBOARD_BASE}/test${clean}`;
}

/**
 * Currencies Stripe expresses in whole units (no minor unit) and the five it
 * expresses in thousandths, from https://docs.stripe.com/currencies
 * (verified 2026-10). Everything else is hundredths.
 */
const ZERO_DECIMAL = new Set([
  "bif",
  "clp",
  "djf",
  "gnf",
  "jpy",
  "kmf",
  "krw",
  "mga",
  "pyg",
  "rwf",
  "ugx",
  "vnd",
  "vuv",
  "xaf",
  "xof",
  "xpf",
]);
const THREE_DECIMAL = new Set(["bhd", "jod", "kwd", "omr", "tnd"]);

export function currencyExponent(currency: string): number {
  const c = currency.toLowerCase();
  if (ZERO_DECIMAL.has(c)) return 0;
  if (THREE_DECIMAL.has(c)) return 3;
  return 2;
}

/** Minor units → major units (`1999`, `usd` → `19.99`). */
export function fromMinor(amount: number, currency: string): number {
  return amount / Math.pow(10, currencyExponent(currency));
}

/** Major units typed by a user → minor units Stripe expects (`19.99` → `1999`). */
export function toMinor(amount: number, currency: string): number {
  return Math.round(amount * Math.pow(10, currencyExponent(currency)));
}

export function formatMoney(amountMinor: number, currency: string): string {
  const exp = currencyExponent(currency);
  const value = fromMinor(amountMinor, currency);
  return `${value.toFixed(exp)} ${currency.toUpperCase()}`;
}
