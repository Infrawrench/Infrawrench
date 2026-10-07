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

/** One request; JSON parsed unless `text`. Consul errors are plain-text bodies. */
export async function consulFetch<T>(
  ctx: ConsulContext,
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
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
  if (opts.text) return text as unknown as T;
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
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
