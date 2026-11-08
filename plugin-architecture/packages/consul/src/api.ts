import type { HttpHostServices } from "@infrawrench/plugin-base";

/**
 * One Consul HTTP API endpoint (`/v1` on any agent). The ACL token goes in
 * `X-Consul-Token`; `dc` targets another datacenter, and on Consul
 * Enterprise `ns` and `partition` scope requests.
 *
 * Reference: https://developer.hashicorp.com/consul/api-docs
 * (hashicorp/web-unified-docs `content/consul/v2.0.x`, read 2026-10).
 */
export interface ConsulContext {
  address: string;
  token?: string;
  datacenter?: string;
  namespace?: string;
  partition?: string;
  caCert?: string;
  http?: HttpHostServices;
}

export class ConsulApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ConsulApiError";
    this.status = status;
  }
}

export function statusOf(err: unknown): number {
  return err instanceof ConsulApiError ? err.status : 0;
}

/**
 * A token Consul knows, refused this read. A token it does not know is also a 403, with
 * the body "ACL not found", and that is a bad credential rather than a narrow one.
 */
export function isPermissionRefused(err: unknown): boolean {
  return statusOf(err) === 403 && err instanceof Error && /permission ?denied/i.test(err.message);
}

/** `consul.internal:8500/ui/` → `http://consul.internal:8500`. Without a scheme, 8500 is HTTP and anything else HTTPS. */
export function normaliseAddress(raw: string): string {
  let value = raw.trim();
  if (!value) return "";
  if (!/^https?:\/\//i.test(value)) {
    value = `${/:8500(\/|$)/.test(value) || /^(localhost|127\.)/.test(value) ? "http" : "https"}://${value}`;
  }
  return value
    .replace(/[#?].*$/, "")
    .replace(/\/+$/, "")
    .replace(/\/(v1|ui)(\/.*)?$/i, "")
    .replace(/\/+$/, "");
}

export function buildContext(
  credentials: Record<string, string>,
  http?: HttpHostServices,
): ConsulContext {
  const address = normaliseAddress(credentials["address"] ?? "");
  if (!address) throw new Error("Consul plugin: missing the Consul address");
  const t = (k: string) => (credentials[k] ?? "").trim();
  const caCert = credentials["caCert"] ?? "";
  return {
    address,
    ...(t("token") ? { token: t("token") } : {}),
    ...(t("datacenter") ? { datacenter: t("datacenter") } : {}),
    ...(t("namespace") ? { namespace: t("namespace") } : {}),
    ...(t("partition") ? { partition: t("partition") } : {}),
    ...(caCert.trim() ? { caCert } : {}),
    ...(http ? { http } : {}),
  };
}

export type Query = Record<string, string | number | boolean | undefined>;

export interface RequestOptions {
  method?: string;
  query?: Query;
  /** JSON body. */
  body?: unknown;
  /** Raw body sent as-is (KV values). */
  raw?: string;
  /** Return the response text unparsed (`?raw` KV reads). */
  text?: boolean;
  /** Leave out the account's dc/ns/partition scoping (cluster-wide calls). */
  unscoped?: boolean;
}

function buildQuery(ctx: ConsulContext, opts: RequestOptions): string {
  const params = new URLSearchParams();
  if (!opts.unscoped) {
    if (ctx.datacenter) params.set("dc", ctx.datacenter);
    if (ctx.namespace) params.set("ns", ctx.namespace);
    if (ctx.partition) params.set("partition", ctx.partition);
  }
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v === undefined) continue;
    // Flag parameters (`?keys`, `?raw`, `?recurse`) are sent bare.
    if (v === true) params.set(k, "");
    else if (v !== false && v !== "") params.set(k, String(v));
  }
  const qs = params.toString().replace(/=(&|$)/g, "$1");
  return qs ? `?${qs}` : "";
}

/**
 * The header Consul sets, as of 1.11, on a list it answered with some rows left out
 * because the token may not read them. It is only sent for a request carrying a real,
 * non-anonymous token, and only when rows were left out, so its absence says nothing
 * for a request with no token.
 * https://developer.hashicorp.com/consul/api-docs/api-structure#results-filtered-by-acls
 */
const FILTERED_BY_ACLS = "x-consul-results-filtered-by-acls";

/** What {@link consulRequest} answers: the body, and what the response headers said about it. */
export interface ConsulResponse<T> {
  body: T;
  /** Consul left rows out of this list because the token's ACLs do not cover them. */
  filteredByAcls: boolean;
}

/** Response header names are case-insensitive, and Consul's own example writes `...-Acls`. */
function headerIn(headers: Record<string, string>, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === name) return value;
  return undefined;
}

/** One request; JSON parsed unless `text`. Consul errors are plain-text bodies. */
export async function consulRequest<T>(
  ctx: ConsulContext,
  path: string,
  opts: RequestOptions = {},
): Promise<ConsulResponse<T>> {
  const url = `${ctx.address}/v1${path}${buildQuery(ctx, opts)}`;
  const method = opts.method ?? "GET";
  const body =
    opts.raw !== undefined
      ? opts.raw
      : opts.body === undefined
        ? undefined
        : JSON.stringify(opts.body);
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(ctx.token ? { "X-Consul-Token": ctx.token } : {}),
    ...(body !== undefined
      ? { "Content-Type": opts.raw !== undefined ? "application/octet-stream" : "application/json" }
      : {}),
  };
  let status: number;
  let text: string;
  let filtered: string | undefined;
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
    filtered = headerIn(res.headers ?? {}, FILTERED_BY_ACLS);
  } else {
    const res = await fetch(url, { method, headers, ...(body !== undefined ? { body } : {}) });
    status = res.status;
    text = await res.text();
    filtered = res.headers.get(FILTERED_BY_ACLS) ?? undefined;
  }
  if (status < 200 || status >= 300) {
    const hint =
      status === 403
        ? ctx.token
          ? " (the token's policies do not allow this)"
          : " (ACLs are enabled: add a token)"
        : "";
    throw new ConsulApiError(
      status,
      `Consul API error ${status} for ${method} ${path}: ${text.trim().slice(0, 500)}${hint}`,
    );
  }
  const filteredByAcls = filtered?.trim().toLowerCase() === "true";
  if (opts.text) return { body: text as unknown as T, filteredByAcls };
  if (!text) return { body: undefined as T, filteredByAcls };
  try {
    return { body: JSON.parse(text) as T, filteredByAcls };
  } catch {
    return { body: text as unknown as T, filteredByAcls };
  }
}

/** {@link consulRequest} for a caller that only wants the body. */
export async function consulFetch<T>(
  ctx: ConsulContext,
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  return (await consulRequest<T>(ctx, path, opts)).body;
}

export function joinId(...parts: string[]): string {
  return parts.map((p) => encodeURIComponent(p)).join("/");
}

export function splitId(id: string, count: number): string[] {
  const parts = id.split("/").map((p) => decodeURIComponent(p));
  if (parts.length < count) throw new ConsulApiError(400, `Consul plugin: malformed id "${id}"`);
  return parts;
}

/** Encode each segment of a KV key, keeping the slashes. */
export function encodeKey(key: string): string {
  return key
    .split("/")
    .map((s) => encodeURIComponent(s))
    .join("/");
}
