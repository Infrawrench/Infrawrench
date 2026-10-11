import type { HttpHostServices } from "@infrawrench/plugin-base";

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
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : 0;
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

export type FormValue =
  string | number | boolean | null | undefined | FormValue[] | { [key: string]: FormValue };

/**
 * Stripe's v1 form encoding: nested objects as `a[b]`, arrays indexed as
 * `a[0]`. `undefined` is skipped; `""` is sent, which is how v1 unsets a
 * field (for instance `description=`).
 */
export function encodeForm(body: Record<string, FormValue>): string {
  const params = new URLSearchParams();
  const walk = (prefix: string, value: FormValue) => {
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

export type Query = Record<string, string | number | boolean | undefined | Array<string | number>>;

export function buildQuery(query: Query = {}): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === "") continue;
    if (Array.isArray(v)) v.forEach((item, i) => params.append(`${k}[${i}]`, String(item)));
    else params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

interface StripeErrorBody {
  error?: { message?: string; type?: string; code?: string; param?: string };
}

function parseError(text: string): { message: string; type: string; code: string } {
  try {
    const parsed = JSON.parse(text) as StripeErrorBody;
    const e = parsed.error;
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

export interface RequestOptions {
  method?: string;
  query?: Query;
  /** v1: form-encoded. Ignored on GET. */
  form?: Record<string, FormValue>;
  /** v2: JSON body. */
  json?: unknown;
}

/**
 * One request. Routed through the host HTTP service whenever there is one:
 * that is the only path that honours bastion egress and a custom CA.
 */
export async function stripeFetch<T>(
  ctx: StripeContext,
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const url = path.startsWith("http") ? path : `${API_BASE}${path}${buildQuery(opts.query)}`;
  const method = opts.method ?? "GET";
  const headers: Record<string, string> = {
    Authorization: `Bearer ${ctx.apiKey}`,
    Accept: "application/json",
    "Stripe-Version": STRIPE_API_VERSION,
  };
  let body: string | undefined;
  if (opts.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.json);
  } else if (opts.form !== undefined && method !== "GET") {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = encodeForm(opts.form);
  }

  let status: number;
  let text: string;
  if (ctx.http) {
    const res = await ctx.http.request({
      url,
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
    });
    status = res.status;
    text = res.body;
  } else {
    const res = await fetch(url, { method, headers, ...(body !== undefined ? { body } : {}) });
    status = res.status;
    text = await res.text();
  }
  if (status < 200 || status >= 300) {
    const { message, type, code } = parseError(text);
    const label = path.startsWith("http") ? new URL(path).pathname : path;
    throw new StripeApiError(
      status,
      `Stripe API error ${status} for ${label}: ${message}`,
      type,
      code,
    );
  }
  return (status === 204 || !text ? undefined : JSON.parse(text)) as T;
}

interface V1List<T> {
  data?: T[];
  has_more?: boolean;
}

/**
 * Every page of a v1 list, up to `maxPages` × 100 objects, so a huge account
 * cannot turn one listing into thousands of requests.
 */
export async function listV1<T extends { id?: string }>(
  ctx: StripeContext,
  path: string,
  query: Query = {},
  maxPages = 10,
): Promise<T[]> {
  const out: T[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const res = await stripeFetch<V1List<T>>(ctx, path, {
      query: { limit: 100, ...query, ...(startingAfter ? { starting_after: startingAfter } : {}) },
    });
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

/** Every page of a v2 list by following `next_page_url`, up to `maxPages`. */
export async function listV2<T>(
  ctx: StripeContext,
  path: string,
  query: Query = {},
  maxPages = 10,
): Promise<T[]> {
  const out: T[] = [];
  let next: string | null | undefined = `${path}${buildQuery({ limit: 100, ...query })}`;
  for (let page = 0; page < maxPages && next; page++) {
    const url: string = next.startsWith("http") ? next : `${API_BASE}${next}`;
    const res: V2List<T> = await stripeFetch<V2List<T>>(ctx, url);
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
