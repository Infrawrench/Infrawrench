import type { HostServices } from "@infrawrench/plugin-base";
import { RenderApiError, buildQuery, sendRequest, type QueryValue } from "./kit.js";

/**
 * Transport for the Render public REST API (`https://api.render.com/v1`,
 * OpenAPI spec at https://api-docs.render.com, verified 2026-10).
 *
 * Auth is `Authorization: Bearer <api key>`. A key belongs to a user and sees
 * every workspace that user belongs to.
 *
 * Lists are arrays of `{<item>, cursor}` wrappers; the next page is
 * `?cursor=<last cursor>` and the list ends on a short page. `limit` tops
 * out at 100.
 *
 * Rate limits (per user): 400 GETs a minute, 30 other writes a minute,
 * 30 log reads a minute, 10 deploy/suspend/resume/PATCH a minute per
 * service, 20 service creations an hour. A 429 is retried once after
 * `Ratelimit-Reset` when that is a few seconds; otherwise it surfaces.
 */

export const API_BASE = "https://api.render.com/v1";
const PAGE_SIZE = 100;
const MAX_PAGES = 50;
const MAX_RETRY_S = 5;

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  query?: Record<string, QueryValue>;
  body?: unknown;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class RenderApi {
  constructor(
    private readonly apiKey: string,
    private readonly caCert: string,
    private readonly services: HostServices | undefined,
  ) {}

  async request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const method = opts.method ?? "GET";
    const query = buildQuery(opts.query);
    const url = `${API_BASE}${path}${query ? `?${query}` : ""}`;
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    };
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const req = { url, method, headers, ...(body !== undefined ? { body } : {}) };

    let res = await sendRequest(this.services, this.caCert, req);
    if (res.status === 429) {
      const reset = Number(res.headers["ratelimit-reset"]);
      if (Number.isFinite(reset) && reset >= 0 && reset <= MAX_RETRY_S) {
        await sleep(reset * 1000);
        res = await sendRequest(this.services, this.caCert, req);
      }
    }
    if (res.status < 200 || res.status >= 300) {
      throw new RenderApiError(res.status, method, path, res.body);
    }
    if (!res.body) return undefined as unknown as T;
    return JSON.parse(res.body) as T;
  }

  /**
   * Every page of a cursor-paginated list. `key` names the wrapper property
   * (`service`, `postgres`, …); rows without it are taken as-is, since a few
   * lists (environment groups, maintenance runs) are not wrapped.
   */
  async listAll<T>(
    path: string,
    key: string,
    query: Record<string, QueryValue> = {},
    maxPages = MAX_PAGES,
  ): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const rows = await this.request<Array<Record<string, unknown>>>(path, {
        query: { ...query, limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) },
      });
      const list = Array.isArray(rows) ? rows : [];
      for (const row of list) {
        out.push((key in row ? row[key] : row) as T);
      }
      const last = list[list.length - 1];
      const nextCursor = last && typeof last["cursor"] === "string" ? last["cursor"] : undefined;
      if (list.length < PAGE_SIZE || !nextCursor || nextCursor === cursor) break;
      cursor = nextCursor;
    }
    return out;
  }
}
