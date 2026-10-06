import type { HostServices } from "@infrawrench/plugin-base";
import { HerokuApiError, buildQuery, sendRequest, type QueryValue } from "./kit.js";

/**
 * Transport for the Heroku Platform API (`https://api.heroku.com`, JSON
 * hyper-schema at https://api.heroku.com/schema, read 2026-10).
 *
 * Every request carries `Accept: application/vnd.heroku+json; version=3`
 * and `Authorization: Bearer <api key or OAuth token>`.
 *
 * Lists page with the `Range` header: ask for `id ..; max=1000;`, and while
 * the answer is `206 Partial Content` send its `Next-Range` header back as
 * the next `Range`. A user gets 4,500 requests an hour (`RateLimit-Remaining`
 * reports what is left); a 429 surfaces with its status.
 */

export const API_BASE = "https://api.heroku.com";
const ACCEPT = "application/vnd.heroku+json; version=3";
const MAX_PAGES = 20;

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  query?: Record<string, QueryValue>;
  body?: unknown;
  headers?: Record<string, string>;
}

export class HerokuApi {
  constructor(
    private readonly token: string,
    private readonly caCert: string,
    private readonly services: HostServices | undefined,
  ) {}

  private async raw(path: string, opts: RequestOptions = {}) {
    const method = opts.method ?? "GET";
    const query = buildQuery(opts.query);
    const url = `${API_BASE}${path}${query ? `?${query}` : ""}`;
    const headers: Record<string, string> = {
      Accept: ACCEPT,
      Authorization: `Bearer ${this.token}`,
      ...opts.headers,
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
      throw new HerokuApiError(res.status, method, path, res.body);
    }
    return res;
  }

  async request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const res = await this.raw(path, opts);
    if (!res.body) return undefined as unknown as T;
    return JSON.parse(res.body) as T;
  }

  /** Every page of a list, following `Next-Range` while the API answers 206. */
  async listAll<T>(path: string, query?: Record<string, QueryValue>): Promise<T[]> {
    const out: T[] = [];
    let range = "id ..; max=1000;";
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await this.raw(path, { ...(query ? { query } : {}), headers: { Range: range } });
      const rows = res.body ? (JSON.parse(res.body) as T[]) : [];
      if (Array.isArray(rows)) out.push(...rows);
      const next = res.headers["next-range"];
      if (res.status !== 206 || !next || next === range) break;
      range = next;
    }
    return out;
  }

  /** Fetch a URL the API handed back (log session), as text. */
  async fetchText(url: string): Promise<string> {
    const res = await sendRequest(this.services, this.caCert, {
      url,
      method: "GET",
      headers: { Accept: "text/plain" },
    });
    if (res.status < 200 || res.status >= 300) {
      throw new HerokuApiError(res.status, "GET", "log session", res.body);
    }
    return res.body;
  }
}
