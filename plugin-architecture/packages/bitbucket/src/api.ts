import type { HttpHostServices } from "@infrawrench/plugin-base";
import { utf8ToBase64 } from "@infrawrench/plugin-base";

/**
 * Bitbucket Cloud REST API 2.0 (https://api.bitbucket.org/2.0, OpenAPI at
 * https://api.bitbucket.org/swagger.json, verified 2026-10).
 *
 * - Auth: an Atlassian API token with scopes is sent as HTTP Basic with the
 *   Atlassian account **email** (not the Bitbucket username) as the user.
 *   Workspace, project and repository access tokens are sent as Bearer.
 *   App passwords were switched off on 2026-06-09 and are not supported.
 * - Lists are `{ values, next, page, pagelen, size }`; `next` is an absolute
 *   URL to follow verbatim. `pagelen` tops out at 100 on most lists.
 * - UUIDs are written with braces (`{1234-...}`) and must be URL-encoded in
 *   paths.
 */

export const API_BASE = "https://api.bitbucket.org/2.0";
export const WEB_BASE = "https://bitbucket.org";

export interface BitbucketContext {
  /** Atlassian account email for API tokens; empty for access tokens (Bearer). */
  email?: string;
  token: string;
  workspace: string;
  http?: HttpHostServices;
}

/** Thrown for any non-2xx answer, carrying the status callers (and the poller) branch on. */
export class BitbucketApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "BitbucketApiError";
    this.status = status;
  }
}

export function statusOf(err: unknown): number {
  return err instanceof BitbucketApiError ? err.status : 0;
}

export function isPermissionError(err: unknown): boolean {
  const s = statusOf(err);
  return s === 401 || s === 403;
}

export function isAbsent(err: unknown): boolean {
  const s = statusOf(err);
  return s === 403 || s === 404;
}

export function authHeader(ctx: Pick<BitbucketContext, "email" | "token">): string {
  return ctx.email ? `Basic ${utf8ToBase64(`${ctx.email}:${ctx.token}`)}` : `Bearer ${ctx.token}`;
}

export type Query = Record<string, string | number | boolean | undefined>;

export function buildQuery(query: Query = {}): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === "") continue;
    params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/** Bitbucket errors are `{"type": "error", "error": {"message": "...", "detail": ...}}`. */
export function errorDetail(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: unknown; detail?: unknown; fields?: Record<string, unknown> };
      message?: unknown;
    };
    const e = parsed.error;
    if (e) {
      const parts = [typeof e.message === "string" ? e.message : ""];
      if (typeof e.detail === "string") parts.push(e.detail);
      else if (e.detail && typeof e.detail === "object") parts.push(JSON.stringify(e.detail));
      if (e.fields) {
        parts.push(
          Object.entries(e.fields)
            .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`)
            .join("; "),
        );
      }
      const joined = parts.filter(Boolean).join(": ");
      if (joined) return joined;
    }
    if (typeof parsed.message === "string") return parsed.message;
  } catch {
    // Not JSON.
  }
  return body.slice(0, 500);
}

export interface RawResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
}

/**
 * One request. Routed through the host HTTP service whenever there is one:
 * that is the only path that honours bastion egress.
 */
export async function bbRaw(
  ctx: Pick<BitbucketContext, "http">,
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
): Promise<RawResponse> {
  const lower: Record<string, string> = {};
  if (ctx.http) {
    const res = await ctx.http.request({
      url,
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
    });
    for (const [k, v] of Object.entries(res.headers ?? {})) lower[k.toLowerCase()] = v;
    return { status: res.status, headers: lower, text: res.body };
  }
  const res = await fetch(url, { method, headers, ...(body !== undefined ? { body } : {}) });
  res.headers.forEach((v, k) => {
    lower[k.toLowerCase()] = v;
  });
  return { status: res.status, headers: lower, text: await res.text() };
}

export interface RequestOptions {
  method?: string;
  query?: Query;
  body?: unknown;
  as?: "json" | "text";
  headers?: Record<string, string>;
}

/** Resolve a path (relative to the API base) or a `next` link (absolute, same host only). */
function urlFor(pathOrUrl: string, query?: Query): string {
  if (/^https?:\/\//i.test(pathOrUrl)) {
    if (!pathOrUrl.startsWith(`${API_BASE}/`)) {
      throw new Error(`Bitbucket plugin: refusing to follow a link off ${API_BASE}: ${pathOrUrl}`);
    }
    return (
      pathOrUrl +
      (query && Object.keys(query).length > 0
        ? buildQuery(query).replace(/^\?/, pathOrUrl.includes("?") ? "&" : "?")
        : "")
    );
  }
  return `${API_BASE}${pathOrUrl}${buildQuery(query)}`;
}

export async function bbRequest(
  ctx: BitbucketContext,
  path: string,
  opts: RequestOptions = {},
): Promise<RawResponse> {
  const url = urlFor(path, opts.query);
  const method = opts.method ?? "GET";
  const headers: Record<string, string> = {
    Authorization: authHeader(ctx),
    Accept: opts.as === "text" ? "text/plain, */*" : "application/json",
    ...(opts.headers ?? {}),
  };
  const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await bbRaw(ctx, url, method, headers, body);
  if (res.status < 200 || res.status >= 300) {
    const shown = path.startsWith("http") ? new URL(path).pathname : path;
    throw new BitbucketApiError(
      res.status,
      `Bitbucket API error ${res.status} for ${method} ${shown}: ${errorDetail(res.text)}`,
    );
  }
  return res;
}

export async function bbFetch<T>(
  ctx: BitbucketContext,
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const res = await bbRequest(ctx, path, opts);
  if (opts.as === "text") return res.text as T;
  if (res.status === 204 || !res.text) return undefined as T;
  return JSON.parse(res.text) as T;
}

interface Page<T> {
  values?: T[];
  next?: string;
}

/** Every page of a list, following `next`, up to `maxPages`. */
export async function bbPaged<T>(
  ctx: BitbucketContext,
  path: string,
  query: Query = {},
  maxPages = 10,
  pagelen = 100,
): Promise<T[]> {
  const out: T[] = [];
  let next: string | undefined = path;
  let first = true;
  for (let i = 0; i < maxPages && next; i++) {
    const page: Page<T> = await bbFetch<Page<T>>(
      ctx,
      next,
      first ? { query: { pagelen, ...query } } : {},
    );
    first = false;
    out.push(...(Array.isArray(page?.values) ? page.values : []));
    next = page?.next;
  }
  return out;
}

export const enc = encodeURIComponent;

/** `{uuid}` in a path. Accepts the UUID with or without braces. */
export function encUuid(uuid: string): string {
  const v = uuid.trim();
  return enc(v.startsWith("{") ? v : `{${v}}`);
}

/** Split `head/rest` at the first slash: composite external ids. */
export function splitScoped(id: string): { scope: string; rest: string } {
  const i = id.indexOf("/");
  if (i < 0) return { scope: id, rest: "" };
  return { scope: id.slice(0, i), rest: id.slice(i + 1) };
}
