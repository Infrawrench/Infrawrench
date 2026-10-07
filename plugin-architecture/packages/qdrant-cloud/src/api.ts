import type { HostServices } from "@infrawrench/plugin-base";

/**
 * Transport for the Qdrant Cloud public API (REST/JSON gateway of the gRPC
 * services in github.com/qdrant/qdrant-cloud-public-api, verified 2026-10).
 *
 * - Management API at `https://api.cloud.qdrant.io/api/<service>/v1/...`,
 *   authenticated with a Cloud Management Key as
 *   `Authorization: apikey <key>`. Every route is scoped to an account id.
 * - Each cluster's own database REST API at `<endpoint url>:6333`,
 *   authenticated with a *database* API key in the `api-key` header. The
 *   management key does not work there; the plugin mints a database key on
 *   request and keeps it in the host's secret store.
 *
 * Errors come back as gRPC status JSON (`{code, message, details}`); the
 * HTTP status is what the poller classifies on.
 */

export const API_HOST = "https://api.cloud.qdrant.io";

export class QdrantApiError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, path: string, body: string) {
    super(`Qdrant Cloud API error ${status} for ${path}: ${summarizeBody(body)}`);
    this.name = "QdrantApiError";
    this.status = status;
    this.body = body;
  }
}

/** gRPC-gateway errors are `{code, message}`; the database API uses `{status: {error}}`. */
export function summarizeBody(body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: unknown; status?: unknown };
    if (typeof parsed.message === "string" && parsed.message) return parsed.message;
    if (parsed.status && typeof parsed.status === "object") {
      const e = (parsed.status as { error?: unknown }).error;
      if (typeof e === "string" && e) return e;
    }
  } catch {
    /* not JSON */
  }
  return body.slice(0, 500);
}

export type QueryValue = string | number | boolean | undefined | null;

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Record<string, QueryValue>;
  body?: unknown;
}

export function buildQuery(query: Record<string, QueryValue> | undefined): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    params.append(key, String(value));
  }
  return params.toString();
}

export class QdrantApi {
  constructor(
    private readonly apiKey: string,
    private readonly caCert: string,
    private readonly services: HostServices | undefined,
  ) {}

  private async send(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: string | undefined,
  ): Promise<{ status: number; body: string }> {
    const http = this.services?.http;
    if (http) {
      const res = await http.request({
        url,
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        ...(this.caCert ? { caCert: this.caCert } : {}),
      });
      return { status: res.status, body: res.body ?? "" };
    }
    const res = await fetch(url, { method, headers, ...(body !== undefined ? { body } : {}) });
    return { status: res.status, body: await res.text() };
  }

  private async raw<T>(
    base: string,
    path: string,
    auth: Record<string, string>,
    opts: RequestOptions,
  ): Promise<T> {
    const method = opts.method ?? "GET";
    const query = buildQuery(opts.query);
    const url = `${base}${path}${query ? `?${query}` : ""}`;
    const headers: Record<string, string> = { Accept: "application/json", ...auth };
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await this.send(url, method, headers, body);
    if (res.status < 200 || res.status >= 300) {
      throw new QdrantApiError(res.status, path, res.body);
    }
    if (!res.body) return undefined as unknown as T;
    return JSON.parse(res.body) as T;
  }

  /** Management API request (`https://api.cloud.qdrant.io{path}`). */
  async cloud<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    return this.raw<T>(API_HOST, path, { Authorization: `apikey ${this.apiKey}` }, opts);
  }

  /** Database REST request against a cluster endpoint, with a database API key. */
  async database<T>(
    baseUrl: string,
    dbKey: string,
    path: string,
    opts: RequestOptions = {},
  ): Promise<T> {
    return this.raw<T>(baseUrl.replace(/\/+$/, ""), path, { "api-key": dbKey }, opts);
  }
}

export function isStatus(err: unknown, ...statuses: number[]): boolean {
  return err instanceof QdrantApiError && statuses.includes(err.status);
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Follow `nextPageToken` (sent back as `pageToken`) up to a page cap. */
export async function collectPages<T>(
  fetchPage: (
    token: string | undefined,
  ) => Promise<{ items?: T[]; nextPageToken?: string } | undefined>,
  maxPages = 50,
): Promise<T[]> {
  const out: T[] = [];
  let token: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const res = await fetchPage(token);
    out.push(...(res?.items ?? []));
    const next = res?.nextPageToken;
    if (!next || next === token) break;
    token = next;
  }
  return out;
}

/** Protobuf JSON `Duration` (`"604800s"`) to whole days, rounding down. */
export function durationToDays(d: string | undefined): number | undefined {
  if (!d) return undefined;
  const m = /^(\d+(?:\.\d+)?)s$/.exec(d.trim());
  if (!m) return undefined;
  return Math.floor(Number(m[1]) / 86_400);
}

export function daysToDuration(days: number): string {
  return `${Math.round(days * 86_400)}s`;
}

/** Strip a protobuf enum prefix: `CLUSTER_PHASE_HEALTHY` → `HEALTHY`. */
export function enumTail(value: string | undefined, prefix: string): string {
  if (!value) return "";
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

/** Millicents (int64 serialised as string or number) to currency units. */
export function millicents(v: string | number | undefined | null): number {
  if (v === undefined || v === null || v === "") return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n / 100_000 : 0;
}
