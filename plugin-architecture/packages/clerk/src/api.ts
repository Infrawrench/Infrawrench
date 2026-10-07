import type { HostServices } from "@infrawrench/plugin-base";
import { apiError, sendRaw } from "./http.js";

/**
 * Clerk Backend API transport (https://api.clerk.com/v1). Shapes verified
 * against Clerk's published spec (github.com/clerk/openapi-specs,
 * bapi/2026-05-12.yml). Auth is `Authorization: Bearer sk_live_…` (or
 * `sk_test_…` for a development instance); the key is per instance.
 */

export const BASE_URL = "https://api.clerk.com/v1";
/** Pinned so a future Clerk version cannot change response shapes under us. */
export const API_VERSION = "2026-05-12";

export type Query = Record<string, string | number | boolean | undefined>;

export interface RequestOptions {
  method?: string;
  query?: Query;
  body?: unknown;
}

export class ClerkApi {
  constructor(
    private readonly secretKey: string,
    private readonly caCert: string,
    private readonly services: HostServices | undefined,
  ) {}

  get isDevelopment(): boolean {
    return this.secretKey.startsWith("sk_test_");
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const res = await sendRaw(
      {
        url: `${BASE_URL}${path}${buildQuery(options.query)}`,
        method: options.method ?? "GET",
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          Accept: "application/json",
          "Clerk-API-Version": API_VERSION,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body } : {}),
      },
      this.services,
      this.caCert,
    );
    if (res.status < 200 || res.status >= 300) throw apiError(res.status, path, res.body);
    return (res.body ? JSON.parse(res.body) : undefined) as T;
  }

  /**
   * Offset pagination (`limit` ≤ 500). Some endpoints answer a bare array,
   * others `{data, total_count}`; both are handled.
   */
  async list<T>(path: string, query: Query = {}, maxItems = 2500): Promise<T[]> {
    const out: T[] = [];
    const limit = 500;
    for (let offset = 0; offset < maxItems; offset += limit) {
      const body = await this.request<T[] | { data?: T[]; total_count?: number }>(path, {
        query: { ...query, limit, offset },
      });
      const items = Array.isArray(body) ? body : (body?.data ?? []);
      out.push(...items);
      const total = Array.isArray(body) ? undefined : body?.total_count;
      if (items.length < limit || (total !== undefined && out.length >= total)) break;
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
