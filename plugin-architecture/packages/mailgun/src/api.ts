/**
 * Mailgun REST transport.
 *
 * Two regions with separate data: `https://api.mailgun.net` (US) and
 * `https://api.eu.mailgun.net` (EU). One account API key works on both, but a
 * domain, its routes, mailing lists, webhooks, SMTP credentials and
 * suppressions live in exactly one region, so region-scoped listings query
 * every region the connection is set to. Auth is HTTP Basic `api:<key>`.
 * Writes are form-encoded (repeated keys for arrays) except where noted.
 * Errors are `{ message }`.
 *
 * Verified against Mailgun's published OpenAPI document
 * (documentation.mailgun.com/_spec/docs/mailgun/api-reference/send/mailgun.json,
 * 2026-10).
 */
import type { HttpHostServices } from "@infrawrench/plugin-base";

export const API_HOSTS = {
  us: "https://api.mailgun.net",
  eu: "https://api.eu.mailgun.net",
} as const;

export type MailgunRegion = keyof typeof API_HOSTS;
export const REGIONS: MailgunRegion[] = ["us", "eu"];
export const MAILGUN_HOSTNAMES = ["api.mailgun.net", "api.eu.mailgun.net"];

export const SMTP_HOSTS: Record<MailgunRegion, string> = {
  us: "smtp.mailgun.org",
  eu: "smtp.eu.mailgun.org",
};

export interface MailgunContext {
  apiKey: string;
  /** Regions this connection reads, in order. */
  regions: MailgunRegion[];
  caCert?: string;
  http?: HttpHostServices;
}

export class MailgunApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "MailgunApiError";
    this.status = status;
  }
}

export function statusOf(err: unknown): number | undefined {
  return err instanceof MailgunApiError ? err.status : undefined;
}

export type FormValue = string | number | boolean | undefined | Array<string | number>;

export interface MailgunRequest {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Record<string, FormValue>;
  form?: Record<string, FormValue>;
  json?: unknown;
  headers?: Record<string, string>;
}

export function encodeParams(params: Record<string, FormValue> | undefined): string {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v === undefined || v === "") continue;
    if (Array.isArray(v)) for (const item of v) out.append(k, String(item));
    else out.append(k, String(v));
  }
  return out.toString();
}

function describeError(status: number, body: string, path: string): MailgunApiError {
  let message = body;
  try {
    const parsed = JSON.parse(body) as { message?: string; Error?: string };
    message = parsed.message ?? parsed.Error ?? body;
  } catch {
    // Non-JSON body: keep the raw text.
  }
  const hint =
    status === 401
      ? " Check the API key (Account settings, API keys); a domain sending key cannot manage the account."
      : status === 403
        ? " The key's role or the plan does not allow this."
        : status === 429
          ? " Mailgun is rate limiting this key; try again shortly."
          : "";
  return new MailgunApiError(
    status,
    `Mailgun API error ${status} for ${path}: ${(message || "(empty)").trim()}.${hint}`,
  );
}

/** One request against a region. `path` may also be an absolute paging URL. */
export async function mailgunFetch<T>(
  ctx: MailgunContext,
  region: MailgunRegion,
  path: string,
  req: MailgunRequest = {},
): Promise<T> {
  const base = path.startsWith("http") ? path : `${API_HOSTS[region]}${path}`;
  const qs = encodeParams(req.query);
  const url = qs ? `${base}${base.includes("?") ? "&" : "?"}${qs}` : base;
  const method = req.method ?? (req.form || req.json !== undefined ? "POST" : "GET");
  const headers: Record<string, string> = {
    Authorization: `Basic ${btoa(`api:${ctx.apiKey}`)}`,
    Accept: "application/json",
    ...(req.headers ?? {}),
  };
  let body: string | undefined;
  if (req.json !== undefined) {
    body = JSON.stringify(req.json);
    headers["Content-Type"] = "application/json";
  } else if (req.form) {
    body = encodeParams(req.form);
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  }
  const label = (path.startsWith("http") ? new URL(path).pathname : path).split("?")[0] ?? path;

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
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

/** `limit`/`skip` lists returning `{ items, total_count }`. */
export async function listSkip<T>(
  ctx: MailgunContext,
  region: MailgunRegion,
  path: string,
  query: Record<string, FormValue> = {},
  pageSize = 100,
  maxItems = 5000,
): Promise<T[]> {
  const out: T[] = [];
  for (let skip = 0; skip < maxItems; skip += pageSize) {
    const res = await mailgunFetch<{ items?: T[]; total_count?: number }>(ctx, region, path, {
      query: { ...query, limit: pageSize, skip },
    });
    const items = res?.items ?? [];
    out.push(...items);
    if (
      items.length < pageSize ||
      (res?.total_count !== undefined && out.length >= res.total_count)
    )
      break;
  }
  return out;
}

/** Lists that page by an absolute `paging.next` URL and end on an empty page. */
export async function listPaging<T>(
  ctx: MailgunContext,
  region: MailgunRegion,
  path: string,
  query: Record<string, FormValue> = {},
  maxPages = 50,
): Promise<T[]> {
  const out: T[] = [];
  let next: string | null = path;
  let first = true;
  const seen = new Set<string>();
  for (let page = 0; page < maxPages && next; page++) {
    const res: { items?: T[]; paging?: { next?: string } } = await mailgunFetch(
      ctx,
      region,
      next,
      first ? { query } : {},
    );
    first = false;
    const items = res?.items ?? [];
    out.push(...items);
    const n = res?.paging?.next;
    if (items.length === 0 || !n || seen.has(n)) break;
    seen.add(n);
    next = n;
  }
  return out;
}
