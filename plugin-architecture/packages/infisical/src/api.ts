import type { HostServices } from "@infrawrench/plugin-base";
import { apiError, sendRaw } from "./http.js";

/**
 * Infisical REST transport: Universal Auth login, bearer-token caching and
 * JSON requests. Shapes verified against the live OpenAPI document at
 * https://app.infisical.com/api/docs/json (2026-10).
 *
 * Auth: POST /api/v1/auth/universal-auth/login with `{clientId, clientSecret,
 * organizationSlug?}` answers `{accessToken, expiresIn, accessTokenMaxTTL,
 * tokenType: "Bearer"}`. Every other call sends `Authorization: Bearer`.
 */

export const DEFAULT_SITE_URL = "https://app.infisical.com";

/** Refresh the access token this long before Infisical says it expires. */
const TOKEN_SKEW_MS = 60_000;

export interface InfisicalCredentials {
  siteUrl: string;
  clientId: string;
  clientSecret: string;
  organizationSlug: string;
  caCert: string;
}

export function readCredentials(credentials: Record<string, string>): InfisicalCredentials {
  const clientId = (credentials["clientId"] ?? "").trim();
  const clientSecret = (credentials["clientSecret"] ?? "").trim();
  if (!clientId) throw new Error("Infisical plugin: missing clientId credential");
  if (!clientSecret) throw new Error("Infisical plugin: missing clientSecret credential");
  return {
    siteUrl: normalizeSiteUrl(credentials["siteUrl"] ?? ""),
    clientId,
    clientSecret,
    organizationSlug: (credentials["organizationSlug"] ?? "").trim(),
    caCert: credentials["caCert"] ?? "",
  };
}

/** `eu.infisical.com/` → `https://eu.infisical.com`; blank → Infisical Cloud (US). */
export function normalizeSiteUrl(raw: string): string {
  let url = raw.trim();
  if (!url) return DEFAULT_SITE_URL;
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  url = url.replace(/\/+$/, "");
  // People paste the API base or a dashboard URL; the API lives under /api.
  url = url.replace(/\/api(\/.*)?$/i, "");
  return url;
}

export type Query = Record<string, string | number | boolean | undefined>;

export interface RequestOptions {
  method?: string;
  query?: Query;
  body?: unknown;
}

export class InfisicalApi {
  private token: { value: string; expiresAt: number } | null = null;
  private login: Promise<string> | null = null;

  constructor(
    readonly creds: InfisicalCredentials,
    private readonly services: HostServices | undefined,
  ) {}

  get siteUrl(): string {
    return this.creds.siteUrl;
  }

  private async accessToken(force = false): Promise<string> {
    if (!force && this.token && this.token.expiresAt - TOKEN_SKEW_MS > Date.now()) {
      return this.token.value;
    }
    this.login ??= this.doLogin().finally(() => {
      this.login = null;
    });
    return this.login;
  }

  private async doLogin(): Promise<string> {
    const path = "/api/v1/auth/universal-auth/login";
    const res = await sendRaw(
      {
        url: `${this.creds.siteUrl}${path}`,
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          clientId: this.creds.clientId,
          clientSecret: this.creds.clientSecret,
          ...(this.creds.organizationSlug ? { organizationSlug: this.creds.organizationSlug } : {}),
        }),
      },
      this.services,
      this.creds.caCert,
    );
    if (res.status < 200 || res.status >= 300) throw apiError(res.status, path, res.body);
    const parsed = JSON.parse(res.body) as { accessToken?: string; expiresIn?: number };
    if (!parsed.accessToken) {
      throw Object.assign(new Error("Infisical plugin: login returned no access token"), {
        status: 502,
      });
    }
    const ttlMs = (typeof parsed.expiresIn === "number" ? parsed.expiresIn : 600) * 1000;
    this.token = { value: parsed.accessToken, expiresAt: Date.now() + ttlMs };
    return parsed.accessToken;
  }

  /** JSON request against the API. Retries once with a fresh token on a 401. */
  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const method = options.method ?? "GET";
    const qs = buildQuery(options.query);
    const url = `${this.creds.siteUrl}${path}${qs}`;
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.accessToken(attempt > 0);
      const res = await sendRaw(
        {
          url,
          method,
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
      if (res.status === 401 && attempt === 0) {
        this.token = null;
        continue;
      }
      if (res.status < 200 || res.status >= 300) throw apiError(res.status, path, res.body);
      if (!res.body) return undefined as T;
      return JSON.parse(res.body) as T;
    }
    throw apiError(401, path, "unauthorized");
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
