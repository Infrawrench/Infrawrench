import type { HttpHostServices } from "@infrawrench/plugin-base";

/**
 * Supabase Management API (`https://api.supabase.com/v1`, OpenAPI document at
 * `https://api.supabase.com/api/v1-json`; verified 2026-10).
 *
 * Auth is a personal access token (`sbp_…`, classic or scoped) sent as a
 * Bearer token. The documented limit is 120 requests a minute per user and
 * per project/organization scope, with the analytics endpoints (logs, usage
 * counts) capped far lower (10-30 a minute), which is why logs and metrics
 * are only fetched on demand.
 *
 * The Storage API (bucket create/update/delete, object browser) is not part
 * of the Management API: it lives on the project's own gateway at
 * `https://{ref}.supabase.co/storage/v1` and authenticates with one of the
 * project's secret API keys, which this layer reads through the Management
 * API so the user never has to paste one.
 */
export const SUPABASE_API = "https://api.supabase.com";

export interface SupabaseContext {
  token: string;
  http?: HttpHostServices;
  /** Overridable for tests; production always uses {@link SUPABASE_API}. */
  baseUrl?: string;
  caCert?: string;
}

/** Thrown for any non-2xx answer, carrying the status the poller classifies on. */
export class SupabaseApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "SupabaseApiError";
    this.status = status;
  }
}

/** HTTP status of a failed call, or 0 for a transport error. */
export function statusOf(err: unknown): number {
  if (err instanceof SupabaseApiError) return err.status;
  if (typeof err === "object" && err !== null && "status" in err) {
    const status = (err as { status: unknown }).status;
    return typeof status === "number" ? status : 0;
  }
  return 0;
}

export type Query = Record<string, string | number | boolean | undefined>;

export interface RawRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string | Uint8Array;
}

export interface RawResponse {
  status: number;
  body: string;
}

/** One HTTP round trip, through the host's HTTP service whenever there is one. */
export async function rawRequest(ctx: SupabaseContext, req: RawRequest): Promise<RawResponse> {
  if (ctx.http) {
    const res = await ctx.http.request({
      url: req.url,
      method: req.method,
      headers: req.headers,
      ...(req.body !== undefined ? { body: req.body } : {}),
      ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
    });
    return { status: res.status, body: res.body };
  }
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    ...(req.body !== undefined ? { body: req.body as BodyInit } : {}),
  });
  return { status: res.status, body: await res.text() };
}

function withQuery(url: string, query?: Query): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== "") params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${url}${url.includes("?") ? "&" : "?"}${qs}` : url;
}

/** JSON request against the Management API. Returns `undefined` for an empty body. */
export async function sbFetch<T>(
  ctx: SupabaseContext,
  method: string,
  path: string,
  body?: unknown,
  query?: Query,
): Promise<T> {
  const res = await rawRequest(ctx, {
    method,
    url: withQuery(`${ctx.baseUrl ?? SUPABASE_API}${path}`, query),
    headers: {
      Authorization: `Bearer ${ctx.token}`,
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return parseResponse<T>(res, path);
}

/** Multipart (or other raw-body) request against the Management API. */
export async function sbFetchRaw<T>(
  ctx: SupabaseContext,
  method: string,
  path: string,
  contentType: string,
  body: Uint8Array,
  query?: Query,
): Promise<T> {
  const res = await rawRequest(ctx, {
    method,
    url: withQuery(`${ctx.baseUrl ?? SUPABASE_API}${path}`, query),
    headers: {
      Authorization: `Bearer ${ctx.token}`,
      Accept: "application/json",
      "Content-Type": contentType,
    },
    body,
  });
  return parseResponse<T>(res, path);
}

/** Text request (the Prometheus scrape endpoint answers text/plain). */
export async function sbFetchText(ctx: SupabaseContext, path: string): Promise<string> {
  const res = await rawRequest(ctx, {
    method: "GET",
    url: `${ctx.baseUrl ?? SUPABASE_API}${path}`,
    headers: { Authorization: `Bearer ${ctx.token}`, Accept: "text/plain" },
  });
  if (res.status < 200 || res.status >= 300) {
    throw new SupabaseApiError(res.status, friendlyError(res.status, path, res.body));
  }
  return res.body;
}

export function parseResponse<T>(res: RawResponse, path: string): T {
  if (res.status < 200 || res.status >= 300) {
    throw new SupabaseApiError(res.status, friendlyError(res.status, path, res.body));
  }
  if (!res.body) return undefined as T;
  try {
    return JSON.parse(res.body) as T;
  } catch {
    return res.body as unknown as T;
  }
}

/** Turn an error body into a sentence, keeping Supabase's own `message`. */
export function friendlyError(status: number, path: string, raw: string): string {
  let detail = "";
  try {
    const parsed = JSON.parse(raw) as { message?: unknown; error?: unknown; msg?: unknown };
    const candidate = parsed.message ?? parsed.msg ?? parsed.error;
    if (typeof candidate === "string") detail = candidate;
    else if (candidate && typeof candidate === "object" && "message" in candidate) {
      detail = String((candidate as { message: unknown }).message);
    }
  } catch {
    detail = raw.slice(0, 300);
  }
  if (status === 401) {
    return "Supabase API error 401: the access token was rejected. Create a new token at supabase.com/dashboard/account/tokens and update the account.";
  }
  if (status === 403 && !detail) {
    return `Supabase API error 403 for ${path}: the access token's scopes do not allow this call.`;
  }
  if (status === 429) {
    return `Supabase API error 429 for ${path}: rate limited (120 requests a minute per project, far fewer for logs and analytics). Try again shortly.`;
  }
  return `Supabase API error ${status} for ${path}${detail ? `: ${detail}` : ""}`;
}

/** URL of a project's own API gateway. */
export function projectUrl(ref: string): string {
  return `https://${ref}.supabase.co`;
}

/** Path-segment encoding. */
export function enc(s: string): string {
  return encodeURIComponent(s);
}
