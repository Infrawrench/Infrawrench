/**
 * The request surface every UpCloud module uses.
 *
 * UpCloud API 1.3 (https://developers.upcloud.com/1.3/) lives at
 * `https://api.upcloud.com/1.3`. It accepts either an API token
 * (`Authorization: Bearer ucat_...`) or an API-enabled user's credentials
 * (HTTP Basic), exactly as the official Go SDK (`UpCloudLtd/upcloud-go-api`,
 * 2026-09) does.
 *
 * Two generations of endpoint coexist:
 * - The original IaaS endpoints (servers, storages, networks, routers, IP
 *   addresses, firewall rules, zones, plans, prices, account) wrap
 *   everything twice: `{ "servers": { "server": [ ... ] } }`, numbers often
 *   arrive as strings, and requests are wrapped the same way
 *   (`{ "server": { ... } }`). Errors are `{ "error": { error_code,
 *   error_message } }`.
 * - The managed services (Kubernetes, databases, load balancers, Managed
 *   Object Storage) return bare JSON, page with `limit`/`offset` (max 100),
 *   and fail with RFC 7807 problems (`{ type, title, status }`).
 *
 * The HTTP status is kept on thrown errors (`UpCloudApiError.status`).
 */

import type { HostServices } from "@infrawrench/plugin-base";

export const UPCLOUD_API_BASE = "https://api.upcloud.com/1.3";

export class UpCloudApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(status: number, path: string, body: string) {
    const parsed = parseError(body);
    super(`UpCloud API error ${status} for ${path}: ${parsed.message}`);
    this.name = "UpCloudApiError";
    this.status = status;
    this.code = parsed.code;
  }
}

function parseError(body: string): { message: string; code?: string } {
  try {
    const p = JSON.parse(body) as {
      error?: { error_code?: string; error_message?: string };
      title?: string;
      type?: string;
      invalid_params?: Array<{ name?: string; reason?: string }>;
    };
    if (p.error?.error_message) {
      return {
        message: p.error.error_message,
        ...(p.error.error_code ? { code: p.error.error_code } : {}),
      };
    }
    if (p.title) {
      const params = (p.invalid_params ?? []).map((i) => `${i.name}: ${i.reason}`).join("; ");
      const code = p.type?.includes("#")
        ? p.type
            .split("#")
            .pop()
            ?.replace(/^ERROR_/, "")
        : p.type;
      return { message: params ? `${p.title} (${params})` : p.title, ...(code ? { code } : {}) };
    }
  } catch {
    // not JSON
  }
  return { message: body.slice(0, 500) };
}

export function statusOf(err: unknown): number | undefined {
  if (err && typeof err === "object" && "status" in err) {
    const s = (err as { status?: unknown }).status;
    if (typeof s === "number") return s;
  }
  return undefined;
}

export interface UpCloudApi {
  get<T>(path: string): Promise<T>;
  send<T>(method: "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T>;
  /** Every item of a `limit`/`offset` paged managed-service collection. */
  paged<T>(path: string): Promise<T[]>;
}

export interface UpCloudCredentials {
  apiToken?: string;
  username?: string;
  password?: string;
}

export interface UpCloudApiConfig extends UpCloudCredentials {
  services?: HostServices | undefined;
  caCert?: string;
  baseUrl?: string;
}

function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function authHeader(c: UpCloudCredentials): string {
  if (c.apiToken) return `Bearer ${c.apiToken}`;
  if (c.username && c.password) return `Basic ${base64(`${c.username}:${c.password}`)}`;
  throw new Error("UpCloud plugin: enter an API token, or an API username and password");
}

const PAGE = 100;

export function createUpCloudApi(config: UpCloudApiConfig): UpCloudApi {
  const base = config.baseUrl ?? UPCLOUD_API_BASE;
  const http = config.services?.http;
  const authorization = authHeader(config);

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${base}${path}`;
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: authorization,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    };
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    let status: number;
    let text: string;
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
    } else {
      const res = await fetch(url, {
        method,
        headers,
        ...(payload !== undefined ? { body: payload } : {}),
      });
      status = res.status;
      text = await res.text();
    }
    if (status < 200 || status >= 300)
      throw new UpCloudApiError(status, path.split("?")[0] ?? path, text);
    if (status === 204 || !text) return {} as T;
    return JSON.parse(text) as T;
  }

  const api: UpCloudApi = {
    get: <T>(path: string) => request<T>("GET", path),
    send: <T>(method: "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown) =>
      request<T>(method, path, body),
    async paged<T>(path: string) {
      const out: T[] = [];
      for (let offset = 0; offset < 100 * PAGE; offset += PAGE) {
        const sep = path.includes("?") ? "&" : "?";
        const page = await request<T[]>("GET", `${path}${sep}limit=${PAGE}&offset=${offset}`);
        if (!Array.isArray(page)) break;
        out.push(...page);
        if (page.length < PAGE) break;
      }
      return out;
    },
  };
  return api;
}

/** Unwrap the legacy double envelope: `{ servers: { server: [...] } }`. */
export function unwrap<T>(value: unknown, outer: string, inner: string): T[] {
  const o = (value as Record<string, unknown> | undefined)?.[outer];
  const i = (o as Record<string, unknown> | undefined)?.[inner];
  return Array.isArray(i) ? (i as T[]) : [];
}

export function trailingId(resourceId: string): string {
  return resourceId.split(":").slice(2).join(":");
}

export function splitPair(id: string): [string, string] {
  const i = id.indexOf("/");
  return i < 0 ? [id, ""] : [id.slice(0, i), id.slice(i + 1)];
}

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

export async function mapPooled<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

/** UpCloud labels (`[{key,value}]` or `{label:[...]}`) as `k=v, k2=v2`. */
export function labelsText(labels: unknown): string {
  const list = Array.isArray(labels)
    ? labels
    : Array.isArray((labels as { label?: unknown } | undefined)?.label)
      ? (labels as { label: unknown[] }).label
      : [];
  return (list as Array<{ key?: string; value?: string }>)
    .map((l) => (l.value ? `${l.key}=${l.value}` : `${l.key ?? ""}`))
    .filter(Boolean)
    .join(", ");
}

export function labelsFromText(text: string | undefined): Array<{ key: string; value: string }> {
  return listValue(text).map((pair) => {
    const i = pair.indexOf("=");
    return i < 0
      ? { key: pair, value: "" }
      : { key: pair.slice(0, i).trim(), value: pair.slice(i + 1).trim() };
  });
}
