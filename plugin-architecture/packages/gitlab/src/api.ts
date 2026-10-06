import type { HttpHostServices } from "@infrawrench/plugin-base";

/**
 * GitLab REST API v4 (https://docs.gitlab.com/api/rest/, verified against
 * `doc/api/*.md` on gitlab-org/gitlab master, 2026-10).
 *
 * - Auth: `PRIVATE-TOKEN: <token>` works for personal, group and project
 *   access tokens alike.
 * - Offset pagination: `page` / `per_page` (max 100), with `X-Next-Page`
 *   naming the next page (empty on the last one). `X-Total` is omitted above
 *   10,000 rows, so it is only ever read as a hint.
 * - Paths that take a project or group accept the numeric id; everything here
 *   uses ids so nothing needs URL-encoding except branch, tag and variable
 *   names.
 * - GraphQL lives at `/api/graphql` on the same host and takes the same token
 *   as a Bearer token.
 */

export const GITLAB_COM = "https://gitlab.com";

/** Everything a request needs. Split out of the client so tests and the picker can build one. */
export interface GitLabContext {
  /** Instance root, e.g. `https://gitlab.com` (no trailing slash, no `/api/v4`). */
  baseUrl: string;
  token: string;
  caCert?: string;
  http?: HttpHostServices;
}

/** Thrown for any non-2xx answer, carrying the status callers (and the poller) branch on. */
export class GitLabApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "GitLabApiError";
    this.status = status;
  }
}

/** HTTP status of a failed call, or 0 for a transport error. */
export function statusOf(err: unknown): number {
  return err instanceof GitLabApiError ? err.status : 0;
}

/** True for the answers that mean "this token or role may not do that". */
export function isPermissionError(err: unknown): boolean {
  const s = statusOf(err);
  return s === 401 || s === 403;
}

/** True for "not here": a missing object, or a feature this tier or instance does not have. */
export function isAbsent(err: unknown): boolean {
  const s = statusOf(err);
  return s === 403 || s === 404;
}

/**
 * Normalise what people paste into the instance URL: blank means GitLab.com,
 * a bare host gets `https://`, and a trailing `/api/v4` or slash is dropped.
 * Anything that is not an http(s) URL is refused rather than guessed at,
 * because a token sent to the wrong host is a token sent to someone else.
 */
export function resolveBaseUrl(raw: string | undefined): string {
  let value = (raw ?? "").trim();
  if (!value) return GITLAB_COM;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      `GitLab plugin: "${raw}" is not a URL. Enter https://gitlab.com or your instance's address.`,
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`GitLab plugin: the instance URL must start with https:// (got "${raw}")`);
  }
  if (url.username || url.password) {
    throw new Error("GitLab plugin: put the token in the token field, not in the URL");
  }
  const path = url.pathname.replace(/\/+$/, "").replace(/\/api\/v4$/i, "");
  return `${url.protocol}//${url.host}${path}`;
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

/** GitLab errors are `{"message": "..."}` (string, array or field map) or `{"error": "..."}`. */
export function errorDetail(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      message?: unknown;
      error?: unknown;
      error_description?: unknown;
    };
    const m = parsed.message;
    if (typeof m === "string") return m;
    if (Array.isArray(m)) return m.map(String).join("; ");
    if (m && typeof m === "object") {
      return Object.entries(m as Record<string, unknown>)
        .map(([k, v]) => `${k} ${Array.isArray(v) ? v.join(", ") : String(v)}`)
        .join("; ");
    }
    if (typeof parsed.error_description === "string") return parsed.error_description;
    if (typeof parsed.error === "string") return parsed.error;
  } catch {
    // Not JSON: fall through to the raw body.
  }
  return body.slice(0, 500);
}

export interface RequestOptions {
  method?: string;
  query?: Query;
  body?: unknown;
  /** `"text"` returns the raw body (job logs). Defaults to JSON. */
  as?: "json" | "text";
}

export interface RawResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
}

/**
 * One request against the instance. Routed through the host HTTP service
 * whenever there is one: that is the only path that honours bastion egress
 * and a custom CA. The fallback `fetch` exists for tests and hosts with no
 * HTTP service.
 */
export async function glRaw(
  ctx: GitLabContext,
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
): Promise<RawResponse> {
  if (ctx.http) {
    const res = await ctx.http.request({
      url,
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
    });
    const lower: Record<string, string> = {};
    for (const [k, v] of Object.entries(res.headers ?? {})) lower[k.toLowerCase()] = v;
    return { status: res.status, headers: lower, text: res.body };
  }
  const res = await fetch(url, { method, headers, ...(body !== undefined ? { body } : {}) });
  const lower: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    lower[k.toLowerCase()] = v;
  });
  return { status: res.status, headers: lower, text: await res.text() };
}

function authHeaders(ctx: GitLabContext): Record<string, string> {
  return { "PRIVATE-TOKEN": ctx.token, Accept: "application/json" };
}

/** A REST call that also hands back the response headers (pagination, totals). */
export async function glRequest(
  ctx: GitLabContext,
  path: string,
  opts: RequestOptions = {},
): Promise<RawResponse> {
  const url = `${ctx.baseUrl}/api/v4${path}${buildQuery(opts.query)}`;
  const method = opts.method ?? "GET";
  const headers = authHeaders(ctx);
  const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await glRaw(ctx, url, method, headers, body);
  if (res.status < 200 || res.status >= 300) {
    throw new GitLabApiError(
      res.status,
      `GitLab API error ${res.status} for ${method} ${path}: ${errorDetail(res.text)}`,
    );
  }
  return res;
}

/** A REST call returning parsed JSON (or the raw text with `as: "text"`). */
export async function glFetch<T>(
  ctx: GitLabContext,
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const res = await glRequest(ctx, path, opts);
  if (opts.as === "text") return res.text as T;
  if (res.status === 204 || !res.text) return undefined as T;
  return JSON.parse(res.text) as T;
}

/**
 * Every page of an offset-paginated list, up to `maxPages` pages of 100, so a
 * huge instance cannot spin forever. Follows `X-Next-Page`; a short page also
 * ends the walk for proxies that strip the header.
 */
export async function glPaged<T>(
  ctx: GitLabContext,
  path: string,
  query: Query = {},
  maxPages = 10,
  perPage = 100,
): Promise<T[]> {
  const out: T[] = [];
  let page = 1;
  for (let i = 0; i < maxPages; i++) {
    const res = await glRequest(ctx, path, { query: { ...query, per_page: perPage, page } });
    const batch = res.text ? (JSON.parse(res.text) as T[]) : [];
    if (!Array.isArray(batch)) break;
    out.push(...batch);
    const next = res.headers["x-next-page"];
    if (next !== undefined) {
      if (!next) break;
      page = Number(next);
      if (!Number.isFinite(page)) break;
    } else {
      if (batch.length < perPage) break;
      page++;
    }
  }
  return out;
}

/**
 * The row count of a list without reading it: one row per page, reading
 * `X-Total`. GitLab omits the header above 10,000 rows, which reads as
 * `undefined` (not a count) rather than as zero.
 */
export async function glCount(
  ctx: GitLabContext,
  path: string,
  query: Query = {},
): Promise<number | undefined> {
  const res = await glRequest(ctx, path, { query: { ...query, per_page: 1, page: 1 } });
  const total = res.headers["x-total"];
  if (total === undefined || total === "") return undefined;
  const n = Number(total);
  return Number.isFinite(n) ? n : undefined;
}

/** POST a GraphQL query (Bearer auth). Field errors are returned, not thrown. */
export async function glGraphql<T>(
  ctx: GitLabContext,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<{ data?: T; errors?: Array<{ message?: string }> }> {
  const res = await glRaw(
    ctx,
    `${ctx.baseUrl}/api/graphql`,
    "POST",
    {
      Authorization: `Bearer ${ctx.token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    JSON.stringify({ query, variables }),
  );
  if (res.status < 200 || res.status >= 300) {
    throw new GitLabApiError(
      res.status,
      `GitLab API error ${res.status} for POST /api/graphql: ${errorDetail(res.text)}`,
    );
  }
  return JSON.parse(res.text) as { data?: T; errors?: Array<{ message?: string }> };
}

export const enc = encodeURIComponent;

/** Split `head/rest` at the first slash: composite external ids. */
export function splitScoped(id: string): { scope: string; rest: string } {
  const i = id.indexOf("/");
  if (i < 0) return { scope: id, rest: "" };
  return { scope: id.slice(0, i), rest: id.slice(i + 1) };
}
