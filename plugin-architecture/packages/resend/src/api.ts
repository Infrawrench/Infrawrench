import type { HttpHostServices } from "@infrawrench/plugin-base";

/**
 * Resend REST API (https://resend.com/docs/api-reference, OpenAPI spec at
 * https://github.com/resend/resend-openapi `resend.json`, version 1.5.1,
 * verified 2026-10).
 *
 * - One host, `api.resend.com`, Bearer auth with an `re_…` API key.
 * - JSON bodies; updates are `PATCH`.
 * - Lists page with `limit` (1–100) and an `after=<last id>` cursor, and say
 *   `has_more`.
 * - Errors are `{ statusCode, message, name }`. A malformed key answers 400
 *   `validation_error`; a sending-access key answers 401 `restricted_api_key`
 *   on anything but sending.
 * - The default rate limit is 10 requests a second per team, shared across
 *   keys; a 429 carries `retry-after` (seconds), which this client honours.
 * - `api.resend.com` sends no CORS headers, so the desktop renderer must use
 *   the host HTTP service.
 */
export const API_BASE = "https://api.resend.com";
export const DASHBOARD_BASE = "https://resend.com";

export interface ResendContext {
  apiKey: string;
  http?: HttpHostServices;
  caCert?: string;
  /** Injected in tests so 429 back-off does not actually wait. */
  sleep?: (ms: number) => Promise<void>;
}

export class ResendApiError extends Error {
  readonly status: number;
  /** Resend's error `name` (`validation_error`, `restricted_api_key`, …). */
  readonly errorName: string;
  constructor(status: number, message: string, errorName = "") {
    super(message);
    this.name = "ResendApiError";
    this.status = status;
    this.errorName = errorName;
  }
}

export function statusOf(err: unknown): number {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : 0;
}

/** The key is a sending-access key, or lacks scope for this call. */
export function isRestrictedKey(err: unknown): boolean {
  return (
    err instanceof ResendApiError &&
    (err.errorName === "restricted_api_key" || err.errorName === "invalid_permission")
  );
}

export type Query = Record<string, string | number | boolean | undefined | string[]>;

export function buildQuery(query: Query = {}): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === "") continue;
    if (Array.isArray(v)) {
      if (v.length > 0) params.set(k, v.join(","));
    } else params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

function parseError(text: string): { message: string; name: string } {
  try {
    const parsed = JSON.parse(text) as { message?: unknown; name?: unknown };
    if (typeof parsed.message === "string") {
      return { message: parsed.message, name: typeof parsed.name === "string" ? parsed.name : "" };
    }
  } catch {
    // Not JSON.
  }
  return { message: text.slice(0, 500), name: "" };
}

export interface RequestOptions {
  method?: string;
  query?: Query;
  body?: unknown;
}

const MAX_RETRIES = 3;

export async function resendFetch<T>(
  ctx: ResendContext,
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const url = `${API_BASE}${path}${buildQuery(opts.query)}`;
  const method = opts.method ?? "GET";
  const headers: Record<string, string> = {
    Authorization: `Bearer ${ctx.apiKey}`,
    Accept: "application/json",
  };
  const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  for (let attempt = 0; ; attempt++) {
    let status: number;
    let text: string;
    let retryAfter: string | undefined;
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
      retryAfter = res.headers["retry-after"] ?? res.headers["Retry-After"];
    } else {
      const res = await fetch(url, { method, headers, ...(body !== undefined ? { body } : {}) });
      status = res.status;
      text = await res.text();
      retryAfter = res.headers.get("retry-after") ?? undefined;
    }
    if (status === 429 && attempt < MAX_RETRIES) {
      const { name } = parseError(text);
      // Quota errors do not clear by waiting a second.
      if (name !== "daily_quota_exceeded" && name !== "monthly_quota_exceeded") {
        const seconds = Number(retryAfter);
        await sleep(Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 10) * 1000 : 1000);
        continue;
      }
    }
    if (status < 200 || status >= 300) {
      const { message, name } = parseError(text);
      throw new ResendApiError(status, `Resend API error ${status} for ${path}: ${message}`, name);
    }
    return (status === 204 || !text ? undefined : JSON.parse(text)) as T;
  }
}

interface Page<T> {
  data?: T[];
  has_more?: boolean;
}

/** Every page of a cursor list, up to `maxPages` × 100 items. */
export async function listAll<T extends { id?: string }>(
  ctx: ResendContext,
  path: string,
  query: Query = {},
  maxPages = 10,
): Promise<T[]> {
  const out: T[] = [];
  let after: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const res = await resendFetch<Page<T>>(ctx, path, {
      query: { limit: 100, ...query, ...(after ? { after } : {}) },
    });
    const data = res?.data ?? [];
    out.push(...data);
    const last = data[data.length - 1]?.id;
    if (!res?.has_more || !last) break;
    after = last;
  }
  return out;
}
