import type { HttpHostServices } from "@infrawrench/plugin-base";

/**
 * CircleCI REST API v2 (https://circleci.com/docs/api/v2/, spec at
 * https://circleci.com/api/v2/openapi.json, verified 2026-10).
 *
 * Every request carries the personal API token in the `Circle-Token` header.
 * The self-hosted runner API lives on its own host
 * (`runner.circleci.com/api/v3`) and takes the same token and header; API v3
 * takes it as a Bearer token instead.
 */
export const API_BASE = "https://circleci.com/api/v2";
/**
 * API v3 (https://circleci.com/docs/api/v3/): the only documented way to list
 * an organization's projects and to manage runner resource classes and
 * tokens. Bearer auth only, `{data: …}` envelopes, `page[cursor]` paging.
 */
export const API_V3_BASE = "https://circleci.com/api/v3";
export const RUNNER_API_BASE = "https://runner.circleci.com/api/v3";
export const APP_BASE = "https://app.circleci.com";

/**
 * Everything a CircleCI request needs. Split out of the client so the cost
 * collector, the organization picker and the tests can run without one.
 */
export interface CircleContext {
  token: string;
  http?: HttpHostServices;
}

/** Thrown for any non-2xx answer, carrying the status callers branch on. */
export class CircleApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "CircleApiError";
    this.status = status;
  }
}

/** HTTP status of a failed call, or 0 for a transport error. */
export function statusOf(err: unknown): number {
  return err instanceof CircleApiError ? err.status : 0;
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

function errorDetail(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      message?: unknown;
      error?: { title?: unknown; detail?: unknown };
    };
    if (typeof parsed.message === "string") return parsed.message;
    if (typeof parsed.error?.detail === "string") return parsed.error.detail;
    if (typeof parsed.error?.title === "string") return parsed.error.title;
  } catch {
    // Not JSON: fall through to the raw body.
  }
  return body.slice(0, 500);
}

export interface RequestOptions {
  method?: string;
  query?: Query;
  body?: unknown;
  /** Defaults to the v2 API; the runner API passes {@link RUNNER_API_BASE}. */
  baseUrl?: string;
}

/**
 * One request with the token in `Circle-Token`. Routed through the host HTTP
 * service whenever there is one: that is the only path that honours bastion
 * egress.
 */
export async function circleFetch<T>(
  ctx: CircleContext,
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const base = (opts.baseUrl ?? API_BASE).replace(/\/+$/, "");
  const url = `${base}${path}${buildQuery(opts.query)}`;
  const method = opts.method ?? "GET";
  const headers: Record<string, string> = { Accept: "application/json" };
  if (base.startsWith(API_V3_BASE)) headers["Authorization"] = `Bearer ${ctx.token}`;
  else headers["Circle-Token"] = ctx.token;
  const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let status: number;
  let text: string;
  if (ctx.http) {
    const res = await ctx.http.request({
      url,
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
    });
    status = res.status;
    text = res.body;
  } else {
    const res = await fetch(url, { method, headers, ...(body !== undefined ? { body } : {}) });
    status = res.status;
    text = await res.text();
  }
  if (status < 200 || status >= 300) {
    throw new CircleApiError(
      status,
      `CircleCI API error ${status} for ${path}: ${errorDetail(text)}`,
    );
  }
  return (status === 204 || !text ? undefined : JSON.parse(text)) as T;
}

interface Page<T> {
  items?: T[];
  next_page_token?: string | null;
}

/**
 * Every page of a `next_page_token`-paginated v2 list, up to `maxPages`, so a
 * misbehaving cursor cannot spin forever.
 */
export async function circlePaged<T>(
  ctx: CircleContext,
  path: string,
  query: Query = {},
  maxPages = 10,
  opts: { baseUrl?: string } = {},
): Promise<T[]> {
  const out: T[] = [];
  let token: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const res = await circleFetch<Page<T>>(ctx, path, {
      query: { ...query, ...(token ? { "page-token": token } : {}) },
      ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
    });
    out.push(...(Array.isArray(res?.items) ? res.items : []));
    token = res?.next_page_token ?? undefined;
    if (!token) break;
  }
  return out;
}

interface V3Page<T> {
  data?: T[];
  page?: { next?: string | null };
}

/** Every page of a v3 list (`page[cursor]`), up to `maxPages`. */
export async function circleV3Paged<T>(
  ctx: CircleContext,
  path: string,
  query: Query = {},
  maxPages = 20,
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const res = await circleFetch<V3Page<T>>(ctx, path, {
      baseUrl: API_V3_BASE,
      query: { ...query, ...(cursor ? { "page[cursor]": cursor } : {}) },
    });
    out.push(...(Array.isArray(res?.data) ? res.data : []));
    cursor = res?.page?.next ?? undefined;
    if (!cursor) break;
  }
  return out;
}

/** One v3 call, unwrapping the `{data}` envelope. */
export async function circleV3<T>(
  ctx: CircleContext,
  path: string,
  opts: Omit<RequestOptions, "baseUrl"> = {},
): Promise<T | undefined> {
  const res = await circleFetch<{ data?: T } | undefined>(ctx, path, {
    ...opts,
    baseUrl: API_V3_BASE,
  });
  return res?.data;
}

/**
 * Download a usage export file (a presigned object-store URL, no token). The
 * files are gzip-compressed CSV; decompress when the bytes say so, since a
 * transparent `Content-Encoding` may already have done it.
 */
export async function downloadExport(ctx: CircleContext, url: string): Promise<string> {
  let bytes: Uint8Array;
  if (ctx.http) {
    const res = await ctx.http.request({
      url,
      method: "GET",
      headers: {},
      responseEncoding: "binary",
    });
    if (res.status < 200 || res.status >= 300) {
      throw new CircleApiError(res.status, `CircleCI usage export download failed (${res.status})`);
    }
    bytes = res.rawBody ?? new TextEncoder().encode(res.body);
  } else {
    const res = await fetch(url);
    if (!res.ok) {
      throw new CircleApiError(res.status, `CircleCI usage export download failed (${res.status})`);
    }
    bytes = new Uint8Array(await res.arrayBuffer());
  }
  return gunzipIfNeeded(bytes);
}

/** Decode bytes as UTF-8, gunzipping first when they carry the gzip magic number. */
export async function gunzipIfNeeded(bytes: Uint8Array): Promise<string> {
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([bytes as BlobPart])
      .stream()
      .pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).text();
  }
  return new TextDecoder().decode(bytes);
}
