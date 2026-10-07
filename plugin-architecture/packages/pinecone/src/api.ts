import type { HostServices } from "@infrawrench/plugin-base";

/**
 * Transport for Pinecone's REST APIs (verified against the published
 * OpenAPI specs in github.com/pinecone-io/pinecone-api, version `2026-07`,
 * the latest stable release as of 2026-10):
 *
 * - Control plane (`https://api.pinecone.io`): indexes, collections, backups,
 *   backup schedules, restore jobs, inference model catalog. Auth is the
 *   project API key in the `Api-Key` header.
 * - Assistant control plane (`https://api.pinecone.io/assistant`): same key.
 * - Data plane (`https://{index host}` / `https://{assistant host}`): index
 *   stats and assistant chat/files. Same key.
 * - Admin API (`https://api.pinecone.io/admin`): projects, project API keys,
 *   service accounts. Auth is `Authorization: Bearer <token>`, where the token
 *   comes from the OAuth2 client-credentials exchange at
 *   `https://login.pinecone.io/oauth/token` (audience
 *   `https://api.pinecone.io/`, ~30 minute lifetime).
 *
 * Every request sends `X-Pinecone-Api-Version`, without which Pinecone falls
 * back to the *oldest* supported version and answers in the pre-2026 shapes.
 * Requests go through `services.http` when the host provides it, which keeps
 * bastion routing and custom CAs working.
 */

export const API_VERSION = "2026-07";
export const API_HOST = "https://api.pinecone.io";
export const LOGIN_HOST = "https://login.pinecone.io";

export class PineconeApiError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, path: string, body: string) {
    super(`Pinecone API error ${status} for ${path}: ${summarizeBody(body)}`);
    this.name = "PineconeApiError";
    this.status = status;
    this.body = body;
  }
}

/** Pinecone errors are `{status, error: {code, message}}`; OAuth uses `{error, error_description}`. */
export function summarizeBody(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      error?: unknown;
      error_description?: unknown;
      message?: unknown;
    };
    if (typeof parsed.error_description === "string" && parsed.error_description) {
      return parsed.error_description;
    }
    if (parsed.error && typeof parsed.error === "object") {
      const e = parsed.error as { code?: unknown; message?: unknown };
      if (typeof e.message === "string" && e.message) {
        return typeof e.code === "string" ? `${e.code}: ${e.message}` : e.message;
      }
    }
    if (typeof parsed.error === "string" && parsed.error) return parsed.error;
    if (typeof parsed.message === "string" && parsed.message) return parsed.message;
  } catch {
    /* not JSON (the control plane's 401 is text/plain) */
  }
  return body.slice(0, 500);
}

export type QueryValue = string | number | boolean | undefined | null;

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  query?: Record<string, QueryValue>;
  body?: unknown;
  /** Response body is text (Prometheus exposition format), not JSON. */
  text?: boolean;
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

/** `https://` prefix for a bare host Pinecone returns (`x.svc.pinecone.io`). */
export function hostUrl(host: string): string {
  const h = host.trim().replace(/\/+$/, "");
  if (!h) return "";
  return /^https?:\/\//i.test(h) ? h : `https://${h}`;
}

interface TokenCache {
  token: string;
  expiresAt: number;
}

export interface PineconeCredentials {
  apiKey: string;
  clientId: string;
  clientSecret: string;
  caCert: string;
}

export class PineconeApi {
  private token: TokenCache | undefined;
  private tokenInFlight: Promise<string> | undefined;

  constructor(
    private readonly creds: PineconeCredentials,
    private readonly services: HostServices | undefined,
  ) {}

  get hasApiKey(): boolean {
    return this.creds.apiKey !== "";
  }

  get hasAdmin(): boolean {
    return this.creds.clientId !== "" && this.creds.clientSecret !== "";
  }

  get apiKey(): string {
    return this.creds.apiKey;
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
        ...(this.creds.caCert ? { caCert: this.creds.caCert } : {}),
      });
      return { status: res.status, body: res.body ?? "" };
    }
    const res = await fetch(url, { method, headers, ...(body !== undefined ? { body } : {}) });
    return { status: res.status, body: await res.text() };
  }

  private async raw(
    base: string,
    path: string,
    auth: Record<string, string>,
    opts: RequestOptions,
  ): Promise<string> {
    const method = opts.method ?? "GET";
    const query = buildQuery(opts.query);
    const url = `${base}${path}${query ? `?${query}` : ""}`;
    const headers: Record<string, string> = {
      Accept: opts.text ? "text/plain" : "application/json",
      "X-Pinecone-Api-Version": API_VERSION,
      ...auth,
    };
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await this.send(url, method, headers, body);
    if (res.status < 200 || res.status >= 300) {
      throw new PineconeApiError(res.status, path, res.body);
    }
    return res.body;
  }

  private parse<T>(text: string): T {
    if (!text) return undefined as unknown as T;
    return JSON.parse(text) as T;
  }

  private requireKey(): Record<string, string> {
    if (!this.creds.apiKey) {
      throw new PineconeApiError(
        401,
        "control plane",
        "This account has no project API key, so indexes, backups and assistants cannot be read.",
      );
    }
    return { "Api-Key": this.creds.apiKey };
  }

  /** Control-plane request (`https://api.pinecone.io{path}`) with the project API key. */
  async control<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    return this.parse<T>(await this.raw(API_HOST, path, this.requireKey(), opts));
  }

  /** Data-plane request against an index or assistant host, with the project API key. */
  async dataPlane<T>(host: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const base = hostUrl(host);
    if (!base) throw new PineconeApiError(404, path, "This resource has no host yet.");
    return this.parse<T>(await this.raw(base, path, this.requireKey(), opts));
  }

  /**
   * Prometheus endpoints (discovery and the scrape targets) take the project
   * API key as a Bearer token rather than in `Api-Key`.
   */
  async prometheus(url: string, text: boolean): Promise<string> {
    const auth = { Authorization: `Bearer ${this.requireKey()["Api-Key"]}` };
    const u = new URL(url);
    return this.raw(u.origin, `${u.pathname}${u.search}`, auth, { text });
  }

  /** Admin API request with a service-account access token. */
  async admin<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const token = await this.accessToken();
    return this.parse<T>(
      await this.raw(API_HOST, `/admin${path}`, { Authorization: `Bearer ${token}` }, opts),
    );
  }

  /** OAuth2 client-credentials exchange, cached until a minute before expiry. */
  async accessToken(): Promise<string> {
    if (!this.hasAdmin) {
      throw new PineconeApiError(
        401,
        "/oauth/token",
        "Add a service account client ID and secret to this account to manage projects, API keys and service accounts.",
      );
    }
    if (this.token && Date.now() < this.token.expiresAt) return this.token.token;
    if (this.tokenInFlight) return this.tokenInFlight;
    this.tokenInFlight = (async () => {
      try {
        const res = await this.send(
          `${LOGIN_HOST}/oauth/token`,
          "POST",
          {
            Accept: "application/json",
            "Content-Type": "application/json",
            "X-Pinecone-Api-Version": API_VERSION,
          },
          JSON.stringify({
            grant_type: "client_credentials",
            client_id: this.creds.clientId,
            client_secret: this.creds.clientSecret,
            audience: `${API_HOST}/`,
          }),
        );
        if (res.status < 200 || res.status >= 300) {
          throw new PineconeApiError(res.status, "/oauth/token", res.body);
        }
        const parsed = JSON.parse(res.body) as { access_token?: string; expires_in?: number };
        if (!parsed.access_token) {
          throw new PineconeApiError(502, "/oauth/token", "No access token in the response.");
        }
        const ttl = Math.max(60, Number(parsed.expires_in) || 1800);
        this.token = { token: parsed.access_token, expiresAt: Date.now() + (ttl - 60) * 1000 };
        return parsed.access_token;
      } finally {
        this.tokenInFlight = undefined;
      }
    })();
    return this.tokenInFlight;
  }
}

export function isStatus(err: unknown, ...statuses: number[]): boolean {
  return err instanceof PineconeApiError && statuses.includes(err.status);
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Follow a `pagination.next` cursor (sent back as `paginationToken`) up to a page cap. */
export async function collectPages<T>(
  fetchPage: (
    token: string | undefined,
  ) => Promise<{ data?: T[]; pagination?: { next?: string } | null } | undefined>,
  maxPages = 50,
): Promise<T[]> {
  const out: T[] = [];
  let token: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const res = await fetchPage(token);
    out.push(...(res?.data ?? []));
    const next = res?.pagination?.next;
    if (!next || next === token) break;
    token = next;
  }
  return out;
}
