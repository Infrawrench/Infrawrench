import type { HostServices } from "@infrawrench/plugin-base";
import { utf8ToBase64 } from "@infrawrench/plugin-base";

/**
 * Transport for Algolia's REST APIs (verified against the bundled specs in
 * github.com/algolia/api-clients-automation `specs/bundled/*.yml` and the
 * Usage API reference, 2026-10):
 *
 * - Search API `https://{appId}.algolia.net` (retry hosts
 *   `{appId}-1..3.algolianet.com`): indices, settings, synonyms, rules, API
 *   keys, logs, allowed sources. Headers `x-algolia-application-id` +
 *   `x-algolia-api-key` (the Admin API key).
 * - Analytics and A/B testing `https://analytics[.{us|de}].algolia.com`: same
 *   headers, `analytics` / `editSettings` ACL.
 * - Usage API `https://usage.algolia.com/1/usage/{stats}[/{index}]`: same
 *   header names but a **separate Usage API key** from the API Keys page.
 * - Monitoring `https://status.algolia.com/1/...`: status and incidents are
 *   public; latency, indexing and inventory need the Monitoring API key.
 * - Crawler `https://crawler.algolia.com/api/1/...`: HTTP Basic with the
 *   crawler user ID and crawler API key from the Crawler settings page.
 */

export class AlgoliaApiError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, path: string, body: string) {
    super(`Algolia API error ${status} for ${path}: ${summarizeBody(body)}`);
    this.name = "AlgoliaApiError";
    this.status = status;
    this.body = body;
  }
}

/** Algolia errors are `{message, status}`; the crawler uses `{error: {message}}`. */
export function summarizeBody(body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: unknown; error?: unknown };
    if (typeof parsed.message === "string" && parsed.message) return parsed.message;
    if (parsed.error && typeof parsed.error === "object") {
      const m = (parsed.error as { message?: unknown }).message;
      if (typeof m === "string" && m) return m;
    }
    if (typeof parsed.error === "string") return parsed.error;
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

export interface AlgoliaCredentials {
  appId: string;
  apiKey: string;
  usageApiKey: string;
  monitoringApiKey: string;
  analyticsRegion: string;
  crawlerUserId: string;
  crawlerApiKey: string;
  caCert: string;
}

/** Statuses worth retrying on the next search host (network-level trouble). */
const RETRYABLE = new Set([0, 500, 502, 503, 504]);

export class AlgoliaApi {
  constructor(
    readonly creds: AlgoliaCredentials,
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
        ...(this.creds.caCert ? { caCert: this.creds.caCert } : {}),
      });
      return { status: res.status, body: res.body ?? "" };
    }
    const res = await fetch(url, { method, headers, ...(body !== undefined ? { body } : {}) });
    return { status: res.status, body: await res.text() };
  }

  private async call<T>(
    hosts: string[],
    path: string,
    auth: Record<string, string>,
    opts: RequestOptions,
  ): Promise<T> {
    const method = opts.method ?? "GET";
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== null && v !== "") params.append(k, String(v));
    }
    const qs = params.toString();
    const headers: Record<string, string> = { Accept: "application/json", ...auth };
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let last: { status: number; body: string } | undefined;
    let lastErr: unknown;
    for (const host of hosts) {
      try {
        last = await this.send(`${host}${path}${qs ? `?${qs}` : ""}`, method, headers, body);
      } catch (e) {
        lastErr = e;
        continue;
      }
      if (!RETRYABLE.has(last.status)) break;
    }
    if (!last) throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    if (last.status < 200 || last.status >= 300)
      throw new AlgoliaApiError(last.status, path, last.body);
    if (!last.body) return undefined as unknown as T;
    return JSON.parse(last.body) as T;
  }

  private keyHeaders(key: string): Record<string, string> {
    return { "x-algolia-application-id": this.creds.appId, "x-algolia-api-key": key };
  }

  /** Search API with retry across Algolia's documented fallback hosts. */
  search<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const id = this.creds.appId.toLowerCase();
    const read = (opts.method ?? "GET") === "GET";
    const hosts = [
      read ? `https://${id}-dsn.algolia.net` : `https://${id}.algolia.net`,
      `https://${id}-1.algolianet.com`,
      `https://${id}-2.algolianet.com`,
      `https://${id}-3.algolianet.com`,
    ];
    return this.call<T>(hosts, path, this.keyHeaders(this.creds.apiKey), opts);
  }

  analytics<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const region = this.creds.analyticsRegion;
    const host = region
      ? `https://analytics.${region}.algolia.com`
      : "https://analytics.algolia.com";
    return this.call<T>([host], path, this.keyHeaders(this.creds.apiKey), opts);
  }

  usage<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    if (!this.creds.usageApiKey)
      throw new AlgoliaApiError(401, path, "No Usage API key on this account.");
    return this.call<T>(
      ["https://usage.algolia.com"],
      path,
      this.keyHeaders(this.creds.usageApiKey),
      opts,
    );
  }

  /** Monitoring API; public routes (status, incidents) work without a key. */
  monitoring<T>(path: string, opts: RequestOptions = {}, needsKey = true): Promise<T> {
    if (needsKey && !this.creds.monitoringApiKey) {
      throw new AlgoliaApiError(401, path, "No Monitoring API key on this account.");
    }
    const auth = this.creds.monitoringApiKey ? this.keyHeaders(this.creds.monitoringApiKey) : {};
    return this.call<T>(["https://status.algolia.com"], path, auth, opts);
  }

  get hasCrawler(): boolean {
    return this.creds.crawlerUserId !== "" && this.creds.crawlerApiKey !== "";
  }

  crawler<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    if (!this.hasCrawler)
      throw new AlgoliaApiError(401, path, "No crawler credentials on this account.");
    const basic = utf8ToBase64(`${this.creds.crawlerUserId}:${this.creds.crawlerApiKey}`);
    return this.call<T>(
      ["https://crawler.algolia.com/api"],
      path,
      { Authorization: `Basic ${basic}` },
      opts,
    );
  }
}

export function isStatus(err: unknown, ...statuses: number[]): boolean {
  return err instanceof AlgoliaApiError && statuses.includes(err.status);
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Stable, non-reversible id for an API key (FNV-1a 64-bit), so key values never sit in resource ids. */
export function keyFingerprint(value: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (const c of new TextEncoder().encode(value)) {
    h ^= BigInt(c);
    h = (h * prime) & 0xffffffffffffffffn;
  }
  return `key-${h.toString(16).padStart(16, "0")}`;
}
