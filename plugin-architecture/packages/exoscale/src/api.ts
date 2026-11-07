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
 * pending/success/failure, `reference.id` of the affected resource); `settle`
 * polls `GET /operation/{id}` briefly so a create reports a real failure.
 * Errors carry the HTTP status on `ExoscaleApiError.status`.
 */

import {
  createApiClient,
  hostFetch,
  unencodedSegment,
  type ApiClient,
  type HostServices,
  type HttpHostServices,
  type NoSlashString,
} from "@infrawrench/plugin-base";
import type { components, paths } from "./api-types.gen.js";

export type Schemas = components["schemas"];

/** A provider object as a mapper reads it: what a create form synthesises has few of the fields. */
export type Sketch<T> = { [K in keyof T]?: T[K] | undefined };

type KeysOfUnion<T> = T extends T ? keyof T : never;
type ValueIn<T, K extends PropertyKey> = T extends { [P in K]?: infer V } ? V : never;

/** Every field of any variant of a union, optional, for reading what only some variants have. */
export type AnyVariant<T> = { [K in KeysOfUnion<T>]?: ValueIn<T, K> };

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
    const p: { message?: string } = JSON.parse(body);
    if (p.message) return p.message;
  } catch {
    // not JSON
  }
  return body.slice(0, 500);
}

export function statusOf(err: unknown): number | undefined {
  if (err && typeof err === "object" && "status" in err && typeof err.status === "number")
    return err.status;
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

export type Operation = Schemas["operation"];

/** One zone's endpoint: every operation of the document, and a way to wait for a mutation. */
export type ZoneApi = ApiClient<paths> & {
  /** Wait (briefly) for the operation a mutation answered with to finish. */
  settle(answer: Promise<Operation>): Promise<Operation>;
};

export interface ExoscaleApi {
  readonly apiKey: string;
  readonly apiSecret: string;
  at(zone: string): ZoneApi;
  /** Zones to offer on a form: the public zone list (cached), or a known list if it fails. */
  zones(): Promise<string[]>;
  /** The public zone list, or a throw: a sync over a known list would prune any zone it lacks. */
  liveZones(): Promise<string[]>;
  /** The host's transport with none of this API's signing, for what SigV4 signs itself. */
  fetch(url: string, init: RequestInit): Promise<Response>;
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

/**
 * A segment as the plugin has always sent it: ids reach the path unencoded, and one
 * missing from a form or a composite id reads as `undefined`.
 */
export const rawId = (value: string | undefined): NoSlashString => unencodedSegment(String(value));

/** `{ id }` for a body, where an id missing from a form has always just not been sent. */
export const byId = (id: string | undefined): { id?: string } => (id === undefined ? {} : { id });

/**
 * Signs each request (the message covers its URL and body), and sends it over the
 * host's HTTP service, or `fetch` where there is no host.
 *
 * Callers read every 2xx as an object, and an empty one has always been an empty
 * object, so that is what comes back: `restRequest` would make it `undefined`.
 */
function signedTransport(config: ExoscaleApiConfig): HttpHostServices {
  const host = config.services?.http;
  return {
    async request(req) {
      const payload = typeof req.body === "string" ? req.body : "";
      const expires = Math.floor(Date.now() / 1000) + 600;
      const headers = {
        Accept: "application/json",
        Authorization: await authorization(
          config.apiKey,
          config.apiSecret,
          req.method,
          req.url,
          payload,
          expires,
        ),
        ...req.headers,
      };
      let status: number;
      let body: string;
      if (host) {
        const res = await host.request({ ...req, headers });
        status = res.status;
        body = res.body;
      } else {
        const res = await fetch(req.url, {
          method: req.method,
          headers,
          ...(typeof req.body === "string" ? { body: req.body } : {}),
        });
        status = res.status;
        body = await res.text();
      }
      if (status >= 200 && status < 300 && (status === 204 || !body))
        return { status: 200, headers: {}, body: body || "{}" };
      return { status, headers: {}, body };
    },
  };
}

export function createExoscaleApi(config: ExoscaleApiConfig): ExoscaleApi {
  const endpoint = config.endpoint ?? endpointFor;
  const pollMs = config.pollMs ?? 1500;
  const http = signedTransport(config);
  const clients = new Map<string, ZoneApi>();
  let zoneList: Promise<string[]> | null = null;

  function at(zone: string): ZoneApi {
    const known = clients.get(zone);
    if (known) return known;
    const client = createApiClient<paths>({
      vendor: "Exoscale",
      baseUrl: endpoint(zone),
      headers: {},
      http,
      ...(config.caCert ? { caCert: config.caCert } : {}),
      contentType: "with-body",
      httpError: ({ status, path, body }) =>
        new ExoscaleApiError(status, path.split("?")[0] ?? path, body),
    });
    const zoned: ZoneApi = {
      ...client,
      async settle(answer) {
        let op = await answer;
        for (let i = 0; i < 20 && op.state === "pending" && op.id; i++) {
          if (pollMs > 0) await new Promise((r) => setTimeout(r, pollMs));
          op = await client.get(`/operation/${rawId(op.id)}`);
        }
        if (op.state === "failure" || op.state === "timeout") {
          throw Object.assign(
            new Error(
              `Exoscale operation ${op.state}: ${op.message || op.reason || "unknown reason"}`,
            ),
            { status: op.reason === "not-found" ? 404 : op.reason === "forbidden" ? 403 : 400 },
          );
        }
        return op;
      },
    };
    clients.set(zone, zoned);
    return zoned;
  }

  function liveZones(): Promise<string[]> {
    if (!zoneList) {
      const read = at(DEFAULT_ZONE)
        .get("/zone")
        .then((r) => {
          const names = (r.zones ?? []).map((z): string => z.name ?? "").filter(Boolean);
          if (!names.length) throw new Error("Exoscale's zone list holds no zones");
          return names;
        });
      read.catch(() => {
        zoneList = null;
      });
      zoneList = read;
    }
    return zoneList;
  }

  return {
    apiKey: config.apiKey,
    apiSecret: config.apiSecret,
    at,
    liveZones,
    zones: () => liveZones().catch(() => [...KNOWN_ZONES]),
    fetch: (url, init) =>
      hostFetch({ http: config.services?.http, caCert: config.caCert }, url, init),
  };
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
  "es-mad-1",
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
      const parsed = JSON.parse(t);
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

export function intOr(v: string | undefined, d: number): number;
export function intOr(v: string | undefined): number | undefined;
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
