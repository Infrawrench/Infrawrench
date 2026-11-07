/**
 * The request surface every Vultr module uses.
 *
 * Vultr API v2 (https://www.vultr.com/api/) is a JSON REST API at
 * `https://api.vultr.com/v2`, authenticated with an account API key sent as
 * `Authorization: Bearer <key>`. Collections are cursor-paginated: `per_page`
 * (up to 500) and `cursor`, with the next cursor in `meta.links.next` (an
 * empty string on the last page). Every response wraps its payload in a
 * named envelope (`{ instances: [...] }`, `{ instance: {...} }`), so listers
 * pass the envelope key.
 *
 * Errors are `{ "error": "...", "status": 400 }`. The HTTP status is kept on
 * the thrown object (`VultrApiError.status`) because the hosts classify
 * failures for backoff from that number.
 *
 * Verified against Vultr's own Go client (`vultr/govultr` v3.33.1, 2026-10-05)
 * which tracks the API reference.
 */

import {
  hostFetch,
  ListPageError,
  ListTruncatedError,
  requireListPage,
  type HostServices,
} from "@infrawrench/plugin-base";

export const VULTR_API_BASE = "https://api.vultr.com/v2";

export class VultrApiError extends Error {
  readonly status: number;
  constructor(status: number, path: string, body: string) {
    super(`Vultr API error ${status} for ${path}: ${summariseErrorBody(body)}`);
    this.name = "VultrApiError";
    this.status = status;
  }
}

function summariseErrorBody(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: string; message?: string };
    if (parsed.error) return parsed.error;
    if (parsed.message) return parsed.message;
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

export interface VultrMeta {
  total?: number;
  links?: { next?: string; prev?: string };
}

export type Query = Record<string, string | number | boolean | undefined>;

export interface VultrApi {
  get<T>(path: string, query?: Query): Promise<T>;
  send<T>(method: "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T>;
  /** Every page of a collection; `key` names the envelope array. */
  all<T>(path: string, key: string, query?: Query): Promise<T[]>;
  /** The host's transport with none of this API's auth, for a signed S3 call. */
  fetch(url: string, init: RequestInit): Promise<Response>;
}

export interface VultrApiConfig {
  apiKey: string;
  services?: HostServices | undefined;
  caCert?: string;
  baseUrl?: string;
  /** The first wait after a 429, doubled per retry. Tests pass 0. */
  retryDelayMs?: number;
}

const PAGE_SIZE = 500;
// 200 pages of 500 is the 100,000-row ceiling a sync can read in one poll.
const MAX_PAGES = 200;
// Vultr limits an API key to 30 requests a second, which the listers' fan-outs over
// domains, databases and subscriptions can reach on a large account.
const THROTTLE_RETRIES = 3;
const MAX_RETRY_WAIT_MS = 10_000;

function retryWait(headers: Record<string, string>, attempt: number, baseMs: number): number {
  const header = Object.entries(headers).find(([k]) => k.toLowerCase() === "retry-after")?.[1];
  const seconds = header === undefined ? Number.NaN : Number(header);
  const wait = Number.isFinite(seconds) ? seconds * 1000 : baseMs * 2 ** attempt;
  return Math.min(Math.max(0, wait), MAX_RETRY_WAIT_MS);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function buildUrl(base: string, path: string, query?: Query): string {
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

export function createVultrApi(config: VultrApiConfig): VultrApi {
  const base = config.baseUrl ?? VULTR_API_BASE;
  const http = config.services?.http;

  async function request<T>(method: string, url: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      // Empty key: the public catalog endpoints (/regions, /plans, /os)
      // answer anonymously, which is what lets pricing work without a key.
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    };
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    let status = 0;
    let text = "";
    // Only a read is retried: a throttled write may or may not have been applied.
    const attempts = method === "GET" ? THROTTLE_RETRIES + 1 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      let resHeaders: Record<string, string>;
      if (http) {
        const res = await http.request({
          url,
          method,
          headers,
          ...(payload !== undefined ? { body: payload } : {}),
          ...(config.caCert ? { caCert: config.caCert } : {}),
        });
        status = res.status;
        text = res.body;
        resHeaders = res.headers;
      } else {
        const res = await fetch(url, {
          method,
          headers,
          ...(payload !== undefined ? { body: payload } : {}),
        });
        status = res.status;
        text = await res.text();
        resHeaders = Object.fromEntries(res.headers.entries());
      }
      if (status !== 429 || attempt === attempts - 1) break;
      await sleep(retryWait(resHeaders, attempt, config.retryDelayMs ?? 1000));
    }
    if (status < 200 || status >= 300) throw new VultrApiError(status, path, text);
    if (status === 204 || !text) return {} as T;
    return JSON.parse(text) as T;
  }

  const api: VultrApi = {
    fetch: (url, init) => hostFetch({ http, caCert: config.caCert }, url, init),
    get<T>(path: string, query?: Query) {
      return request<T>("GET", buildUrl(base, path, query), path);
    },
    send<T>(method: "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown) {
      return request<T>(method, `${base}${path}`, path, body);
    },
    async all<T>(path: string, key: string, query?: Query) {
      const out: T[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const res = await api.get<Record<string, unknown> & { meta?: VultrMeta }>(path, {
          ...(query ?? {}),
          per_page: PAGE_SIZE,
          ...(cursor ? { cursor } : {}),
        });
        const items = res[key];
        if (items !== null && !Array.isArray(items)) {
          throw new ListPageError({ vendor: "Vultr", path, key, found: items, page: res });
        }
        out.push(...requireListPage<T>(items, { vendor: "Vultr", path, key }));
        const next = res.meta?.links?.next;
        if (!next) return out;
        if (next === cursor) {
          throw new ListPageError({
            vendor: "Vultr",
            path,
            key,
            found: items,
            saysMoreWith: "no cursor",
          });
        }
        cursor = next;
      }
      throw new ListTruncatedError({
        vendor: "Vultr",
        path,
        items: out.length,
        maxPages: MAX_PAGES,
      });
    },
  };
  return api;
}

/** The provider id at the end of a host resource id (`acct:type:abc`). */
export function trailingId(resourceId: string): string {
  const parts = resourceId.split(":");
  const id = parts.slice(2).join(":") || parts[parts.length - 1];
  if (!id) throw new Error(`Cannot parse resource ID "${resourceId}"`);
  return id;
}

/** `"true"`/`"false"` form values to booleans; anything else is "unchanged". */
export function formBool(value: string | undefined): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

/** A JSON array (policy-picker) or comma/newline list into trimmed, de-duplicated strings. */
export function listValue(v: string | undefined): string[] {
  if (!v) return [];
  const t = v.trim();
  if (t.startsWith("[")) {
    try {
      const parsed = JSON.parse(t) as unknown;
      if (Array.isArray(parsed)) return [...new Set(parsed.map(String).filter(Boolean))];
    } catch {
      // fall through
    }
  }
  return [
    ...new Set(
      t
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

export function intOr(v: string | undefined, d?: number): number | undefined {
  if (v === undefined || v === "") return d;
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? n : d;
}

/** UTF-8 safe base64 helpers (startup scripts and user data are base64 on the wire). */
export function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function fromBase64(b64: string): string {
  try {
    const bin = atob(b64.replace(/\s+/g, ""));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return b64;
  }
}
