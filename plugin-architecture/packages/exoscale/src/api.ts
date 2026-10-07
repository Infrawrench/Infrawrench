/**
 * The request surface every Exoscale module uses.
 *
 * Exoscale API v2 is served per zone at `https://api-{zone}.exoscale.com/v2`
 * (the list comes from `GET /v2/zone`, which needs no credentials).
 * Zonal resources (instances, volumes, private networks, elastic IPs, SKS,
 * NLBs, instance pools, snapshots, templates) are listed on their zone's
 * endpoint; account-wide ones (security groups, anti-affinity groups, SSH
 * keys, DNS, IAM, quotas, usage) answer on any zone.
 *
 * Requests are signed with Exoscale's own scheme, `EXO2-HMAC-SHA256`
 * (verified against `exoscale/egoscale` v3 `signRequest`, 2026-10-06):
 *
 *   message = "{METHOD} {escaped path}\n{body}\n{values of single-valued
 *              query params, sorted by name, concatenated}\n\n{expires}"
 *   Authorization: EXO2-HMAC-SHA256 credential={key}
 *                  [,signed-query-args={names;…}],expires={unix},
 *                  signature={base64(HMAC-SHA256(secret, message))}
 *
 * Mutations are asynchronous and return an `operation` (`state`
 * pending/success/failure, `reference.id` of the affected resource); `wait`
 * polls `GET /operation/{id}` briefly so a create reports a real failure.
 * Errors carry the HTTP status on `ExoscaleApiError.status`.
 */

import type { HostServices } from "@infrawrench/plugin-base";

export const DEFAULT_ZONE = "ch-gva-2";
export const endpointFor = (zone: string) => `https://api-${zone}.exoscale.com/v2`;

export class ExoscaleApiError extends Error {
  readonly status: number;
  constructor(status: number, path: string, body: string) {
    super(`Exoscale API error ${status} for ${path}: ${summarise(body)}`);
    this.name = "ExoscaleApiError";
    this.status = status;
  }
}

function summarise(body: string): string {
  try {
    const p = JSON.parse(body) as { message?: string; errors?: unknown };
    if (p.message) return p.message;
  } catch {
    // not JSON
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

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** RFC 3986-ish path escaping like Go's `URL.EscapedPath` for our paths. */
export function escapedPath(url: string): string {
  return new URL(url).pathname;
}

export async function signature(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await globalThis.crypto.subtle.sign("HMAC", key, enc.encode(message));
  return toBase64(new Uint8Array(sig));
}

/** Build the `Authorization` header for one request. */
export async function authorization(
  apiKey: string,
  apiSecret: string,
  method: string,
  url: string,
  body: string,
  expiresUnix: number,
): Promise<string> {
  const u = new URL(url);
  const params = new Map<string, string[]>();
  u.searchParams.forEach((value, name) => params.set(name, [...(params.get(name) ?? []), value]));
  const signed = [...params.entries()]
    .filter(([, v]) => v.length === 1)
    .map(([k]) => k)
    .sort();
  const values = signed.map((k) => params.get(k)![0]).join("");
  const message = [`${method} ${u.pathname}`, body, values, "", String(expiresUnix)].join("\n");
  const parts = [`EXO2-HMAC-SHA256 credential=${apiKey}`];
  if (signed.length) parts.push(`signed-query-args=${signed.join(";")}`);
  parts.push(`expires=${expiresUnix}`);
  parts.push(`signature=${await signature(apiSecret, message)}`);
  return parts.join(",");
}

export interface Operation {
  id?: string;
  state?: "pending" | "success" | "failure" | "timeout";
  reason?: string;
  message?: string;
  reference?: { id?: string; link?: string };
}

export interface ExoscaleApi {
  readonly apiKey: string;
  readonly apiSecret: string;
  get<T>(zone: string, path: string): Promise<T>;
  send<T>(
    zone: string,
    method: "POST" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T>;
  /** Send a mutation and wait (briefly) for its operation to finish. */
  mutate(
    zone: string,
    method: "POST" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<Operation>;
  /** Zones the account can use, from the public zone list (cached). */
  zones(): Promise<string[]>;
}

export interface ExoscaleApiConfig {
  apiKey: string;
  apiSecret: string;
  services?: HostServices | undefined;
  caCert?: string;
  /** Override for tests: maps a zone to a base URL. */
  endpoint?: (zone: string) => string;
  /** Poll delay for operations (tests set 0). */
  pollMs?: number;
}

export function createExoscaleApi(config: ExoscaleApiConfig): ExoscaleApi {
  const endpoint = config.endpoint ?? endpointFor;
  const http = config.services?.http;
  const pollMs = config.pollMs ?? 1500;
  let zoneList: Promise<string[]> | null = null;

  async function request<T>(
    zone: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${endpoint(zone)}${path}`;
    const payload = body !== undefined ? JSON.stringify(body) : "";
    const expires = Math.floor(Date.now() / 1000) + 600;
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: await authorization(
        config.apiKey,
        config.apiSecret,
        method,
        url,
        payload,
        expires,
      ),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    };
    let status: number;
    let text: string;
    if (http) {
      const res = await http.request({
        url,
        method,
        headers,
        ...(body !== undefined ? { body: payload } : {}),
        ...(config.caCert ? { caCert: config.caCert } : {}),
      });
      status = res.status;
      text = res.body;
    } else {
      const res = await fetch(url, {
        method,
        headers,
        ...(body !== undefined ? { body: payload } : {}),
      });
      status = res.status;
      text = await res.text();
    }
    if (status < 200 || status >= 300)
      throw new ExoscaleApiError(status, path.split("?")[0] ?? path, text);
    if (!text) return {} as T;
    return JSON.parse(text) as T;
  }

  const api: ExoscaleApi = {
    apiKey: config.apiKey,
    apiSecret: config.apiSecret,
    get: <T>(zone: string, path: string) => request<T>(zone, "GET", path),
    send: <T>(zone: string, method: "POST" | "PUT" | "DELETE", path: string, body?: unknown) =>
      request<T>(zone, method, path, body),
    async mutate(zone, method, path, body) {
      let op = await request<Operation>(zone, method, path, body);
      for (let i = 0; i < 20 && op.state === "pending" && op.id; i++) {
        if (pollMs > 0) await new Promise((r) => setTimeout(r, pollMs));
        op = await request<Operation>(zone, "GET", `/operation/${op.id}`);
      }
      if (op.state === "failure" || op.state === "timeout") {
        const err = new Error(
          `Exoscale operation ${op.state}: ${op.message || op.reason || "unknown reason"}`,
        ) as Error & {
          status: number;
        };
        err.status = op.reason === "not-found" ? 404 : op.reason === "forbidden" ? 403 : 400;
        throw err;
      }
      return op;
    },
    zones() {
      if (!zoneList) {
        zoneList = request<{ zones?: Array<{ name?: string }> }>(DEFAULT_ZONE, "GET", "/zone")
          .then((r) => (r.zones ?? []).map((z) => z.name ?? "").filter(Boolean))
          .then((z) => (z.length ? z : [DEFAULT_ZONE]))
          .catch(() => {
            zoneList = null;
            return [...KNOWN_ZONES];
          });
      }
      return zoneList;
    },
  };
  return api;
}

export const KNOWN_ZONES = [
  "ch-gva-2",
  "ch-dk-2",
  "de-fra-1",
  "de-muc-1",
  "at-vie-1",
  "at-vie-2",
  "bg-sof-1",
  "hr-zag-1",
];

export function zonal(resourceId: string): { zone: string; id: string } {
  const ext = resourceId.split(":").slice(2).join(":");
  const i = ext.indexOf("/");
  if (i < 0) return { zone: DEFAULT_ZONE, id: ext };
  return { zone: ext.slice(0, i), id: ext.slice(i + 1) };
}

export function trailingId(resourceId: string): string {
  return resourceId.split(":").slice(2).join(":");
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

export function labelsText(labels: Record<string, string> | undefined): string {
  return Object.entries(labels ?? {})
    .map(([k, v]) => (v ? `${k}=${v}` : k))
    .join(", ");
}

export function labelsFromText(text: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of listValue(text)) {
    const i = pair.indexOf("=");
    if (i < 0) out[pair] = "";
    else out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return out;
}

export function utf8ToBase64(text: string): string {
  return toBase64(new TextEncoder().encode(text));
}
