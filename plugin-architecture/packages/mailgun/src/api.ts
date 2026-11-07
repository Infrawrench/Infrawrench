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
import { ListTruncatedError, followableLink, requireListPage } from "@infrawrench/plugin-base";

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

const VENDOR = "Mailgun";
const MAX_LIST_ROWS = 100_000;
const MAX_LIST_REQUESTS = 1000;

export interface ListSkipOptions {
  query?: Record<string, FormValue>;
  /** The most the route is known to take. A route that gives back fewer loses nothing. */
  pageSize?: number;
  maxItems?: number;
  key?: "items" | "subaccounts";
}

/** `limit`/`skip` lists returning `{ items, total_count }` or `{ subaccounts, total }`. */
export async function listSkip<T>(
  ctx: MailgunContext,
  region: MailgunRegion,
  path: string,
  { query = {}, pageSize = 100, maxItems = MAX_LIST_ROWS, key = "items" }: ListSkipOptions = {},
): Promise<T[]> {
  const out: T[] = [];
  for (let request = 0; request < MAX_LIST_REQUESTS && out.length < maxItems; request++) {
    const res = await mailgunFetch<{
      items?: T[];
      subaccounts?: T[];
      total_count?: number;
      total?: number;
    }>(ctx, region, path, { query: { ...query, limit: pageSize, skip: out.length } });
    const rows = requireListPage(res?.[key], { vendor: VENDOR, path, key, page: res });
    out.push(...rows);
    if (rows.length === 0) return out;
    // Most of these routes document no largest page, so a short page only ends the list
    // when there is no count to say otherwise.
    const total = res?.total_count ?? res?.total;
    if (total !== undefined ? out.length >= total : rows.length < pageSize) return out;
  }
  throw new ListTruncatedError({ vendor: VENDOR, path, items: out.length, maxItems });
}

/** A next link may name either of Mailgun's API hosts, both in the manifest's `egressHosts`. */
const isMailgunHost = (link: URL): boolean =>
  link.protocol === "https:" && MAILGUN_HOSTNAMES.includes(link.hostname);

/** Lists that page by an absolute `paging.next` URL and end on an empty page. */
export async function listPaging<T>(
  ctx: MailgunContext,
  region: MailgunRegion,
  path: string,
  query: Record<string, FormValue> = {},
  maxPages = MAX_LIST_REQUESTS,
): Promise<T[]> {
  const out: T[] = [];
  const seen = new Set<string>();
  let pageUrl = `${API_HOSTS[region]}${path}`;
  for (let page = 0; page < maxPages; page++) {
    const res: { items?: T[]; paging?: { next?: string } } | undefined = await mailgunFetch(
      ctx,
      region,
      pageUrl,
      page === 0 ? { query } : {},
    );
    const rows = requireListPage(res?.items, { vendor: VENDOR, path, key: "items", page: res });
    out.push(...rows);
    const next = res?.paging?.next;
    if (rows.length === 0 || !next) return out;
    pageUrl = followableLink(next, pageUrl, {
      vendor: VENDOR,
      path,
      foreignLinks: isMailgunHost,
    });
    // The cursor is the page's last row, so a link seen before is a list that stopped moving.
    if (seen.has(pageUrl)) {
      throw new ListTruncatedError({ vendor: VENDOR, path, items: out.length, maxPages: page + 1 });
    }
    seen.add(pageUrl);
  }
  throw new ListTruncatedError({ vendor: VENDOR, path, items: out.length, maxPages });
}
