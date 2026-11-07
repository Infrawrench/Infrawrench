import { ListPageError, ListTruncatedError, type HostServices } from "@infrawrench/plugin-base";
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
// 100,000 rows, the most one poll can read and write. The spec gives `limit` no maximum.
const MAX_PAGES = 1000;

/** Every field a `List*Reply` in the spec has besides its list. */
const PAGING_FIELDS = new Set(["count", "has_next", "limit", "offset", "order"]);

export type ListReply<T> = Record<string, T[] | string | number | boolean | null | undefined>;

function isEmptyReply<T>(reply: ListReply<T> | undefined): boolean {
  if (typeof reply !== "object" || reply === null || Array.isArray(reply)) return false;
  return (
    Object.keys(reply).every((field) => PAGING_FIELDS.has(field)) &&
    reply["has_next"] !== true &&
    !(Number(reply["count"] ?? 0) > 0)
  );
}

/**
 * The list on one answer. Koyeb answers through a gRPC gateway, where proto3 JSON can
 * leave an empty list out, so a missing key is no rows, but only on an answer with
 * nothing else in it that would say otherwise: a renamed key or an error wrapped in a
 * 200 has other fields, and a sync would read those as every row deleted.
 */
export function pageRows<T>(reply: ListReply<T> | undefined, key: string, path: string): T[] {
  const list = reply?.[key];
  if (Array.isArray(list)) return list;
  if (list === null || (list === undefined && isEmptyReply(reply))) return [];
  throw new ListPageError({ vendor: "Koyeb", path, key, found: list, page: reply });
}

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
      const res = await this.request<ListReply<T> | undefined>(path, {
        // Counted in rows, so a server answering fewer than asked for skips nothing.
        query: { ...query, limit: String(PAGE), offset: String(out.length) },
      });
      const rows = pageRows<T>(res, key, path);
      out.push(...rows);
      const saysMore = res?.["has_next"];
      if (rows.length === 0) {
        if (saysMore !== true) return out;
        throw new ListPageError({
          vendor: "Koyeb",
          path,
          key,
          found: rows,
          saysMoreWith: "no rows",
        });
      }
      // int64 fields arrive as JSON strings from Koyeb's gRPC gateway.
      const count = Number(res?.["count"] ?? Number.NaN);
      const hasNext =
        typeof saysMore === "boolean"
          ? saysMore
          : Number.isFinite(count)
            ? out.length < count
            : rows.length === PAGE;
      if (!hasNext) return out;
    }
    throw new ListTruncatedError({ vendor: "Koyeb", path, items: out.length, maxPages: MAX_PAGES });
  }
}
