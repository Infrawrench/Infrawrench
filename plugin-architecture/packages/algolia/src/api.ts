import type {
  ApiClient,
  HostServices,
  HttpHostServices,
  ParamValue,
} from "@infrawrench/plugin-base";
import { createApiClient, utf8ToBase64 } from "@infrawrench/plugin-base";
import type { paths as AbTestingPaths } from "./api-types.abtesting.gen.js";
import type { paths as AnalyticsPaths } from "./api-types.analytics.gen.js";
import type { paths as CrawlerPaths } from "./api-types.crawler.gen.js";
import type { paths as MonitoringPaths } from "./api-types.monitoring.gen.js";
import type { paths as SearchPaths } from "./api-types.search.gen.js";
import type { AlUsagePoint } from "./types.js";

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
    const parsed: { message?: string; error?: string | { message?: string } } = JSON.parse(body);
    if (typeof parsed.message === "string" && parsed.message) return parsed.message;
    if (parsed.error && typeof parsed.error === "object") {
      const m = parsed.error.message;
      if (typeof m === "string" && m) return m;
    }
    if (typeof parsed.error === "string") return parsed.error;
  } catch {
    /* not JSON */
  }
  return body.slice(0, 500);
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

/** Algolia publishes no document for the Usage API, so its two routes are written out here. */
interface UsageOperation {
  parameters: { query: { startDate: string; endDate: string; granularity: string } };
  responses: { 200: { content: { "application/json": Record<string, AlUsagePoint[]> } } };
}

interface UsagePaths {
  "/1/usage/{statistics}": { get: UsageOperation };
  "/1/usage/{statistics}/{indexName}": { get: UsageOperation };
}

/** Statuses worth retrying on the next search host (network-level trouble). */
const RETRYABLE = new Set([0, 500, 502, 503, 504]);

type HttpRequest = Parameters<HttpHostServices["request"]>[0];

/**
 * The transport under every client: sends a path to each of `hosts` in turn until
 * one answers with something other than network-level trouble, which is also what
 * the clients' empty `baseUrl` leaves it to do. Without a credential the API needs,
 * `missing` is the answer, so the error names the path like any other 401.
 */
function hostsTransport(
  services: HostServices | undefined,
  hosts: (method: string) => string[],
  missing: string | undefined,
): HttpHostServices {
  const send = async (req: HttpRequest, url: string) => {
    const http = services?.http;
    if (http) {
      const res = await http.request({ ...req, url });
      return { status: res.status, headers: {}, body: res.body ?? "" };
    }
    const { method, headers, body } = req;
    // A body from these clients is always JSON text.
    const res = await fetch(url, {
      method,
      headers,
      ...(typeof body === "string" ? { body } : {}),
    });
    return { status: res.status, headers: {}, body: await res.text() };
  };
  return {
    async request(req) {
      if (missing !== undefined) return { status: 401, headers: {}, body: missing };
      let last: { status: number; headers: Record<string, string>; body: string } | undefined;
      let lastErr: unknown;
      for (const host of hosts(req.method)) {
        try {
          last = await send(req, `${host}${req.url}`);
        } catch (e) {
          lastErr = e;
          continue;
        }
        if (!RETRYABLE.has(last.status)) break;
      }
      if (!last) throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
      return last;
    },
  };
}

/** Today's query: an empty value is left out, where the client's default would send it. */
function serializeQuery(query: Record<string, ParamValue>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== "") params.append(k, String(v));
  }
  return params.toString();
}

/** One typed client per document, and one more for the Usage API. */
export class AlgoliaApi {
  /** Search API with retry across Algolia's documented fallback hosts. */
  readonly search: ApiClient<SearchPaths>;
  readonly abTests: ApiClient<AbTestingPaths>;
  readonly analytics: ApiClient<AnalyticsPaths>;
  readonly usage: ApiClient<UsagePaths>;
  readonly monitoring: ApiClient<MonitoringPaths>;
  readonly crawler: ApiClient<CrawlerPaths>;

  constructor(
    readonly creds: AlgoliaCredentials,
    services: HostServices | undefined,
  ) {
    const clientFor = <P>(
      hosts: (method: string) => string[],
      auth: Record<string, string>,
      missing?: string,
    ) =>
      createApiClient<P>({
        vendor: "Algolia",
        baseUrl: "",
        headers: { Accept: "application/json", ...auth },
        http: hostsTransport(services, hosts, missing),
        caCert: creds.caCert,
        contentType: "with-body",
        serializeQuery,
        httpError: ({ status, path, body }) => new AlgoliaApiError(status, path, body),
      });
    const keyHeaders = (key: string) => ({
      "x-algolia-application-id": creds.appId,
      "x-algolia-api-key": key,
    });

    const id = creds.appId.toLowerCase();
    this.search = clientFor<SearchPaths>(
      (method) => [
        method === "GET" ? `https://${id}-dsn.algolia.net` : `https://${id}.algolia.net`,
        `https://${id}-1.algolianet.com`,
        `https://${id}-2.algolianet.com`,
        `https://${id}-3.algolianet.com`,
      ],
      keyHeaders(creds.apiKey),
    );

    const region = creds.analyticsRegion;
    const analyticsHost = region
      ? `https://analytics.${region}.algolia.com`
      : "https://analytics.algolia.com";
    this.abTests = clientFor<AbTestingPaths>(() => [analyticsHost], keyHeaders(creds.apiKey));
    this.analytics = clientFor<AnalyticsPaths>(() => [analyticsHost], keyHeaders(creds.apiKey));

    this.usage = clientFor<UsagePaths>(
      () => ["https://usage.algolia.com"],
      keyHeaders(creds.usageApiKey),
      creds.usageApiKey ? undefined : "No Usage API key on this account.",
    );

    this.monitoring = clientFor<MonitoringPaths>(
      () => ["https://status.algolia.com"],
      keyHeaders(creds.monitoringApiKey),
      creds.monitoringApiKey ? undefined : "No Monitoring API key on this account.",
    );

    const basic = utf8ToBase64(`${creds.crawlerUserId}:${creds.crawlerApiKey}`);
    this.crawler = clientFor<CrawlerPaths>(
      () => ["https://crawler.algolia.com/api"],
      { Authorization: `Basic ${basic}` },
      this.hasCrawler ? undefined : "No crawler credentials on this account.",
    );
  }

  get hasCrawler(): boolean {
    return this.creds.crawlerUserId !== "" && this.creds.crawlerApiKey !== "";
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
