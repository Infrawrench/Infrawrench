import type { HttpHostServices } from "@infrawrench/plugin-base";

/**
 * One Nomad HTTP API endpoint (`/v1` on any server or client agent, which
 * forwards to the leader). The ACL token goes in `X-Nomad-Token`; `region`
 * targets another federated region.
 *
 * Reference: https://developer.hashicorp.com/nomad/api-docs (Nomad 2.0,
 * hashicorp/web-unified-docs `content/nomad/v2.0.x`, read 2026-10).
 */
export interface NomadContext {
  address: string;
  token?: string;
  region?: string;
  caCert?: string;
  http?: HttpHostServices;
}

export class NomadApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "NomadApiError";
    this.status = status;
  }
}

export function statusOf(err: unknown): number {
  return err instanceof NomadApiError ? err.status : 0;
}

/** `nomad.internal` → `https://nomad.internal:4646`-style origin, minus `/v1` and `/ui`. */
export function normaliseAddress(raw: string): string {
  let value = raw.trim();
  if (!value) return "";
  if (!/^https?:\/\//i.test(value)) {
    value = `${/^(localhost|127\.)/.test(value) ? "http" : "https"}://${value}`;
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
): NomadContext {
  const address = normaliseAddress(credentials["address"] ?? "");
  if (!address) throw new Error("Nomad plugin: missing the Nomad address");
  const token = (credentials["token"] ?? "").trim();
  const region = (credentials["region"] ?? "").trim();
  const caCert = credentials["caCert"] ?? "";
  return {
    address,
    ...(token ? { token } : {}),
    ...(region ? { region } : {}),
    ...(caCert.trim() ? { caCert } : {}),
    ...(http ? { http } : {}),
  };
}

export type Query = Record<string, string | number | boolean | undefined>;

export interface RequestOptions {
  method?: string;
  query?: Query;
  body?: unknown;
  /** Return the raw response text (log endpoints). */
  text?: boolean;
}

function buildQuery(ctx: NomadContext, query: Query = {}): string {
  const params = new URLSearchParams();
  if (ctx.region && query["region"] === undefined) params.set("region", ctx.region);
  for (const [k, v] of Object.entries(query))
    if (v !== undefined && v !== "") params.set(k, String(v));
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/** One request; returns parsed JSON (or text with `text: true`). Nomad errors are plain-text bodies. */
export async function nomadFetch<T>(
  ctx: NomadContext,
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const url = `${ctx.address}/v1${path}${buildQuery(ctx, opts.query)}`;
  const method = opts.method ?? "GET";
  const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  const headers: Record<string, string> = {
    Accept: opts.text ? "text/plain" : "application/json",
    ...(ctx.token ? { "X-Nomad-Token": ctx.token } : {}),
    ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
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
      status === 403 && !ctx.token
        ? " (ACLs are enabled: add a token)"
        : status === 403
          ? " (the token's policies do not allow this)"
          : "";
    throw new NomadApiError(
      status,
      `Nomad API error ${status} for ${method} ${path}: ${text.trim().slice(0, 500)}${hint}`,
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
  if (parts.length < count) throw new NomadApiError(400, `Nomad plugin: malformed id "${id}"`);
  return parts;
}

/** Nomad timestamps are Unix nanoseconds. */
export function nsToIso(ns: number | undefined): string | undefined {
  return typeof ns === "number" && ns > 0
    ? new Date(Math.floor(ns / 1e6)).toISOString()
    : undefined;
}

/** Path segments encoded, slashes kept (variable paths). */
export function encodePath(path: string): string {
  return path
    .split("/")
    .map((s) => encodeURIComponent(s))
    .join("/");
}
