import {
  createApiClient,
  type ApiClient,
  type HttpHostServices,
  type ParamValue,
} from "@infrawrench/plugin-base";
import type { paths } from "./api-types.gen.js";

/**
 * One Nomad HTTP API endpoint (`/v1` on any server or client agent, which
 * forwards to the leader). The ACL token goes in `X-Nomad-Token`; `region`
 * targets another federated region.
 *
 * Reference: https://developer.hashicorp.com/nomad/api-docs (Nomad 2.0,
 * hashicorp/web-unified-docs `content/nomad/v2.0.x`, read 2026-10). The generated
 * types come from hashicorp/nomad-openapi, archived in 2023 at about Nomad 1.6;
 * `plugingen.json` patches in what it lacks, so nothing will flag a newer API.
 */
export interface NomadContext {
  address: string;
  token?: string;
  region?: string;
  caCert?: string;
  http?: HttpHostServices;
}

export class NomadApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "NomadApiError";
    this.status = status;
  }
}

export function statusOf(err: unknown): number {
  return err instanceof NomadApiError ? err.status : 0;
}

/** `nomad.internal` → `https://nomad.internal:4646`-style origin, minus `/v1` and `/ui`. */
export function normaliseAddress(raw: string): string {
  let value = raw.trim();
  if (!value) return "";
  if (!/^https?:\/\//i.test(value)) {
    value = `${/^(localhost|127\.)/.test(value) ? "http" : "https"}://${value}`;
  }
  return value
    .replace(/[#?].*$/, "")
    .replace(/\/+$/, "")
    .replace(/\/(v1|ui)(\/.*)?$/i, "")
    .replace(/\/+$/, "");
}

export function buildContext(
  credentials: Record<string, string>,
  http?: HttpHostServices,
): NomadContext {
  const address = normaliseAddress(credentials["address"] ?? "");
  if (!address) throw new Error("Nomad plugin: missing the Nomad address");
  const token = (credentials["token"] ?? "").trim();
  const region = (credentials["region"] ?? "").trim();
  const caCert = credentials["caCert"] ?? "";
  return {
    address,
    ...(token ? { token } : {}),
    ...(region ? { region } : {}),
    ...(caCert.trim() ? { caCert } : {}),
    ...(http ? { http } : {}),
  };
}

export type NomadApi = ApiClient<paths>;

/** Stands in front of a call's own query, so the transport can tell it from a `?` in an unencoded id. */
const OWN_QUERY_MARK = "\u0000";
const OWN_QUERY = /[?&]\u0000/;

/** Dropping `""` lets an id with an empty half leave its namespace out rather than send `namespace=`. */
function writeQuery(query: Record<string, ParamValue>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query))
    if (v !== undefined && v !== "") params.set(k, String(v));
  return `${OWN_QUERY_MARK}${params.toString()}`;
}

/** Text a 2xx sent that is not JSON stays text: `restRequest` would throw on it. */
function jsonOrText(text: string): string {
  if (!text) return text;
  try {
    JSON.parse(text);
    return text;
  } catch {
    return JSON.stringify(text);
  }
}

/**
 * The host's HTTP service, or `fetch` where there is no host (which cannot honour a
 * custom CA). Every query opens with `?` and the region, whatever the path holds and
 * whether or not the call has a query of its own: `scopeQuery` goes after the call's.
 */
function nomadTransport(ctx: NomadContext): HttpHostServices {
  const region = ctx.region ? new URLSearchParams({ region: ctx.region }).toString() : "";
  return {
    async request(req) {
      const [target = "", own = ""] = req.url.split(OWN_QUERY);
      const query = [region, own].filter(Boolean).join("&");
      const url = query ? `${target}?${query}` : target;
      let answer: { status: number; headers: Record<string, string>; body: string };
      if (ctx.http) {
        answer = await ctx.http.request({ ...req, url });
      } else {
        const { method, headers, body } = req;
        const res = await fetch(url, {
          method,
          headers,
          ...(typeof body === "string" ? { body } : {}),
        });
        answer = { status: res.status, headers: {}, body: await res.text() };
      }
      const isJson = req.headers["Accept"] === "application/json";
      return isJson && answer.status >= 200 && answer.status < 300
        ? { ...answer, body: jsonOrText(answer.body) }
        : answer;
    },
  };
}

/** Nomad errors are plain-text bodies. */
export function nomadApi(ctx: NomadContext): NomadApi {
  return createApiClient<paths>({
    vendor: "Nomad",
    baseUrl: `${ctx.address}/v1`,
    headers: {
      Accept: "application/json",
      ...(ctx.token ? { "X-Nomad-Token": ctx.token } : {}),
    },
    http: nomadTransport(ctx),
    caCert: ctx.caCert,
    contentType: "with-body",
    emptyBodyIsUndefined: true,
    serializeQuery: writeQuery,
    httpError: ({ status, method, path, body }) => {
      const hint =
        status === 403 && !ctx.token
          ? " (ACLs are enabled: add a token)"
          : status === 403
            ? " (the token's policies do not allow this)"
            : "";
      return new NomadApiError(
        status,
        `Nomad API error ${status} for ${method} ${path}: ${body.trim().slice(0, 500)}${hint}`,
      );
    },
  });
}

export function joinId(...parts: string[]): string {
  return parts.map((p) => encodeURIComponent(p)).join("/");
}

export function splitId(id: string, count: number): string[] {
  const parts = id.split("/").map((p) => decodeURIComponent(p));
  if (parts.length < count) throw new NomadApiError(400, `Nomad plugin: malformed id "${id}"`);
  return parts;
}

/** Nomad timestamps are Unix nanoseconds. */
export function nsToIso(ns: number | undefined): string | undefined {
  return typeof ns === "number" && ns > 0
    ? new Date(Math.floor(ns / 1e6)).toISOString()
    : undefined;
}

/** Path segments encoded, slashes kept (variable paths). */
export function encodePath(path: string): string {
  return path
    .split("/")
    .map((s) => encodeURIComponent(s))
    .join("/");
}
