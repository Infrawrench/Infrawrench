import type { HostServices } from "@infrawrench/plugin-base";
import { apiError, sendRaw } from "./http.js";

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

export type Query = Record<string, string | number | boolean | undefined>;

export interface RequestOptions {
  method?: string;
  query?: Query;
  body?: unknown;
}

export class Auth0Api {
  private token: { value: string; expiresAt: number } | null = null;
  private pending: Promise<string> | null = null;
  /** Last rate-limit headers seen (Auth0 rate-limits the Management API per tenant). */
  lastRateLimit: { limit: number; remaining: number; resetAt: number } | null = null;

  constructor(
    readonly creds: Auth0Credentials,
    private readonly services: HostServices | undefined,
  ) {}

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
    const body = JSON.parse(res.body) as { access_token?: string; expires_in?: number };
    if (!body.access_token)
      throw Object.assign(new Error("Auth0 plugin: no access token returned"), { status: 502 });
    this.token = {
      value: body.access_token,
      expiresAt: Date.now() + (body.expires_in ?? 86400) * 1000,
    };
    return body.access_token;
  }

  async call<T>(
    path: string,
    options: RequestOptions = {},
  ): Promise<{ data: T; headers: Record<string, string> }> {
    const url = `https://${this.creds.domain}/api/v2${path}${buildQuery(options.query)}`;
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.accessToken(attempt > 0);
      const res = await sendRaw(
        {
          url,
          method: options.method ?? "GET",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          ...(body !== undefined ? { body } : {}),
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
      if (res.status === 401 && attempt === 0) {
        this.token = null;
        continue;
      }
      if (res.status < 200 || res.status >= 300) throw apiError(res.status, path, res.body);
      return { data: (res.body ? JSON.parse(res.body) : undefined) as T, headers: res.headers };
    }
    throw apiError(401, path, "unauthorized");
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return (await this.call<T>(path, options)).data;
  }

  /**
   * Page through an offset-paginated collection (`page`/`per_page` with
   * `include_totals=true`, answering `{start, limit, total, <key>: [...]}`).
   * Auth0 caps `per_page` at 100 and, for users, the reachable depth at 1000.
   */
  async pages<T>(path: string, key: string, query: Query = {}, maxPages = 10): Promise<T[]> {
    const out: T[] = [];
    for (let page = 0; page < maxPages; page++) {
      const body = await this.request<Record<string, unknown> | T[]>(path, {
        query: { ...query, page, per_page: 100, include_totals: true },
      });
      if (Array.isArray(body)) {
        out.push(...body);
        if (body.length < 100) break;
        continue;
      }
      const items = (body[key] as T[] | undefined) ?? [];
      out.push(...items);
      const total = typeof body["total"] === "number" ? (body["total"] as number) : undefined;
      if (items.length < 100 || (total !== undefined && out.length >= total)) break;
    }
    return out;
  }
}

export function buildQuery(query: Query | undefined): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === "") continue;
    params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}
