/**
 * The request surface every Linode module uses.
 *
 * Linode API v4 (https://techdocs.akamai.com/linode-api/reference/api) is a
 * plain JSON REST API at `https://api.linode.com/v4`, authenticated with a
 * personal access token as `Authorization: Bearer <token>`. Collections are
 * paginated with `page` / `page_size` (25 to 500) and return
 * `{ data, page, pages, results }`; filtering rides in an `X-Filter` header
 * carrying a JSON object.
 *
 * Errors keep the HTTP status on the thrown object (`LinodeApiError.status`).
 * Hosts classify failures for backoff from that number, and reading a status
 * back out of prose is unreliable (see KNOWLEDGE.md, GCP section).
 */

import type { HostServices } from "@infrawrench/plugin-base";

export const LINODE_API_BASE = "https://api.linode.com/v4";
/** Akamai Cloud Pulse metrics live on their own host and version. */
export const LINODE_MONITOR_BASE = "https://monitor-api.linode.com/v2beta";

export class LinodeApiError extends Error {
  readonly status: number;
  constructor(status: number, path: string, body: string) {
    super(`Linode API error ${status} for ${path}: ${summariseErrorBody(body)}`);
    this.name = "LinodeApiError";
    this.status = status;
  }
}

/** Linode errors are `{ errors: [{ field?, reason }] }`; flatten them for a message. */
function summariseErrorBody(body: string): string {
  try {
    const parsed = JSON.parse(body) as { errors?: Array<{ field?: string; reason?: string }> };
    if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
      return parsed.errors
        .map((e) => (e.field ? `${e.field}: ${e.reason ?? ""}` : (e.reason ?? "")))
        .join("; ");
    }
  } catch {
    // Not JSON: fall through to the raw text.
  }
  return body.slice(0, 500);
}

export function statusOf(err: unknown): number | undefined {
  if (err && typeof err === "object" && "status" in err) {
    const s = (err as { status?: unknown }).status;
    if (typeof s === "number") return s;
  }
  return undefined;
}

export interface Page<T> {
  data: T[];
  page: number;
  pages: number;
  results: number;
}

export interface RequestOptions {
  /** Serialised into the `X-Filter` header. */
  filter?: Record<string, unknown>;
  query?: Record<string, string | number | boolean | undefined>;
}

export interface LinodeApi {
  get<T>(path: string, opts?: RequestOptions): Promise<T>;
  send<T>(method: "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T>;
  /** Every page of a collection. */
  all<T>(path: string, opts?: RequestOptions): Promise<T[]>;
  /** One request against the Cloud Pulse metrics host with a service-scoped token. */
  monitor<T>(path: string, token: string, body: unknown): Promise<T>;
}

export interface LinodeApiConfig {
  token: string;
  services?: HostServices | undefined;
  caCert?: string;
  baseUrl?: string;
  monitorBaseUrl?: string;
}

const PAGE_SIZE = 500;

function buildUrl(base: string, path: string, query?: RequestOptions["query"]): string {
  const url = `${base}${path}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== "") params.set(k, String(v));
  }
  const qs = params.toString();
  if (!qs) return url;
  return `${url}${url.includes("?") ? "&" : "?"}${qs}`;
}

export function createLinodeApi(config: LinodeApiConfig): LinodeApi {
  const base = config.baseUrl ?? LINODE_API_BASE;
  const monitorBase = config.monitorBaseUrl ?? LINODE_MONITOR_BASE;
  const http = config.services?.http;

  async function request<T>(
    method: string,
    url: string,
    errorPath: string,
    headers: Record<string, string>,
    body?: unknown,
  ): Promise<T> {
    const merged: Record<string, string> = {
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    };
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    if (http) {
      const res = await http.request({
        url,
        method,
        headers: merged,
        ...(payload !== undefined ? { body: payload } : {}),
        ...(config.caCert ? { caCert: config.caCert } : {}),
      });
      if (res.status < 200 || res.status >= 300) {
        throw new LinodeApiError(res.status, errorPath, res.body);
      }
      if (res.status === 204 || !res.body) return {} as T;
      return JSON.parse(res.body) as T;
    }
    const res = await fetch(url, {
      method,
      headers: merged,
      ...(payload !== undefined ? { body: payload } : {}),
    });
    if (!res.ok) throw new LinodeApiError(res.status, errorPath, await res.text());
    const text = await res.text();
    if (!text) return {} as T;
    return JSON.parse(text) as T;
  }

  const auth = { Authorization: `Bearer ${config.token}` };

  const api: LinodeApi = {
    get<T>(path: string, opts?: RequestOptions) {
      const headers: Record<string, string> = { ...auth };
      if (opts?.filter) headers["X-Filter"] = JSON.stringify(opts.filter);
      return request<T>("GET", buildUrl(base, path, opts?.query), path, headers);
    },
    send<T>(method: "POST" | "PUT" | "DELETE", path: string, body?: unknown) {
      return request<T>(
        method,
        `${base}${path}`,
        path,
        auth,
        body ?? (method === "DELETE" ? undefined : {}),
      );
    },
    async all<T>(path: string, opts?: RequestOptions) {
      const out: T[] = [];
      let page = 1;
      let pages = 1;
      do {
        const res = await api.get<Page<T>>(path, {
          ...opts,
          query: { ...(opts?.query ?? {}), page, page_size: PAGE_SIZE },
        });
        out.push(...(res.data ?? []));
        pages = Math.max(1, Number(res.pages ?? 1));
        page += 1;
        // Bounded: 200 pages of 500 is 100,000 objects, far beyond any account.
      } while (page <= pages && page <= 200);
      return out;
    },
    monitor<T>(path: string, token: string, body: unknown) {
      return request<T>(
        "POST",
        `${monitorBase}${path}`,
        path,
        { Authorization: `Bearer ${token}` },
        body,
      );
    },
  };
  return api;
}

/** Numeric/string id at the end of a host resource id (`acct:type:123`). */
export function trailingId(resourceId: string): string {
  const parts = resourceId.split(":");
  const id = parts.slice(2).join(":") || parts[parts.length - 1];
  if (!id) throw new Error(`Cannot parse resource ID "${resourceId}"`);
  return id;
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** `"true"`/`"false"` form values to booleans; anything else is "unchanged". */
export function formBool(value: string | undefined): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

/** Comma/newline separated text to a trimmed, de-duplicated list. */
export function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return [
    ...new Set(
      value
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}
