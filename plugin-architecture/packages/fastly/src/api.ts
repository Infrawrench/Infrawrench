import type { HttpHostServices } from "@infrawrench/plugin-base";
import {
  ListPageError,
  ListTruncatedError,
  findNextLink,
  requireListPage,
} from "@infrawrench/plugin-base";

/** Every management call goes here; the real-time stats API has its own host. */
export const API_BASE = "https://api.fastly.com";
export const REALTIME_BASE = "https://rt.fastly.com";

const VENDOR = "Fastly";
/**
 * 10,000 rows at the 100 a page classic and JSON:API lists are asked for. Fastly
 * documents no largest page size for those.
 */
const MAX_PAGES = 100;

/**
 * Everything a Fastly request needs. Split out of the client so the cost
 * collector, the stats readers and the preflight probe can be exercised on
 * their own.
 */
export interface FastlyContext {
  token: string;
  caCert?: string;
  http?: HttpHostServices;
}

/** Thrown for any non-2xx answer, carrying the status the callers branch on. */
export class FastlyApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "FastlyApiError";
    this.status = status;
  }
}

/** HTTP status of a failed call, or 0 for a transport error. */
export function statusOf(err: unknown): number {
  return err instanceof FastlyApiError ? err.status : 0;
}

/** True for the answers that mean "this token or this user may not do that". */
export function isPermissionError(err: unknown): boolean {
  const status = statusOf(err);
  return status === 401 || status === 403;
}

type Query = Record<string, string | number | boolean | undefined>;

export interface FastlyRequest {
  method?: string;
  query?: Query;
  /** A JSON body (sent as `application/json`). */
  json?: unknown;
  /**
   * A form body. The classic configuration endpoints (services, versions,
   * dictionary and config-store items) take `application/x-www-form-urlencoded`
   * rather than JSON.
   */
  form?: Record<string, string | number | boolean | undefined>;
  /** A raw body, sent as `application/octet-stream` (KV store values). */
  raw?: string;
  headers?: Record<string, string>;
  /** Defaults to the management API. */
  base?: string;
}

export interface FastlyResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function buildUrl(base: string, path: string, query?: Query): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== "") params.set(k, String(v));
  }
  const qs = params.toString();
  return `${base}${path}${qs ? `?${qs}` : ""}`;
}

/**
 * One request against the Fastly API. Fastly authenticates every call with a
 * single `Fastly-Key` header carrying an API token; what the token may do is
 * its scope (`global`, `global:read`, `purge_select`, `purge_all`) intersected
 * with its user's role.
 *
 * Routed through the host HTTP service whenever there is one: that is the only
 * path that honours bastion egress and a custom CA.
 */
export async function fastlyRaw(
  ctx: FastlyContext,
  path: string,
  req: FastlyRequest = {},
): Promise<FastlyResponse> {
  const url = buildUrl(req.base ?? API_BASE, path, req.query);
  const method = req.method ?? "GET";
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Fastly-Key": ctx.token,
    ...(req.headers ?? {}),
  };
  let body: string | undefined;
  if (req.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(req.json);
  } else if (req.form !== undefined) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(req.form)) {
      if (v !== undefined) form.set(k, String(v));
    }
    body = form.toString();
  } else if (req.raw !== undefined) {
    headers["Content-Type"] = "application/octet-stream";
    body = req.raw;
  }

  let status: number;
  let responseHeaders: Record<string, string>;
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
    responseHeaders = res.headers;
    text = res.body;
  } else {
    const res = await fetch(url, { method, headers, ...(body !== undefined ? { body } : {}) });
    status = res.status;
    responseHeaders = Object.fromEntries(res.headers.entries());
    text = await res.text();
  }
  if (status < 200 || status >= 300) {
    throw new FastlyApiError(status, `Fastly API error ${status} for ${path}: ${errorText(text)}`);
  }
  return { status, headers: responseHeaders, body: text };
}

/** Fastly errors are `{msg, detail}` (classic) or JSON:API `{errors:[{title,detail}]}`. */
function errorText(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      msg?: string;
      detail?: string;
      errors?: Array<{ title?: string; detail?: string }>;
    };
    if (parsed.errors?.length) {
      return parsed.errors
        .map((e) => [e.title, e.detail].filter(Boolean).join(": "))
        .filter(Boolean)
        .join("; ");
    }
    const joined = [parsed.msg, parsed.detail].filter(Boolean).join(": ");
    if (joined) return joined;
  } catch {
    // not JSON
  }
  return body.slice(0, 500);
}

function parsed<T>(res: FastlyResponse): T {
  if (!res.body) return undefined as T;
  return JSON.parse(res.body) as T;
}

/** JSON request; `undefined` for an empty body. */
export async function fastlyFetch<T>(
  ctx: FastlyContext,
  path: string,
  req: FastlyRequest = {},
): Promise<T> {
  return parsed<T>(await fastlyRaw(ctx, path, req));
}

/** A list Fastly answers whole, as one bare array. */
export async function fastlyList<T>(ctx: FastlyContext, path: string): Promise<T[]> {
  return requireListPage(await fastlyFetch<T[] | undefined>(ctx, path), {
    vendor: VENDOR,
    path,
    key: null,
  });
}

/**
 * Page through a classic list endpoint (`page` / `per_page`, a bare array per
 * page). Throws at `maxPages` with more to read.
 */
export async function fastlyPaged<T>(
  ctx: FastlyContext,
  path: string,
  query: Query = {},
  perPage = 100,
  maxPages = MAX_PAGES,
): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = await fastlyRaw(ctx, path, { query: { ...query, page, per_page: perPage } });
    const list = requireListPage(parsed<T[] | undefined>(res), {
      vendor: VENDOR,
      path,
      key: null,
    });
    out.push(...list);
    // Fastly documents no largest per_page. A server serving fewer than was asked for
    // looks like the last page, except that its Link header still names a next one.
    if (list.length < perPage && !findNextLink(res.headers["link"])) return out;
  }
  throw new ListTruncatedError({ vendor: VENDOR, path, items: out.length, maxPages });
}

/**
 * Page through a JSON:API list (`page[number]` / `page[size]`, the shape the
 * TLS endpoints share). `meta.total_pages` says when it ends, a short page where
 * that is missing. Throws at `maxPages` with more to read.
 */
export async function fastlyJsonApiPaged<T>(
  ctx: FastlyContext,
  path: string,
  query: Query = {},
  pageSize = 100,
  maxPages = MAX_PAGES,
): Promise<{ data: T[]; included: unknown[] }> {
  const data: T[] = [];
  const included: unknown[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = await fastlyFetch<
      | {
          data?: T[];
          included?: unknown[];
          meta?: { total_pages?: number };
        }
      | undefined
    >(ctx, path, {
      query: { ...query, "page[number]": page, "page[size]": pageSize },
      headers: { Accept: "application/vnd.api+json" },
    });
    const batch = requireListPage(res?.data, { vendor: VENDOR, path, key: "data", page: res });
    data.push(...batch);
    included.push(...(res?.included ?? []));
    const total = res?.meta?.total_pages;
    if (total === undefined ? batch.length < pageSize : page >= total) return { data, included };
    if (batch.length === 0) {
      throw new ListPageError({
        vendor: VENDOR,
        path,
        key: "data",
        found: batch,
        saysMoreWith: "no rows",
      });
    }
  }
  throw new ListTruncatedError({ vendor: VENDOR, path, items: data.length, maxPages });
}

/**
 * Page through a cursor list (`cursor` / `limit`, `{data, meta.next_cursor}`),
 * the shape the billing, KV, secret store and newer endpoints share. Throws at
 * `maxPages` with more to read.
 */
export async function fastlyCursorPaged<T>(
  ctx: FastlyContext,
  path: string,
  query: Query = {},
  limit = 100,
  maxPages = MAX_PAGES,
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const res = await fastlyFetch<{ data?: T[]; meta?: { next_cursor?: string } } | undefined>(
      ctx,
      path,
      {
        query: { ...query, limit, ...(cursor ? { cursor } : {}) },
      },
    );
    out.push(...requireListPage(res?.data, { vendor: VENDOR, path, key: "data", page: res }));
    cursor = res?.meta?.next_cursor || undefined;
    if (!cursor) return out;
  }
  throw new ListTruncatedError({ vendor: VENDOR, path, items: out.length, maxPages });
}

/** Run `fn` over `items` with at most `limit` in flight. Order is preserved. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}
