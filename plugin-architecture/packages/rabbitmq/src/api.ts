import type { HttpHostServices } from "@infrawrench/plugin-base";
import { utf8ToBase64 } from "@infrawrench/plugin-base";

/**
 * Everything one RabbitMQ management API request needs. The API lives under
 * `/api` on the management listener (15672 plain, 15671 TLS by default) and
 * takes HTTP Basic auth against the internal user store, or a bearer token
 * when the OAuth 2 plugin is enabled.
 *
 * Reference: https://www.rabbitmq.com/docs/http-api-reference (RabbitMQ 4.2,
 * read 2026-10).
 */
export interface RabbitContext {
  /** Origin plus any path prefix, no trailing slash, e.g. `https://mq.example.com:15671`. */
  baseUrl: string;
  authorization: string;
  username?: string;
  caCert?: string;
  http?: HttpHostServices;
}

export class RabbitApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "RabbitApiError";
    this.status = status;
  }
}

export function statusOf(err: unknown): number {
  return err instanceof RabbitApiError ? err.status : 0;
}

/**
 * `mq.example.com:15672/api/` → `http://mq.example.com:15672`. Without a
 * scheme the management default applies: plain HTTP on 15672, HTTPS otherwise.
 * A trailing `/api` (what people copy from the docs) is dropped; any other
 * path prefix (a reverse proxy mounting the UI under `/rabbitmq`) is kept.
 */
export function normaliseUrl(raw: string): string {
  let value = raw.trim();
  if (!value) return "";
  if (!/^https?:\/\//i.test(value)) {
    value = `${/:15672(\/|$)/.test(value) ? "http" : "https"}://${value}`;
  }
  return value
    .replace(/[#?].*$/, "")
    .replace(/\/+$/, "")
    .replace(/\/api$/i, "")
    .replace(/\/+$/, "");
}

export function errorDetail(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown; reason?: unknown };
    const parts = [parsed.error, parsed.reason]
      .filter((x) => x !== undefined && x !== null && x !== "")
      .map((x) => (typeof x === "string" ? x : JSON.stringify(x)));
    if (parts.length) return parts.join(": ");
  } catch {
    // Not JSON.
  }
  return body.slice(0, 500);
}

export type Query = Record<string, string | number | boolean | undefined>;

function buildQuery(query: Query = {}): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query))
    if (v !== undefined && v !== "") params.set(k, String(v));
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/** Percent-encode one path segment. The default vhost `/` becomes `%2F`. */
export const seg = (s: string): string => encodeURIComponent(s);

export interface RequestOptions {
  method?: string;
  query?: Query;
  body?: unknown;
  headers?: Record<string, string>;
}

export function buildContext(
  credentials: Record<string, string>,
  http?: HttpHostServices,
): RabbitContext {
  const baseUrl = normaliseUrl(credentials["url"] ?? "");
  if (!baseUrl) throw new Error("RabbitMQ plugin: missing the management API URL");
  const username = (credentials["username"] ?? "").trim();
  const password = credentials["password"] ?? "";
  const token = (credentials["token"] ?? "").trim();
  let authorization: string;
  if (token) authorization = `Bearer ${token}`;
  else if (username) authorization = `Basic ${utf8ToBase64(`${username}:${password}`)}`;
  else throw new Error("RabbitMQ plugin: enter a username and password, or an OAuth 2 token");
  const caCert = credentials["caCert"] ?? "";
  return {
    baseUrl,
    authorization,
    ...(username && !token ? { username } : {}),
    ...(caCert.trim() ? { caCert } : {}),
    ...(http ? { http } : {}),
  };
}

/**
 * One authenticated request; returns the parsed JSON body (undefined for an
 * empty 201/204). Non-2xx throws a {@link RabbitApiError} carrying the status.
 */
export async function rmqFetch<T>(
  ctx: RabbitContext,
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const url = `${ctx.baseUrl}/api${path}${buildQuery(opts.query)}`;
  const method = opts.method ?? "GET";
  const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: ctx.authorization,
    ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    ...opts.headers,
  };
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
    const hint =
      status === 401
        ? " (check the username and password; the guest user can only sign in from localhost)"
        : "";
    throw new RabbitApiError(
      status,
      `RabbitMQ API error ${status} for ${method} ${path}: ${errorDetail(text)}${hint}`,
    );
  }
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

/** A list endpoint that 404s when its plugin is disabled (shovels, federation). */
export async function rmqOptionalList<T>(ctx: RabbitContext, path: string): Promise<T[]> {
  try {
    const res = await rmqFetch<T[]>(ctx, path);
    return Array.isArray(res) ? res : [];
  } catch (err) {
    if (statusOf(err) === 404) return [];
    throw err;
  }
}

interface Page<T> {
  items?: T[];
  page?: number;
  page_count?: number;
}

/**
 * Walk a paginated list (queues, exchanges, connections, channels). The
 * documented maximum page size is 500. Stops at `max` items.
 */
export async function rmqPaged<T>(
  ctx: RabbitContext,
  path: string,
  max = 2000,
  query: Query = {},
): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; out.length < max; page++) {
    const res = await rmqFetch<Page<T> | T[]>(ctx, path, {
      query: { ...query, page, page_size: 500, pagination: true },
    });
    // Very old servers ignore the pagination params and answer a bare array.
    if (Array.isArray(res)) return res.slice(0, max);
    out.push(...(res?.items ?? []));
    if (!res?.page_count || page >= res.page_count) break;
  }
  return out.slice(0, max);
}

/** Composite ids: each part percent-encoded, joined by `/`, so vhost `/` stays unambiguous. */
export function joinId(...parts: string[]): string {
  return parts.map((p) => encodeURIComponent(p)).join("/");
}

export function splitId(id: string, count: number): string[] {
  const parts = id.split("/").map((p) => decodeURIComponent(p));
  if (parts.length < count) throw new RabbitApiError(400, `RabbitMQ plugin: malformed id "${id}"`);
  return parts;
}
