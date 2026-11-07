import {
  findNextLink,
  followableLink,
  ListPageError,
  ListTruncatedError,
  requireListPage,
  type HttpHostServices,
} from "@infrawrench/plugin-base";

/**
 * Buildkite REST API v2 (https://buildkite.com/docs/apis/rest-api, verified
 * 2026-10). Every request carries the API access token as
 * `Authorization: Bearer`; basic auth is not supported. Lists page through
 * the `Link` response header (`rel="next"`), `per_page` maxes out at 100.
 *
 * Test Engine lives under the same host at `/v2/analytics/...` and takes the
 * same token.
 *
 * Two rate limits apply to every call: 200 requests a minute per
 * organization and 50 a minute per user. A 429 carries `RateLimit-Reset` /
 * `RateLimit-User-Reset` (seconds); {@link bkRequest} waits that long once
 * (capped) and retries.
 */
export const API_BASE = "https://api.buildkite.com/v2";
export const WEB_BASE = "https://buildkite.com";

/** Everything a Buildkite request needs. */
export interface BkContext {
  token: string;
  http?: HttpHostServices;
  /** Injected in tests so a 429 does not really wait. */
  sleep?: (ms: number) => Promise<void>;
}

/** Thrown for any non-2xx answer, carrying the status the poller classifies on. */
export class BuildkiteApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "BuildkiteApiError";
    this.status = status;
  }
}

/** HTTP status of a failed call, or 0 for a transport error. */
export function statusOf(err: unknown): number {
  return err instanceof BuildkiteApiError ? err.status : 0;
}

export function isPermissionError(err: unknown): boolean {
  const s = statusOf(err);
  return s === 401 || s === 403;
}

/**
 * A 404 meaning the thing asked for is not there. Buildkite documents
 * `{"message":"No organization found"}` as the answer to every organization route once
 * the organization loses its active plan, and that says nothing about what it holds.
 */
export function isAbsent(err: unknown): boolean {
  return statusOf(err) === 404 && !/no organization found/i.test(errorMessage(err));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "";
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

/** The human part of an error body: `{message, errors}` on Buildkite. */
export function errorDetail(body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: unknown; errors?: unknown };
    const parts: string[] = [];
    if (typeof parsed.message === "string") parts.push(parsed.message);
    if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
      parts.push(
        parsed.errors
          .map((e) =>
            typeof e === "string"
              ? e
              : e && typeof e === "object"
                ? [
                    (e as { field?: unknown }).field,
                    (e as { code?: unknown; message?: unknown }).code ??
                      (e as { message?: unknown }).message,
                  ]
                    .filter((x) => typeof x === "string")
                    .join(": ")
                : "",
          )
          .filter(Boolean)
          .join("; "),
      );
    }
    if (parts.length > 0) return parts.join(" - ");
  } catch {
    // Not JSON: fall through to the raw body.
  }
  return body.slice(0, 500);
}

export interface RequestOptions {
  method?: string;
  query?: Query;
  body?: unknown;
  /** Extra headers (Accept, Range, Buildkite-Version). */
  headers?: Record<string, string>;
  /** The longest to wait on a 429 before the one retry. */
  maxRateLimitWaitMs?: number;
}

export interface RawResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
}

const MAX_RATE_LIMIT_WAIT_MS = 30_000;
/**
 * Both limits are per minute, so a list past 50 pages meets one that only a wait of up
 * to the whole minute gets through: a shorter wait spends the retry inside the window.
 */
const LIST_RATE_LIMIT_WAIT_MS = 60_000;

function header(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === lower) return v;
  return undefined;
}

async function once(
  ctx: BkContext,
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
): Promise<RawResponse> {
  if (ctx.http) {
    const res = await ctx.http.request({
      url,
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
    });
    return { status: res.status, headers: res.headers ?? {}, text: res.body };
  }
  const res = await fetch(url, { method, headers, ...(body !== undefined ? { body } : {}) });
  const out: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    out[k] = v;
  });
  return { status: res.status, headers: out, text: await res.text() };
}

/**
 * One request, returning status, headers and the raw body. Goes through the
 * host HTTP service whenever there is one (bastion egress, custom CA).
 * Throws {@link BuildkiteApiError} on anything outside 2xx.
 */
export async function bkRequest(
  ctx: BkContext,
  pathOrUrl: string,
  opts: RequestOptions = {},
): Promise<RawResponse> {
  const url = pathOrUrl.startsWith("https://")
    ? pathOrUrl
    : `${API_BASE}${pathOrUrl}${buildQuery(opts.query)}`;
  const method = opts.method ?? "GET";
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${ctx.token}`,
    ...(opts.headers ?? {}),
  };
  const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let res = await once(ctx, url, method, headers, body);
  if (res.status === 429) {
    const reset = Math.max(
      Number(header(res.headers, "RateLimit-User-Reset") ?? 0),
      Number(header(res.headers, "RateLimit-Reset") ?? 0),
    );
    const waitMs = Math.min(
      opts.maxRateLimitWaitMs ?? MAX_RATE_LIMIT_WAIT_MS,
      Math.max(1, reset || 5) * 1000,
    );
    await (ctx.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))))(waitMs);
    res = await once(ctx, url, method, headers, body);
  }
  if (res.status < 200 || res.status >= 300) {
    const label = url.replace(API_BASE, "").split("?")[0];
    throw new BuildkiteApiError(
      res.status,
      `Buildkite API error ${res.status} for ${label}: ${errorDetail(res.text)}`,
    );
  }
  return res;
}

/** One JSON request. 204 and empty bodies resolve to `undefined`. */
export async function bkFetch<T>(
  ctx: BkContext,
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const res = await bkRequest(ctx, path, opts);
  return (res.status === 204 || !res.text ? undefined : JSON.parse(res.text)) as T;
}

/** The `rel="next"` URL of a `Link` header, if any. */
export function nextLink(linkHeader: string | undefined): string | undefined {
  return findNextLink(linkHeader);
}

export interface PagedOptions {
  query?: Query;
  headers?: Record<string, string>;
  maxPages?: number;
  /** Return what was read at the cap, for a read where part of the list is fine. */
  partial?: boolean;
}

/** 10,000 rows, and two minutes at the per-user limit: inside one poll. */
const DEFAULT_MAX_PAGES = 100;
/** A picker's 2,000 options; it is fine with part of the list. */
export const PICKER_MAX_PAGES = 20;

type ListBody<T> = T[] | { items?: T[] | null } | null | undefined;

function pageRows<T>(text: string, path: string): T[] {
  const place = { vendor: "Buildkite", path };
  let body: ListBody<T>;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    throw new ListPageError({ ...place, key: null, found: text });
  }
  if (Array.isArray(body) || body === null || body === undefined) {
    return requireListPage(body, { ...place, key: null });
  }
  return requireListPage(body.items, { ...place, key: "items" });
}

/**
 * Every page of a `Link`-paginated list. Past `maxPages` it throws, unless `partial`, and
 * a next link off the API host throws too, so the token never goes anywhere else.
 */
export async function bkPaged<T>(
  ctx: BkContext,
  path: string,
  options: PagedOptions = {},
): Promise<T[]> {
  const { query, headers, partial, maxPages = DEFAULT_MAX_PAGES } = options;
  const out: T[] = [];
  let next = path;
  let pageUrl = `${API_BASE}${path}`;
  for (let page = 0; page < maxPages; page++) {
    const res: RawResponse = await bkRequest(ctx, next, {
      ...(page === 0 ? { query: { per_page: 100, ...query } } : {}),
      ...(headers ? { headers } : {}),
      ...(partial ? {} : { maxRateLimitWaitMs: LIST_RATE_LIMIT_WAIT_MS }),
    });
    out.push(...pageRows<T>(res.text, path));
    const link = nextLink(header(res.headers, "Link"));
    if (!link) return out;
    next = followableLink(link, pageUrl, { vendor: "Buildkite", path });
    pageUrl = next;
  }
  if (partial) return out;
  throw new ListTruncatedError({ vendor: "Buildkite", path, items: out.length, maxPages });
}

export const enc = encodeURIComponent;

/** Strip ANSI colour codes and Buildkite's `_bk;t=<ms>` timestamp markers from a raw log. */
export function cleanLog(raw: string): string {
  return (
    raw
      // APC timestamp markers: ESC _ bk;t=123 BEL
      .replace(/\u001b_bk;[^\u0007]*\u0007/g, "")
      // CSI sequences (colours, cursor movement)
      .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
      // OSC sequences (hyperlinks, titles)
      .replace(/\u001b\][^\u0007]*(\u0007|\u001b\\)/g, "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
  );
}
