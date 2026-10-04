import type { HttpHostServices } from "@infrawrench/plugin-base";
import type { SentryInstance } from "./regions.js";

/**
 * Everything a Sentry API request needs. Split out of the client so the cost
 * collector, the credential-option loader, preflight and the tests can run
 * without one.
 */
export interface SentryContext {
  token: string;
  instance: SentryInstance;
  caCert?: string;
  http?: HttpHostServices;
}

/** Thrown for any non-2xx answer, carrying the status callers branch on. */
export class SentryApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "SentryApiError";
    this.status = status;
  }
}

/** HTTP status of a failed call, or 0 for a transport error. */
export function statusOf(err: unknown): number {
  return err instanceof SentryApiError ? err.status : 0;
}

/** True for the answers that mean "this token may not do that". */
export function isPermissionError(err: unknown): boolean {
  const status = statusOf(err);
  return status === 401 || status === 403;
}

export type Query = Record<string, string | number | boolean | undefined | Array<string | number>>;

export function buildQuery(query: Query = {}): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === "") continue;
    if (Array.isArray(v)) for (const item of v) params.append(k, String(item));
    else params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export interface SentryResponse<T> {
  status: number;
  headers: Record<string, string>;
  body: T;
}

function lowerKeys(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
  return out;
}

function errorDetail(body: string): string {
  try {
    const parsed = JSON.parse(body) as { detail?: unknown };
    if (typeof parsed.detail === "string") return parsed.detail;
  } catch {
    // Not JSON: fall through to the raw body.
  }
  return body.slice(0, 500);
}

/**
 * One request against the instance's API (`<apiBase>/api/0<path>`), with the
 * token as a Bearer header. Returns the headers too: Sentry pages lists with
 * a `Link` header and reports totals in `X-Hits`, neither of which survives
 * `jsonRestFetch`.
 *
 * Routed through the host HTTP service whenever there is one: that is the
 * only path that honours bastion egress and a custom CA.
 */
export async function sentryRequest<T>(
  ctx: SentryContext,
  path: string,
  opts: { method?: string; query?: Query; body?: unknown; baseUrl?: string } = {},
): Promise<SentryResponse<T>> {
  const base = (opts.baseUrl ?? ctx.instance.apiUrl).replace(/\/+$/, "");
  const url = path.startsWith("http") ? path : `${base}/api/0${path}${buildQuery(opts.query)}`;
  const method = opts.method ?? "GET";
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${ctx.token}`,
  };
  const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let status: number;
  let text: string;
  let resHeaders: Record<string, string>;
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
    resHeaders = lowerKeys(res.headers ?? {});
  } else {
    const res = await fetch(url, { method, headers, ...(body !== undefined ? { body } : {}) });
    status = res.status;
    text = await res.text();
    resHeaders = {};
    res.headers.forEach((v, k) => {
      resHeaders[k.toLowerCase()] = v;
    });
  }
  if (status < 200 || status >= 300) {
    const shortPath = path.startsWith("http") ? new URL(path).pathname : path;
    throw new SentryApiError(
      status,
      `Sentry API error ${status} for ${shortPath}: ${errorDetail(text)}`,
    );
  }
  const parsed = status === 204 || !text ? (undefined as T) : (JSON.parse(text) as T);
  return { status, headers: resHeaders, body: parsed };
}

/** `sentryRequest` returning only the body. */
export async function sentryFetch<T>(
  ctx: SentryContext,
  path: string,
  opts: { method?: string; query?: Query; body?: unknown; baseUrl?: string } = {},
): Promise<T> {
  return (await sentryRequest<T>(ctx, path, opts)).body;
}

/**
 * The next page's URL from a Sentry `Link` header, or undefined when there is
 * none. Sentry always sends a `rel="next"` link and says whether it has
 * anything behind it with `results="true"|"false"`, so the flag (not the
 * link's presence) is what ends the loop.
 */
export function nextPageUrl(link: string | undefined): string | undefined {
  if (!link) return undefined;
  for (const part of link.split(",")) {
    const url = /<([^>]+)>/.exec(part)?.[1];
    if (!url) continue;
    if (!/rel="next"/.test(part)) continue;
    if (!/results="true"/.test(part)) return undefined;
    return url;
  }
  return undefined;
}

/**
 * Every page of a cursor-paginated list, up to `maxPages` (100 rows a page by
 * default), so a misbehaving cursor cannot spin forever.
 */
export async function sentryPaged<T>(
  ctx: SentryContext,
  path: string,
  query: Query = {},
  maxPages = 20,
): Promise<T[]> {
  const out: T[] = [];
  let res = await sentryRequest<T[]>(ctx, path, { query: { per_page: 100, ...query } });
  for (let page = 0; ; page++) {
    out.push(...(Array.isArray(res.body) ? res.body : []));
    const next = nextPageUrl(res.headers["link"]);
    if (!next || page + 1 >= maxPages) break;
    res = await sentryRequest<T[]>(ctx, next);
  }
  return out;
}
