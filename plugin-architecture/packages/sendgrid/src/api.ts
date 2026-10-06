/**
 * Twilio SendGrid v3 transport.
 *
 * `https://api.sendgrid.com` for global accounts and subusers,
 * `https://api.eu.sendgrid.com` for EU regional subusers. Auth is
 * `Authorization: Bearer <API key>`; the optional `on-behalf-of: <username>`
 * header lets a parent account's key act as one of its subusers. Errors are
 * `{ errors: [{ message, field }] }`.
 *
 * Verified against Twilio's published OpenAPI documents
 * (`twilio/sendgrid-oai`, `spec/json/tsg_*_v3.json`, 2026-10).
 */
import type { HttpHostServices } from "@infrawrench/plugin-base";

export const API_HOSTS = {
  global: "https://api.sendgrid.com",
  eu: "https://api.eu.sendgrid.com",
} as const;

export type SendGridRegion = keyof typeof API_HOSTS;

export const SENDGRID_HOSTNAMES = ["api.sendgrid.com", "api.eu.sendgrid.com"];

export interface SendGridContext {
  apiKey: string;
  region: SendGridRegion;
  /** Subuser username sent as `on-behalf-of`, or empty for the key's own account. */
  onBehalfOf: string;
  caCert?: string;
  http?: HttpHostServices;
}

export class SendGridApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "SendGridApiError";
    this.status = status;
  }
}

export function statusOf(err: unknown): number | undefined {
  return err instanceof SendGridApiError ? err.status : undefined;
}

/** 401/403: the key lacks the scope (or the plan lacks the feature). */
export function isAccessDenied(err: unknown): boolean {
  const s = statusOf(err);
  return s === 401 || s === 403;
}

export type QueryValue = string | number | boolean | undefined;

export interface SendGridRequest {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Record<string, QueryValue>;
  body?: unknown;
  /** Skip `on-behalf-of` (parent-only endpoints such as `/v3/subusers`). */
  asParent?: boolean;
}

function describeError(status: number, body: string, path: string): SendGridApiError {
  let message = body;
  try {
    const parsed = JSON.parse(body) as {
      errors?: Array<{ message?: string; field?: string | null }>;
    };
    const msgs = (parsed.errors ?? [])
      .map((e) => (e.field ? `${e.field}: ${e.message ?? ""}` : (e.message ?? "")))
      .filter(Boolean);
    if (msgs.length > 0) message = msgs.join("; ");
  } catch {
    // Non-JSON body: keep the raw text.
  }
  const hint =
    status === 401
      ? " Check the API key and that the region matches the account."
      : status === 403
        ? " The API key is missing a scope this needs, or the plan does not include the feature."
        : status === 429
          ? " SendGrid is rate limiting this key; try again shortly."
          : "";
  return new SendGridApiError(
    status,
    `SendGrid API error ${status} for ${path}: ${message || "(empty)"}.${hint}`,
  );
}

export async function sendgridFetch<T>(
  ctx: SendGridContext,
  path: string,
  req: SendGridRequest = {},
): Promise<T> {
  const method = req.method ?? (req.body !== undefined ? "POST" : "GET");
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query ?? {})) {
    if (v !== undefined && v !== "") qs.append(k, String(v));
  }
  const query = qs.toString();
  const url = `${API_HOSTS[ctx.region]}${path}${query ? `?${query}` : ""}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${ctx.apiKey}`,
    Accept: "application/json",
  };
  if (ctx.onBehalfOf && !req.asParent) headers["on-behalf-of"] = ctx.onBehalfOf;
  const body = req.body !== undefined ? JSON.stringify(req.body) : undefined;
  if (body !== undefined) headers["Content-Type"] = "application/json";

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
  if (status < 200 || status >= 300) throw describeError(status, text, path);
  if (status === 204 || !text) return undefined as T;
  return JSON.parse(text) as T;
}

/** Walk a `limit`/`offset` list that returns a bare array. */
export async function listOffset<T>(
  ctx: SendGridContext,
  path: string,
  query: Record<string, QueryValue> = {},
  opts: { pageSize?: number; maxItems?: number; asParent?: boolean } = {},
): Promise<T[]> {
  const pageSize = opts.pageSize ?? 100;
  const maxItems = opts.maxItems ?? 5000;
  const out: T[] = [];
  for (let offset = 0; offset < maxItems; offset += pageSize) {
    const page = await sendgridFetch<T[]>(ctx, path, {
      query: { ...query, limit: pageSize, offset },
      ...(opts.asParent ? { asParent: true } : {}),
    });
    const items = Array.isArray(page) ? page : [];
    out.push(...items);
    if (items.length < pageSize) break;
  }
  return out;
}

/**
 * Walk `/v3/templates`, which pages by `page_token` taken from the absolute
 * `_metadata.next` URL (max `page_size` 200).
 */
export async function listTemplates<T>(ctx: SendGridContext, maxPages = 25): Promise<T[]> {
  const out: T[] = [];
  let token: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const res = await sendgridFetch<{ result?: T[]; _metadata?: { next?: string } }>(
      ctx,
      "/v3/templates",
      { query: { generations: "legacy,dynamic", page_size: 200, page_token: token } },
    );
    out.push(...(res?.result ?? []));
    const next = res?._metadata?.next;
    if (!next) break;
    let nextToken: string | null = null;
    try {
      nextToken = new URL(next).searchParams.get("page_token");
    } catch {
      nextToken = null;
    }
    if (!nextToken || nextToken === token) break;
    token = nextToken;
  }
  return out;
}
