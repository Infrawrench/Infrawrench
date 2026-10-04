/**
 * Twilio REST transport.
 *
 * Twilio is several hosts behind one credential: the classic 2010-04-01 API
 * (`api.twilio.com`, accounts, numbers, usage, balance, triggers, TwiML apps,
 * keys), and the newer per-product APIs (`messaging.twilio.com/v1`,
 * `verify.twilio.com/v2`, `pricing.twilio.com/v1`). Everything authenticates
 * with HTTP Basic: either `API key SID : API key secret` or
 * `Account SID : Auth Token`. Writes are form-encoded, never JSON.
 *
 * Verified against Twilio's published OpenAPI documents
 * (`twilio/twilio-oai`, `spec/json/twilio_{api_v2010,messaging_v1,verify_v2,pricing_v1}.json`,
 * 2026-10).
 */
import type { HttpHostServices } from "@infrawrench/plugin-base";

export const API_HOST = "https://api.twilio.com";
export const MESSAGING_HOST = "https://messaging.twilio.com";
export const VERIFY_HOST = "https://verify.twilio.com";
export const PRICING_HOST = "https://pricing.twilio.com";

/** Every host the plugin calls, for the bastion egress allowlist. */
export const TWILIO_HOSTNAMES = [
  "api.twilio.com",
  "messaging.twilio.com",
  "verify.twilio.com",
  "pricing.twilio.com",
];

export type TwilioAuthMode = "api-key" | "auth-token";

export interface TwilioContext {
  /** The main account (`AC…`) every 2010 path is scoped under. */
  accountSid: string;
  /** Basic-auth username: an API key SID (`SK…`) or the account SID. */
  username: string;
  /** Basic-auth password: the API key secret or the auth token. */
  password: string;
  authMode: TwilioAuthMode;
  caCert?: string;
  http?: HttpHostServices;
}

/** A Twilio error, carrying the HTTP status and Twilio's own error code. */
export class TwilioApiError extends Error {
  readonly status: number;
  readonly code: number | undefined;

  constructor(status: number, message: string, code?: number) {
    super(message);
    this.name = "TwilioApiError";
    this.status = status;
    this.code = code;
  }
}

export function statusOf(err: unknown): number | undefined {
  return err instanceof TwilioApiError ? err.status : undefined;
}

/** 401/403: the credential cannot see this (wrong key type, or a subaccount the key can't reach). */
export function isAccessDenied(err: unknown): boolean {
  const s = statusOf(err);
  return s === 401 || s === 403;
}

export type FormValue = string | number | boolean | undefined;

export interface TwilioRequest {
  method?: "GET" | "POST" | "DELETE";
  query?: Record<string, FormValue>;
  form?: Record<string, FormValue>;
}

function encode(params: Record<string, FormValue> | undefined): string {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v === undefined) continue;
    out.append(k, String(v));
  }
  return out.toString();
}

function basicAuth(ctx: TwilioContext): string {
  const raw = `${ctx.username}:${ctx.password}`;
  return `Basic ${btoa(raw)}`;
}

function describeError(status: number, body: string, path: string): TwilioApiError {
  let message = body;
  let code: number | undefined;
  try {
    const parsed = JSON.parse(body) as { message?: string; code?: number };
    if (parsed.message) message = parsed.message;
    if (typeof parsed.code === "number") code = parsed.code;
  } catch {
    // Non-JSON body: keep the raw text.
  }
  const hint =
    status === 401
      ? " Check the Account SID and the API key or auth token."
      : status === 403
        ? " The credential is not allowed to read this; a Standard API key cannot reach accounts, keys or subaccounts."
        : "";
  return new TwilioApiError(
    status,
    `Twilio API error ${status} for ${path}: ${message || "(empty)"}${code ? ` (code ${code})` : ""}.${hint}`,
    code,
  );
}

/**
 * One request. `pathOrUrl` is either a path on `host` or an absolute URL
 * (Twilio's paging links are absolute on the v1/v2 APIs and relative on 2010).
 */
export async function twilioFetch<T>(
  ctx: TwilioContext,
  host: string,
  pathOrUrl: string,
  req: TwilioRequest = {},
): Promise<T> {
  const method = req.method ?? (req.form ? "POST" : "GET");
  const base = pathOrUrl.startsWith("http") ? pathOrUrl : `${host}${pathOrUrl}`;
  const qs = encode(req.query);
  const url = qs ? `${base}${base.includes("?") ? "&" : "?"}${qs}` : base;
  const headers: Record<string, string> = {
    Authorization: basicAuth(ctx),
    Accept: "application/json",
  };
  const body = req.form ? encode(req.form) : undefined;
  if (body !== undefined) headers["Content-Type"] = "application/x-www-form-urlencoded";
  const label = pathOrUrl.split("?")[0] ?? pathOrUrl;

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
  if (status < 200 || status >= 300) throw describeError(status, text, label);
  if (status === 204 || !text) return undefined as T;
  return JSON.parse(text) as T;
}

/** Path prefix for an account on the 2010 API. */
export function accountPath(accountSid: string): string {
  return `/2010-04-01/Accounts/${encodeURIComponent(accountSid)}`;
}

/**
 * Walk a 2010-API list. The list key differs per resource
 * (`incoming_phone_numbers`, `usage_records`…) and `next_page_uri` is a path
 * relative to `api.twilio.com`, or null on the last page.
 */
export async function list2010<T>(
  ctx: TwilioContext,
  path: string,
  key: string,
  query: Record<string, FormValue> = {},
  maxPages = 50,
): Promise<T[]> {
  const out: T[] = [];
  let next: string | null = path;
  let first = true;
  for (let page = 0; page < maxPages && next; page++) {
    const res: Record<string, unknown> = await twilioFetch<Record<string, unknown>>(
      ctx,
      API_HOST,
      next,
      first ? { query: { PageSize: 1000, ...query } } : {},
    );
    first = false;
    const items = res[key];
    if (Array.isArray(items)) out.push(...(items as T[]));
    const nextUri = res["next_page_uri"];
    next = typeof nextUri === "string" && nextUri ? nextUri : null;
  }
  return out;
}

/**
 * Walk a v1/v2 product-API list (`messaging`, `verify`): items under `key`,
 * the next page as an absolute `meta.next_page_url`.
 */
export async function listV1<T>(
  ctx: TwilioContext,
  host: string,
  path: string,
  key: string,
  query: Record<string, FormValue> = {},
  maxPages = 50,
): Promise<T[]> {
  const out: T[] = [];
  let next: string | null = path;
  let first = true;
  for (let page = 0; page < maxPages && next; page++) {
    const res: Record<string, unknown> = await twilioFetch<Record<string, unknown>>(
      ctx,
      host,
      next,
      first ? { query: { PageSize: 1000, ...query } } : {},
    );
    first = false;
    const items = res[key];
    if (Array.isArray(items)) out.push(...(items as T[]));
    const meta = res["meta"] as { next_page_url?: string | null } | undefined;
    next = meta?.next_page_url ? meta.next_page_url : null;
  }
  return out;
}
