import type { HostServices } from "@infrawrench/plugin-base";
import { KoyebApiError, buildQuery, sendRequest, type QueryValue } from "./kit.js";

/**
 * Transport for the Koyeb public API (`https://app.koyeb.com`, Swagger 2.0
 * spec at https://api.prod.koyeb.com/public.swagger.json, read 2026-10).
 *
 * Auth is `Authorization: Bearer <token>` with an organization API access
 * token. Lists page with `limit` / `offset` (strings in the spec) and answer
 * `has_next` or `count`; 100 is used per page.
 */

export const API_BASE = "https://app.koyeb.com";
const PAGE = 100;
const MAX_PAGES = 30;

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  query?: Record<string, QueryValue>;
  body?: unknown;
}

export class KoyebApi {
  constructor(
    private readonly token: string,
    private readonly caCert: string,
    private readonly services: HostServices | undefined,
  ) {}

  async request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const method = opts.method ?? "GET";
    const query = buildQuery(opts.query);
    const url = `${API_BASE}${path}${query ? `?${query}` : ""}`;
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${this.token}`,
    };
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await sendRequest(this.services, this.caCert, {
      url,
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
    });
    if (res.status < 200 || res.status >= 300) {
      throw new KoyebApiError(res.status, method, path, res.body);
    }
    if (!res.body) return undefined as unknown as T;
    return JSON.parse(res.body) as T;
  }

  /** Every page of an offset-paginated list; `key` is the array property. */
  async listAll<T>(
    path: string,
    key: string,
    query: Record<string, QueryValue> = {},
  ): Promise<T[]> {
    const out: T[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await this.request<Record<string, unknown>>(path, {
        query: { ...query, limit: String(PAGE), offset: String(page * PAGE) },
      });
      const rows = Array.isArray(res?.[key]) ? (res[key] as T[]) : [];
      out.push(...rows);
      // int64 fields arrive as JSON strings from Koyeb's gRPC gateway.
      const count = Number(res?.["count"]);
      const hasNext =
        typeof res?.["has_next"] === "boolean"
          ? (res["has_next"] as boolean)
          : Number.isFinite(count) && res?.["count"] !== undefined
            ? out.length < count
            : rows.length === PAGE;
      if (!hasNext || rows.length === 0) break;
    }
    return out;
  }
}
