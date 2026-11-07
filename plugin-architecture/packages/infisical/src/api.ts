import {
  createApiClient,
  type ApiBody,
  type ApiClient,
  type ApiResponse,
  type HostServices,
  type HttpHostServices,
  type ParamValue,
  withCursorPagination,
} from "@infrawrench/plugin-base";
import type { operations, paths } from "./api-types.gen.js";
import { apiError, sendRaw, type RawRequest, type RawResponse } from "./http.js";

/**
 * Infisical REST transport: Universal Auth login, bearer-token caching and
 * JSON requests, typed from the live OpenAPI document at
 * https://app.infisical.com/api/docs/json (`plugingen.json`).
 *
 * Auth: POST /api/v1/auth/universal-auth/login with `{clientId, clientSecret,
 * organizationSlug?}` answers `{accessToken, expiresIn, accessTokenMaxTTL,
 * tokenType: "Bearer"}`. Every other call sends `Authorization: Bearer`.
 */

export const DEFAULT_SITE_URL = "https://app.infisical.com";

/** Refresh the access token this long before Infisical says it expires. */
const TOKEN_SKEW_MS = 60_000;

/** The largest `limit` Infisical's document allows on its offset lists. */
const PAGE_SIZE = 100;
/** 10,000 rows. */
const MAX_PAGES = 100;

type Login = operations["loginWithUniversalAuth"];

function withOffsetLists(rest: ApiClient<paths>) {
  return withCursorPagination(rest, {
    cursorParam: "offset",
    firstCursor: 0,
    sizeParam: "limit",
    pageSize: PAGE_SIZE,
    maxPages: MAX_PAGES,
    next: ({ cursor }) => Number(cursor) + PAGE_SIZE,
    stopOnShortPage: true,
    total: "totalCount",
  });
}

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

export class InfisicalApi {
  /** Every call but the login: signed in, and retried once with a fresh token on a 401. */
  readonly rest: ApiClient<paths>;
  /** `rest`, plus `getAll` for the routes that page by `limit` and `offset`. */
  readonly lists: ReturnType<typeof withOffsetLists>;
  private token: { value: string; expiresAt: number } | null = null;
  private login: Promise<string> | null = null;

  constructor(
    readonly creds: InfisicalCredentials,
    private readonly services: HostServices | undefined,
  ) {
    const http: HttpHostServices = { request: (req) => this.signedIn(req) };
    this.rest = createApiClient<paths>({
      vendor: "Infisical",
      baseUrl: creds.siteUrl,
      headers: { Accept: "application/json" },
      http,
      contentType: "with-body",
      serializeQuery: buildQuery,
      httpError: ({ status, path, body }) => apiError(status, path, body),
    });
    this.lists = withOffsetLists(this.rest);
  }

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

  /**
   * On `sendRaw` rather than `rest`, typed by hand from the document: the client reads a
   * 2xx with no body as `undefined`, and a login that answers nothing has to fail on it.
   */
  private async doLogin(): Promise<string> {
    const path = "/api/v1/auth/universal-auth/login";
    const body: ApiBody<Login> = {
      clientId: this.creds.clientId,
      clientSecret: this.creds.clientSecret,
      ...(this.creds.organizationSlug ? { organizationSlug: this.creds.organizationSlug } : {}),
    };
    const res = await sendRaw(
      {
        url: `${this.creds.siteUrl}${path}`,
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      },
      this.services,
      this.creds.caCert,
    );
    if (res.status < 200 || res.status >= 300) throw apiError(res.status, path, res.body);
    const parsed: ApiResponse<Login> = JSON.parse(res.body);
    if (!parsed.accessToken) {
      throw Object.assign(new Error("Infisical plugin: login returned no access token"), {
        status: 502,
      });
    }
    const ttlMs = (typeof parsed.expiresIn === "number" ? parsed.expiresIn : 600) * 1000;
    this.token = { value: parsed.accessToken, expiresAt: Date.now() + ttlMs };
    return parsed.accessToken;
  }

  /** The transport `rest` runs on. Retries once with a fresh token on a 401. */
  private async signedIn(req: Parameters<HttpHostServices["request"]>[0]): Promise<RawResponse> {
    const send = async (force: boolean) => {
      const token = await this.accessToken(force);
      const request: RawRequest = {
        url: req.url,
        method: req.method,
        headers: { Authorization: `Bearer ${token}`, ...req.headers },
        // The client only ever sends JSON text.
        ...(typeof req.body === "string" ? { body: req.body } : {}),
      };
      return sendRaw(request, this.services, this.creds.caCert);
    };
    let res = await send(false);
    if (res.status === 401) {
      this.token = null;
      res = await send(true);
    }
    // The client reads every 204 as empty; one that came with a body has always been parsed.
    return res.status === 204 && res.body ? { ...res, status: 200 } : res;
  }
}

/** Skips `undefined` and `""`, which Infisical would otherwise read as a filter. No leading `?`. */
export function buildQuery(query: Record<string, ParamValue>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === "") continue;
    params.set(key, String(value));
  }
  return params.toString();
}
