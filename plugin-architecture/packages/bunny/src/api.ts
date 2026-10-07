import type { HttpHostServices } from "@infrawrench/plugin-base";

/**
 * bunny.net transport. Three hosts, one account API key (Account settings →
 * API key) sent as the `AccessKey` header:
 * - Core API `https://api.bunny.net` (pull zones, storage zones, DNS, Stream
 *   libraries, statistics, billing; spec
 *   core-api-public-docs.b-cdn.net/docs/v3/public.json) and the Edge
 *   Scripting endpoints under `/compute` (…/v3/compute.json).
 * - Magic Containers `https://api.bunny.net/mc` (api-mc.opsbunny.net/docs/
 *   public/swagger.json), camelCase JSON.
 * - Edge Storage `https://{StorageHostname}/{zone}/{path}`, where `AccessKey`
 *   is the storage zone's own password, not the account key.
 * Errors are `{ErrorKey, Field, Message}`. Verified 2026-10.
 */

export const API_BASE = "https://api.bunny.net";

export interface BunnyContext {
  apiKey: string;
  caCert?: string;
  http?: HttpHostServices;
}

export class BunnyApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "BunnyApiError";
    this.status = status;
  }
}

export function statusOf(err: unknown): number {
  if (err && typeof err === "object" && "status" in err) {
    const s = (err as { status: unknown }).status;
    return typeof s === "number" ? s : 0;
  }
  return 0;
}

type Query = Record<string, string | number | boolean | undefined>;

export interface RawResponse {
  status: number;
  body: string;
}

function withQuery(url: string, query?: Query): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {}))
    if (v !== undefined && v !== "") p.set(k, String(v));
  const qs = p.toString();
  return qs ? `${url}${url.includes("?") ? "&" : "?"}${qs}` : url;
}

function errorText(body: string): string {
  try {
    const p = JSON.parse(body) as {
      Message?: string;
      message?: string;
      ErrorKey?: string;
      title?: string;
      detail?: string;
    };
    return p.Message ?? p.message ?? p.detail ?? p.title ?? p.ErrorKey ?? body.slice(0, 300);
  } catch {
    return body.slice(0, 300);
  }
}

/** One request through the host HTTP service when there is one, else `fetch`. */
export async function bunnyRaw(
  ctx: BunnyContext,
  url: string,
  init: {
    method?: string;
    query?: Query;
    json?: unknown;
    body?: string | Uint8Array;
    headers?: Record<string, string>;
    accessKey?: string;
  } = {},
): Promise<RawResponse> {
  const method = init.method ?? "GET";
  const full = withQuery(url, init.query);
  const headers: Record<string, string> = {
    Accept: "application/json",
    AccessKey: init.accessKey ?? ctx.apiKey,
    ...(init.headers ?? {}),
  };
  let body: string | Uint8Array | undefined = init.body;
  if (init.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.json);
  }
  let status: number;
  let text: string;
  if (ctx.http) {
    const res = await ctx.http.request({
      url: full,
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
    });
    status = res.status;
    text = res.body;
  } else {
    const res = await fetch(full, {
      method,
      headers,
      ...(body !== undefined ? { body: body as BodyInit } : {}),
    });
    status = res.status;
    text = await res.text();
  }
  if (status < 200 || status >= 300) {
    const path = new URL(full).pathname;
    throw new BunnyApiError(
      status,
      `bunny.net API error ${status} for ${path}: ${errorText(text)}`,
    );
  }
  return { status, body: text };
}

export async function bunnyFetch<T>(
  ctx: BunnyContext,
  path: string,
  init: { method?: string; query?: Query; json?: unknown } = {},
): Promise<T> {
  const res = await bunnyRaw(ctx, `${API_BASE}${path}`, init);
  return (res.body ? JSON.parse(res.body) : undefined) as T;
}

/** `{Items, CurrentPage, TotalItems, HasMoreItems}` listings. */
export async function bunnyPaged<T>(
  ctx: BunnyContext,
  path: string,
  query: Query = {},
  maxPages = 50,
): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = await bunnyFetch<{ Items?: T[]; HasMoreItems?: boolean } | T[]>(ctx, path, {
      query: { ...query, page, perPage: 1000 },
    });
    if (Array.isArray(res)) return [...out, ...res];
    out.push(...(res?.Items ?? []));
    if (!res?.HasMoreItems) break;
  }
  return out;
}

/** Magic Containers' cursor listing (`items`, `cursor`). */
export async function mcPaged<T>(ctx: BunnyContext, path: string, maxPages = 50): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const res = await bunnyFetch<{ items?: T[]; cursor?: string | null }>(ctx, `/mc${path}`, {
      query: { limit: 100, ...(cursor ? { nextCursor: cursor } : {}) },
    });
    out.push(...(res?.items ?? []));
    cursor = res?.cursor ?? undefined;
    if (!cursor || (res?.items ?? []).length === 0) break;
  }
  return out;
}

/**
 * Bunny charts are `{ "2026-10-01T00:00:00Z": value, … }`. Magic Containers
 * charts are not described in its spec beyond "object", so arrays of
 * `{x|timestamp|date, y|value}` points are accepted too.
 */
export function chartPoints(chart: unknown): Array<{ timestamp: number; value: number }> {
  const parse = (k: string) =>
    Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(k) || !/T/.test(k) ? k : `${k}Z`);
  let pts: Array<{ timestamp: number; value: number }> = [];
  if (Array.isArray(chart)) {
    pts = chart.map((p) => {
      const o = (p ?? {}) as Record<string, unknown>;
      const t = o["timestamp"] ?? o["x"] ?? o["date"] ?? o["time"];
      return {
        timestamp: typeof t === "number" ? t : parse(String(t)),
        value: Number(o["value"] ?? o["y"]),
      };
    });
  } else if (chart && typeof chart === "object") {
    pts = Object.entries(chart as Record<string, unknown>).map(([k, v]) => ({
      timestamp: parse(k),
      value: Number(v),
    }));
  }
  return pts
    .filter((p) => Number.isFinite(p.timestamp) && Number.isFinite(p.value))
    .sort((a, b) => a.timestamp - b.timestamp);
}
