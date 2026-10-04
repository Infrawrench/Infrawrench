import type { HostServices } from "@infrawrench/plugin-base";
import { canonicalQuery, signRequest, type QueryValue } from "./signing.js";

/**
 * Transport for the Crusoe Cloud API (`https://api.cloud.crusoe.ai/v1`, the
 * host Crusoe's own Terraform provider migrated to from
 * `api.crusoecloud.com/v1alpha5`). Every request is HMAC-signed; see
 * `signing.ts`. Goes through `services.http` when the host provides it, which
 * is what keeps bastion routing and custom CAs working.
 */

export const API_HOST = "https://api.cloud.crusoe.ai";
export const API_PREFIX = "/v1";

export class CrusoeApiError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, path: string, body: string) {
    super(`Crusoe API error ${status} for ${path}: ${summarizeBody(body)}`);
    this.name = "CrusoeApiError";
    this.status = status;
    this.body = body;
  }
}

/** Crusoe errors are `{code, message}`; show the message, not the JSON. */
function summarizeBody(body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: unknown; code?: unknown };
    if (typeof parsed.message === "string") return parsed.message;
  } catch {
    /* not JSON */
  }
  return body.slice(0, 500);
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Record<string, QueryValue>;
  body?: unknown;
  /**
   * Send `Authorization: Bearer <token>` instead of an HMAC signature. Only
   * the metrics endpoints use this, with a monitoring token.
   */
  bearerToken?: string;
}

export interface CrusoeCredentials {
  accessKeyId: string;
  secretKey: string;
  monitoringToken: string;
  caCert: string;
}

export class CrusoeApi {
  constructor(
    private readonly creds: CrusoeCredentials,
    private readonly services: HostServices | undefined,
  ) {}

  get monitoringToken(): string {
    return this.creds.monitoringToken;
  }

  /** Raw request: returns the response body as text. Throws on non-2xx. */
  async requestText(path: string, opts: RequestOptions = {}): Promise<string> {
    const method = opts.method ?? "GET";
    const fullPath = `${API_PREFIX}${path}`;
    const query = canonicalQuery(opts.query);
    const url = `${API_HOST}${fullPath}${query ? `?${query}` : ""}`;
    const auth = opts.bearerToken
      ? { Authorization: `Bearer ${opts.bearerToken}` }
      : await signRequest({
          accessKeyId: this.creds.accessKeyId,
          secretKey: this.creds.secretKey,
          method,
          path: fullPath,
          query,
        });
    const headers: Record<string, string> = {
      Accept: "application/json, text/csv",
      ...auth,
    };
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const http = this.services?.http;
    if (http) {
      const res = await http.request({
        url,
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        ...(this.creds.caCert ? { caCert: this.creds.caCert } : {}),
      });
      if (res.status < 200 || res.status >= 300) {
        throw new CrusoeApiError(res.status, path, res.body);
      }
      return res.body ?? "";
    }
    const res = await fetch(url, { method, headers, ...(body !== undefined ? { body } : {}) });
    const text = await res.text();
    if (!res.ok) throw new CrusoeApiError(res.status, path, text);
    return text;
  }

  async request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const text = await this.requestText(path, opts);
    if (!text) return undefined as unknown as T;
    return JSON.parse(text) as T;
  }

  /**
   * Every page of a list endpoint. Crusoe paginates with `next_token` in the
   * request and `next_page_token` in the response, and only some lists
   * paginate at all; one that returns no token is simply a single page.
   */
  async listAll<T>(path: string, query: Record<string, QueryValue> = {}): Promise<T[]> {
    const items: T[] = [];
    let token: string | undefined;
    for (let page = 0; page < 100; page++) {
      const res = await this.request<{ items?: T[]; next_page_token?: string }>(path, {
        query: { ...query, ...(token ? { next_token: token } : {}) },
      });
      items.push(...(res?.items ?? []));
      token = res?.next_page_token || undefined;
      if (!token) break;
    }
    return items;
  }
}

export function isStatus(err: unknown, ...statuses: number[]): boolean {
  return err instanceof CrusoeApiError && statuses.includes(err.status);
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
