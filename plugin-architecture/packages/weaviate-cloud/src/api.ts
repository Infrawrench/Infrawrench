import type { HostServices } from "@infrawrench/plugin-base";

/**
 * Transport for one Weaviate cluster's REST API (`<endpoint>/v1/...`),
 * verified against `openapi-specs/schema.json` in github.com/weaviate/weaviate
 * (2026-10). This is the in-cluster half of the plugin; the organization half
 * (listing and creating Weaviate Cloud clusters) is `cloud.ts`.
 *
 * Requests carry a cluster API key as `Authorization: Bearer <key>`, so the
 * same code drives a self-hosted Weaviate. Errors are `{error: [{message}]}`;
 * the HTTP status rides on the thrown error for the poller.
 */

export class WeaviateApiError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, path: string, body: string) {
    super(`Weaviate API error ${status} for ${path}: ${summarizeBody(body)}`);
    this.name = "WeaviateApiError";
    this.status = status;
    this.body = body;
  }
}

export function summarizeBody(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown; message?: unknown };
    if (Array.isArray(parsed.error)) {
      const msgs = parsed.error
        .map((e) => (e && typeof e === "object" ? (e as { message?: unknown }).message : e))
        .filter((m): m is string => typeof m === "string" && !!m);
      if (msgs.length) return msgs.join("; ");
    }
    if (typeof parsed.message === "string" && parsed.message) return parsed.message;
    if (typeof parsed.error === "string" && parsed.error) return parsed.error;
  } catch {
    /* not JSON */
  }
  return body.slice(0, 500);
}

/** Normalise a pasted endpoint: add https://, drop a trailing slash or `/v1`. */
export function normalizeEndpoint(raw: string): string {
  let url = raw.trim();
  if (!url) return "";
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url.replace(/\/+$/, "").replace(/\/v1$/, "");
}

/**
 * Weaviate Cloud hosts look like `<id>.c0.<region>.<cloud>.weaviate.cloud`
 * (older clusters `*.weaviate.network`). Region and cloud are read from that
 * name; anything else (self-hosted) yields nothing.
 */
export function parseCloudHost(endpoint: string): { cloud: string; region: string } | null {
  let host: string;
  try {
    host = new URL(normalizeEndpoint(endpoint)).hostname;
  } catch {
    return null;
  }
  const m = /^[^.]+\.c\d+\.([a-z0-9-]+)\.([a-z]+)\.weaviate\.(cloud|network)$/i.exec(host);
  if (!m) return null;
  return { region: m[1]!.toLowerCase(), cloud: m[2]!.toLowerCase() };
}

/**
 * The stable key a cluster is filed under: its lowercased host, plus the port
 * when it is not the scheme's default. Weaviate Cloud reports the same host
 * the console shows, so a cluster listed by the organization API and one
 * typed into the account's credentials land on the same resource.
 */
export function clusterKeyOf(endpoint: string): string {
  try {
    const u = new URL(normalizeEndpoint(endpoint));
    return u.port ? `${u.hostname.toLowerCase()}:${u.port}` : u.hostname.toLowerCase();
  } catch {
    return "";
  }
}

export type QueryValue = string | number | boolean | undefined | null;

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Record<string, QueryValue>;
  body?: unknown;
}

export class WeaviateApi {
  readonly endpoint: string;

  constructor(
    endpoint: string,
    private readonly apiKey: string,
    private readonly caCert: string,
    private readonly services: HostServices | undefined,
  ) {
    this.endpoint = normalizeEndpoint(endpoint);
  }

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

  async request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const method = opts.method ?? "GET";
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== null && v !== "") params.append(k, String(v));
    }
    const qs = params.toString();
    const url = `${this.endpoint}/v1${path}${qs ? `?${qs}` : ""}`;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await this.send(url, method, headers, body);
    if (res.status < 200 || res.status >= 300) {
      throw new WeaviateApiError(res.status, path, res.body);
    }
    if (!res.body) return undefined as unknown as T;
    return JSON.parse(res.body) as T;
  }
}

export function isStatus(err: unknown, ...statuses: number[]): boolean {
  return err instanceof WeaviateApiError && statuses.includes(err.status);
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
