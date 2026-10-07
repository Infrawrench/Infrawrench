import type { HttpHostServices } from "@infrawrench/plugin-base";
import { utf8ToBase64 } from "@infrawrench/plugin-base";

/**
 * One Prometheus-compatible endpoint (Prometheus, Thanos Query, Mimir or
 * Cortex under `/prometheus`, VictoriaMetrics) and, optionally, an
 * Alertmanager. Both take the same auth: none, Basic, or a bearer token, plus
 * `X-Scope-OrgID` for multi-tenant Mimir/Cortex/Loki-style gateways.
 *
 * References (read 2026-10): https://prometheus.io/docs/prometheus/latest/querying/api/
 * and the Alertmanager v2 OpenAPI spec (prometheus/alertmanager api/v2/openapi.yaml).
 */
export interface PromContext {
  baseUrl: string;
  alertmanagerUrl?: string;
  headers: Record<string, string>;
  caCert?: string;
  http?: HttpHostServices;
}

export class PromApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "PromApiError";
    this.status = status;
  }
}

export function statusOf(err: unknown): number {
  return err instanceof PromApiError ? err.status : 0;
}

/** `prom:9090/graph` → `http://prom:9090`; keeps path prefixes such as Mimir's `/prometheus`. */
export function normaliseUrl(
  raw: string,
  kind: "prometheus" | "alertmanager" = "prometheus",
): string {
  let value = raw.trim();
  if (!value) return "";
  if (!/^https?:\/\//i.test(value)) {
    value = `${/:(9090|9093|8428|10902)(\/|$)/.test(value) || /^(localhost|127\.)/.test(value) ? "http" : "https"}://${value}`;
  }
  value = value.replace(/[#?].*$/, "").replace(/\/+$/, "");
  value =
    kind === "prometheus"
      ? value.replace(/\/(api\/v1|graph|query|targets|alerts|rules)$/i, "")
      : value.replace(/\/(api\/v2|api\/v1|#\/.*)$/i, "");
  return value.replace(/\/+$/, "");
}

export function buildContext(
  credentials: Record<string, string>,
  http?: HttpHostServices,
): PromContext {
  const baseUrl = normaliseUrl(credentials["url"] ?? "");
  if (!baseUrl) throw new Error("Prometheus plugin: missing the Prometheus URL");
  const am = normaliseUrl(credentials["alertmanagerUrl"] ?? "", "alertmanager");
  const token = (credentials["token"] ?? "").trim();
  const username = (credentials["username"] ?? "").trim();
  const tenant = (credentials["tenantId"] ?? "").trim();
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  else if (username)
    headers["Authorization"] =
      `Basic ${utf8ToBase64(`${username}:${credentials["password"] ?? ""}`)}`;
  if (tenant) headers["X-Scope-OrgID"] = tenant;
  const caCert = credentials["caCert"] ?? "";
  return {
    baseUrl,
    ...(am ? { alertmanagerUrl: am } : {}),
    headers,
    ...(caCert.trim() ? { caCert } : {}),
    ...(http ? { http } : {}),
  };
}

export type Query = Record<string, string | number | boolean | string[] | undefined>;

export function buildQuery(query: Query = {}): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === "") continue;
    if (Array.isArray(v)) for (const item of v) params.append(k, item);
    else params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export interface RequestOptions {
  method?: string;
  query?: Query;
  body?: unknown;
  /** Send `query` as an x-www-form-urlencoded body (long PromQL stays out of the URL). */
  form?: boolean;
}

function detail(text: string): string {
  try {
    const p = JSON.parse(text) as { error?: string; errorType?: string; message?: string };
    if (p.error) return p.errorType ? `${p.errorType}: ${p.error}` : p.error;
    if (p.message) return p.message;
  } catch {
    // Not JSON.
  }
  return text.slice(0, 500);
}

async function raw(
  ctx: PromContext,
  url: string,
  opts: RequestOptions,
): Promise<{ status: number; text: string }> {
  const method = opts.method ?? "GET";
  let body: string | undefined;
  const headers: Record<string, string> = { Accept: "application/json", ...ctx.headers };
  if (opts.form) {
    body = buildQuery(opts.query).replace(/^\?/, "");
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  } else {
    url += buildQuery(opts.query);
    if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      headers["Content-Type"] = "application/json";
    }
  }
  if (ctx.http) {
    const res = await ctx.http.request({
      url,
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
    });
    return { status: res.status, text: res.body };
  }
  const res = await fetch(url, { method, headers, ...(body !== undefined ? { body } : {}) });
  return { status: res.status, text: await res.text() };
}

function hint(status: number): string {
  if (status === 401) return " (check the username and password or token)";
  if (status === 404) return " (this server does not offer this endpoint)";
  return "";
}

/**
 * A Prometheus API call: unwraps `{status: "success", data}` and turns
 * `{status: "error", errorType, error}` (sent with 400/422/503) into a
 * {@link PromApiError}.
 */
export async function promFetch<T>(
  ctx: PromContext,
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const res = await raw(ctx, `${ctx.baseUrl}${path}`, opts);
  if (res.status < 200 || res.status >= 300) {
    throw new PromApiError(
      res.status,
      `Prometheus API error ${res.status} for ${path}: ${detail(res.text)}${hint(res.status)}`,
    );
  }
  if (!res.text) return undefined as T;
  let parsed: { status?: string; data?: T; error?: string; errorType?: string };
  try {
    parsed = JSON.parse(res.text) as typeof parsed;
  } catch {
    return res.text as unknown as T;
  }
  if (parsed && parsed.status === "error") {
    throw new PromApiError(
      422,
      `Prometheus: ${parsed.errorType ?? "error"}: ${parsed.error ?? ""}`,
    );
  }
  return (parsed && "data" in parsed ? parsed.data : parsed) as T;
}

/** An Alertmanager v2 call. Throws a clear 400 when no Alertmanager URL is configured. */
export async function amFetch<T>(
  ctx: PromContext,
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  if (!ctx.alertmanagerUrl) {
    throw new PromApiError(
      400,
      "Prometheus plugin: add an Alertmanager URL to this account to manage silences",
    );
  }
  const res = await raw(ctx, `${ctx.alertmanagerUrl}/api/v2${path}`, opts);
  if (res.status < 200 || res.status >= 300) {
    throw new PromApiError(
      res.status,
      `Alertmanager API error ${res.status} for ${path}: ${detail(res.text)}${hint(res.status)}`,
    );
  }
  if (!res.text) return undefined as T;
  try {
    return JSON.parse(res.text) as T;
  } catch {
    return res.text as unknown as T;
  }
}

export function joinId(...parts: string[]): string {
  return parts.map((p) => encodeURIComponent(p)).join("/");
}

export function splitId(id: string, count: number): string[] {
  const parts = id.split("/").map((p) => decodeURIComponent(p));
  if (parts.length < count) throw new PromApiError(400, `Prometheus plugin: malformed id "${id}"`);
  return parts;
}

/** Stable short id for a label set (FNV-1a over the sorted pairs). */
export function labelsKey(labels: Record<string, string> | undefined): string {
  const s = Object.entries(labels ?? {})
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\u0000");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function labelText(labels: Record<string, string> | undefined, skip: string[] = []): string {
  return Object.entries(labels ?? {})
    .filter(([k]) => !skip.includes(k))
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}="${v}"`)
    .join(", ");
}

/** Escape a value for use inside a PromQL `"..."` label matcher. */
export function promString(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}
