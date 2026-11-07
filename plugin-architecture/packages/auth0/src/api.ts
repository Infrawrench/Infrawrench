import {
  createApiClient,
  type ApiClient,
  type HostServices,
  type HttpHostServices,
} from "@infrawrench/plugin-base";
import type { paths } from "./api-types.gen.js";
import { apiError, sendRaw, type RawResponse } from "./http.js";

/**
 * Auth0 Management API v2 transport. Verified against Auth0's published
 * OpenAPI document (https://auth0.com/docs/api/management/openapi.json,
 * 2026-10).
 *
 * Auth is a Machine-to-Machine application authorized for the Management
 * API: `POST https://{tenant}/oauth/token` with `grant_type=client_credentials`
 * and `audience=https://{tenant}/api/v2/`. The audience must be the tenant's
 * canonical `*.auth0.com` domain even when a custom domain is configured.
 */

export interface Auth0Credentials {
  domain: string;
  clientId: string;
  clientSecret: string;
  caCert: string;
}

export function normalizeDomain(raw: string): string {
  const host = raw
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
  if (!host) throw new Error("Auth0 plugin: missing domain credential");
  return host;
}

export function readCredentials(credentials: Record<string, string>): Auth0Credentials {
  const clientId = (credentials["clientId"] ?? "").trim();
  const clientSecret = (credentials["clientSecret"] ?? "").trim();
  if (!clientId) throw new Error("Auth0 plugin: missing clientId credential");
  if (!clientSecret) throw new Error("Auth0 plugin: missing clientSecret credential");
  return {
    domain: normalizeDomain(credentials["domain"] ?? ""),
    clientId,
    clientSecret,
    caCert: credentials["caCert"] ?? "",
  };
}

/**
 * The public-cloud region a tenant lives in, from its canonical domain:
 * `{tenant}.{us|eu|au|jp|ca|uk}.auth0.com`, or the original US region for a
 * bare `{tenant}.auth0.com`. Private-cloud and custom hosts answer "".
 */
export function regionOfDomain(domain: string): string {
  const match = domain.match(/^[^.]+\.(?:([a-z]{2})\.)?auth0\.com$/);
  if (!match) return "";
  return match[1] ?? "us";
}

/** What every paged list asks for, after its own query. */
export interface Paging {
  page: number;
  per_page: number;
  include_totals: true;
}

/**
 * One page of a list. `include_totals=true` answers `{start, limit, total, <key>: [...]}`,
 * and the document also allows the bare array.
 */
type ListPage<Key extends string, Item> = Item[] | ({ total?: number } & { [K in Key]?: Item[] });

/**
 * Page through an offset-paginated collection (`page`/`per_page` with
 * `include_totals=true`). Auth0 caps `per_page` at 100 and, for users, the
 * reachable depth at 1000. A hand loop rather than `withCursorPagination`, which
 * reads one shape per route and has no running count to compare with `total`.
 */
export async function pages<Key extends string, Item>(
  key: Key,
  fetchPage: (paging: Paging) => Promise<ListPage<Key, Item>>,
  maxPages = 10,
): Promise<Item[]> {
  const out: Item[] = [];
  for (let page = 0; page < maxPages; page++) {
    const body = await fetchPage({ page, per_page: 100, include_totals: true });
    if (Array.isArray(body)) {
      out.push(...body);
      if (body.length < 100) break;
      continue;
    }
    const keyed: { [K in Key]?: Item[] } = body;
    const items = keyed[key] ?? [];
    out.push(...items);
    const { total } = body;
    if (items.length < 100 || (typeof total === "number" && out.length >= total)) break;
  }
  return out;
}

export class Auth0Api {
  private token: { value: string; expiresAt: number } | null = null;
  private pending: Promise<string> | null = null;
  /** Last rate-limit headers seen (Auth0 rate-limits the Management API per tenant). */
  lastRateLimit: { limit: number; remaining: number; resetAt: number } | null = null;
  /** The Management API, through {@link send}. */
  readonly rest: ApiClient<paths>;

  constructor(
    readonly creds: Auth0Credentials,
    private readonly services: HostServices | undefined,
  ) {
    this.rest = createApiClient<paths>({
      vendor: "Auth0",
      baseUrl: `https://${creds.domain}/api/v2`,
      headers: { Accept: "application/json" },
      http: { request: (req) => this.send(req) },
      contentType: "with-body",
      emptyBodyIsUndefined: true,
      httpError: ({ status, path, body }) => apiError(status, path, body),
    });
  }

  get domain(): string {
    return this.creds.domain;
  }

  private async accessToken(force: boolean): Promise<string> {
    if (!force && this.token && this.token.expiresAt - 60_000 > Date.now()) return this.token.value;
    this.pending ??= this.fetchToken().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  /** `/oauth/token` is not in the Management API document, so this stays hand-written. */
  private async fetchToken(): Promise<string> {
    const res = await sendRaw(
      {
        url: `https://${this.creds.domain}/oauth/token`,
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          grant_type: "client_credentials",
          client_id: this.creds.clientId,
          client_secret: this.creds.clientSecret,
          audience: `https://${this.creds.domain}/api/v2/`,
        }),
      },
      this.services,
      this.creds.caCert,
    );
    if (res.status < 200 || res.status >= 300) throw apiError(res.status, "/oauth/token", res.body);
    const body: { access_token?: string; expires_in?: number } = JSON.parse(res.body);
    if (!body.access_token)
      throw Object.assign(new Error("Auth0 plugin: no access token returned"), { status: 502 });
    this.token = {
      value: body.access_token,
      expiresAt: Date.now() + (body.expires_in ?? 86400) * 1000,
    };
    return body.access_token;
  }

  /** The transport under {@link rest}: the bearer token, a fresh one after a 401, and the rate limit. */
  private async send(req: Parameters<HttpHostServices["request"]>[0]): Promise<RawResponse> {
    const first = await this.sendWithToken(req, false);
    if (first.status !== 401) return first;
    this.token = null;
    return this.sendWithToken(req, true);
  }

  private async sendWithToken(
    { url, method, headers, body }: Parameters<HttpHostServices["request"]>[0],
    freshToken: boolean,
  ): Promise<RawResponse> {
    const token = await this.accessToken(freshToken);
    const res = await sendRaw(
      {
        url,
        method,
        headers: { Authorization: `Bearer ${token}`, ...headers },
        // The client only ever sends JSON text.
        ...(typeof body === "string" ? { body } : {}),
      },
      this.services,
      this.creds.caCert,
    );
    const limit = Number(res.headers["x-ratelimit-limit"]);
    const remaining = Number(res.headers["x-ratelimit-remaining"]);
    if (Number.isFinite(limit) && Number.isFinite(remaining) && limit > 0) {
      const reset = Number(res.headers["x-ratelimit-reset"]);
      this.lastRateLimit = {
        limit,
        remaining,
        resetAt: Number.isFinite(reset) ? reset * 1000 : Date.now(),
      };
    }
    return res;
  }
}
