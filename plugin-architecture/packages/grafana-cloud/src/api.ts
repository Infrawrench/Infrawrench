import type { HttpHostServices } from "@infrawrench/plugin-base";
import { jsonRestFetch } from "@infrawrench/plugin-base";

/** The Grafana Cloud API. Every account-level call goes here. */
export const CLOUD_API_URL = "https://grafana.com/api";

/**
 * Everything a Grafana Cloud request needs. Split out of the client so the
 * cost collector and the preflight probe can be exercised without one.
 */
export interface GrafanaContext {
  /** Cloud access policy token (`glc_…`). */
  token: string;
  caCert?: string;
  http?: HttpHostServices;
}

/** Thrown for any non-2xx answer, carrying the status the callers branch on. */
export class GrafanaApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "GrafanaApiError";
    this.status = status;
  }
}

const STATUS_IN_MESSAGE =
  /Grafana (?:Cloud|stack|Synthetic Monitoring|usage metrics) API error (\d{3})/;

type Query = Record<string, string | number | boolean | undefined>;

function withQuery(url: string, query: Query | undefined): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== "") params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${url}${url.includes("?") ? "&" : "?"}${qs}` : url;
}

/**
 * JSON request against an absolute URL with a Bearer token. Routed through
 * the host HTTP service whenever there is one: that is the only path that
 * honours bastion egress and a custom CA.
 */
export async function bearerFetch<T>(
  vendor: string,
  token: string,
  url: string,
  init: (RequestInit & { query?: Query }) | undefined,
  ctx: { caCert?: string; http?: HttpHostServices },
  errorPath: string,
): Promise<T> {
  const { query, ...rest } = init ?? {};
  try {
    return await jsonRestFetch<T>({
      vendor,
      url: withQuery(url, query),
      errorPath,
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      ...(Object.keys(rest).length > 0 ? { init: rest } : {}),
      ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
      ...(ctx.http ? { http: ctx.http } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = Number(STATUS_IN_MESSAGE.exec(message)?.[1] ?? 0);
    if (status) throw new GrafanaApiError(status, message);
    throw err;
  }
}

/** A call against the Grafana Cloud API (`https://grafana.com/api/...`). */
export function cloudFetch<T>(
  ctx: GrafanaContext,
  path: string,
  init?: RequestInit & { query?: Query },
): Promise<T> {
  return bearerFetch<T>("Grafana Cloud", ctx.token, `${CLOUD_API_URL}${path}`, init, ctx, path);
}

/**
 * A call against a stack's own Grafana HTTP API with a stack service account
 * token (`glsa_…`). `baseUrl` is the stack's `url`, which may be a custom
 * domain rather than `<slug>.grafana.net`.
 */
export function stackFetch<T>(
  ctx: GrafanaContext,
  baseUrl: string,
  saToken: string,
  path: string,
  init?: RequestInit & { query?: Query },
): Promise<T> {
  return bearerFetch<T>(
    "Grafana stack",
    saToken,
    `${baseUrl.replace(/\/+$/, "")}${path}`,
    init,
    ctx,
    path,
  );
}

/**
 * A call against the Synthetic Monitoring API of the stack's region, with a
 * Synthetic Monitoring access token (a tenant token, not an access policy
 * token).
 */
export function smFetch<T>(
  ctx: GrafanaContext,
  apiUrl: string,
  smToken: string,
  path: string,
  init?: RequestInit & { query?: Query },
): Promise<T> {
  return bearerFetch<T>(
    "Grafana Synthetic Monitoring",
    smToken,
    `${apiUrl.replace(/\/+$/, "")}${path}`,
    init,
    ctx,
    path,
  );
}

/** Mutating Cloud API routes require an `x-request-id` header. */
export function requestId(): Record<string, string> {
  const id =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
  return { "x-request-id": id };
}

/**
 * What a cloud access policy token says about itself. The part after `glc_`
 * is base64 JSON carrying the org id (`o`) and the region the policy lives in
 * (`m.r`). The format is not documented, so every caller treats an empty
 * result as "ask the API" rather than an error, and the account form keeps an
 * optional org slug as the fallback.
 */
export function decodeCloudToken(token: string): { orgId?: string; region?: string } {
  const body = token.startsWith("glc_") ? token.slice(4) : "";
  if (!body) return {};
  try {
    const json = JSON.parse(base64Decode(body)) as { o?: unknown; m?: { r?: unknown } };
    return {
      ...(json.o !== undefined && json.o !== null && String(json.o)
        ? { orgId: String(json.o) }
        : {}),
      ...(typeof json.m?.r === "string" && json.m.r ? { region: json.m.r } : {}),
    };
  } catch {
    return {};
  }
}

function base64Decode(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  if (typeof atob === "function") {
    const bin = atob(padded);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }
  return Buffer.from(padded, "base64").toString("utf8");
}

/** HTTP status of a failed call, or 0 for a transport error. */
export function statusOf(err: unknown): number {
  return err instanceof GrafanaApiError ? err.status : 0;
}

/** True for the answers that mean "this token may not do that". */
export function isPermissionError(err: unknown): boolean {
  const status = statusOf(err);
  return status === 401 || status === 403;
}
