import type { HttpHostServices } from "@infrawrench/plugin-base";

/** Every management call goes here; the real-time stats API has its own host. */
export const API_BASE = "https://api.fastly.com";
export const REALTIME_BASE = "https://rt.fastly.com";

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
    throw new FastlyApiError(status, `Fastly API error ${status} for ${path}: ${errorText(text)}`);
  }
  return { status, body: text };
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

/** JSON request; `undefined` for an empty body. */
export async function fastlyFetch<T>(
  ctx: FastlyContext,
  path: string,
  req: FastlyRequest = {},
): Promise<T> {
  const res = await fastlyRaw(ctx, path, req);
  if (!res.body) return undefined as T;
  return JSON.parse(res.body) as T;
}

/**
 * Page through a classic list endpoint (`page` / `per_page`, a bare array per
 * page). Stops on a short page and hard-stops at `maxPages`.
 */
export async function fastlyPaged<T>(
  ctx: FastlyContext,
  path: string,
  query: Query = {},
  perPage = 100,
  maxPages = 50,
): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const batch = await fastlyFetch<T[]>(ctx, path, {
      query: { ...query, page, per_page: perPage },
    });
    const list = Array.isArray(batch) ? batch : [];
    out.push(...list);
    if (list.length < perPage) break;
  }
  return out;
}

/**
 * Page through a JSON:API list (`page[number]` / `page[size]`, the shape the
 * TLS endpoints share). Stops when `meta.total_pages` is reached or a page
 * comes back short.
 */
export async function fastlyJsonApiPaged<T>(
  ctx: FastlyContext,
  path: string,
  query: Query = {},
  pageSize = 100,
  maxPages = 50,
): Promise<{ data: T[]; included: unknown[] }> {
  const data: T[] = [];
  const included: unknown[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = await fastlyFetch<{
      data?: T[];
      included?: unknown[];
      meta?: { total_pages?: number };
    }>(ctx, path, {
      query: { ...query, "page[number]": page, "page[size]": pageSize },
      headers: { Accept: "application/vnd.api+json" },
    });
    const batch = res?.data ?? [];
    data.push(...batch);
    included.push(...(res?.included ?? []));
    const total = res?.meta?.total_pages;
    if (batch.length < pageSize || (total !== undefined && page >= total)) break;
  }
  return { data, included };
}

/**
 * Page through a cursor list (`cursor` / `limit`, `{data, meta.next_cursor}`),
 * the shape the billing, KV, secret store and newer endpoints share.
 */
export async function fastlyCursorPaged<T>(
  ctx: FastlyContext,
  path: string,
  query: Query = {},
  limit = 100,
  maxPages = 100,
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const res = await fastlyFetch<{ data?: T[]; meta?: { next_cursor?: string } }>(ctx, path, {
      query: { ...query, limit, ...(cursor ? { cursor } : {}) },
    });
    out.push(...(res?.data ?? []));
    cursor = res?.meta?.next_cursor || undefined;
    if (!cursor) break;
  }
  return out;
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
