import {
  createApiClient,
  withCursorPagination,
  withLinkPagination,
  type CursorApiClient,
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

/** The most `limit` takes on a v1 list; v2 documents no maximum and keeps this size. */
const PAGE_SIZE = 100;

/**
 * 50,000 rows, and past that a list throws rather than let a sync prune the rest.
 * A read where part of a list is fine asks for less with `partial: true`.
 */
const MAX_LIST_PAGES = 500;

export type StripeApi = CursorApiClient<
  paths,
  {
    cursorParam: "starting_after";
    sizeParam: "limit";
    next: { readonly lastItem: "id" };
    hasMore: "has_more";
  }
> & {
  getAllV2: CursorApiClient<
    paths,
    { cursorParam: never; sizeParam: "limit"; next: "next_page_url"; hasMore: never }
  >["getAll"];
};

/**
 * Both API generations, from one document: it says form for v1 bodies and JSON
 * for v2 ones. Routed through the host HTTP service whenever there is one: that
 * is the only path that honours bastion egress and a custom CA.
 *
 * `getAll` walks a v1 list by `has_more` and the last row's id, `getAllV2` a v2 list
 * by `next_page_url`.
 */
export function stripeApi(ctx: StripeContext): StripeApi {
  const api = createApiClient<paths>({
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
  const v1 = withCursorPagination(api, {
    cursorParam: "starting_after",
    sizeParam: "limit",
    pageSize: PAGE_SIZE,
    next: { lastItem: "id" },
    hasMore: "has_more",
    maxPages: MAX_LIST_PAGES,
  });
  const v2 = withLinkPagination(api, {
    sizeParam: "limit",
    pageSize: PAGE_SIZE,
    next: "next_page_url",
    maxPages: MAX_LIST_PAGES,
    // Stripe's API v2 overview: `next_page_url` is null when there are no more pages,
    // so only that ends a list, not an empty page.
    continueOnEmptyPage: true,
  });
  return { ...v1, getAllV2: v2.getAll };
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
