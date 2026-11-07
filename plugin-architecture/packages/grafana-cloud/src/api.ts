import {
  createApiClient,
  requireListPage,
  restRequest,
  withPagination,
  type ApiClient,
  type ApiClientOptions,
  type HttpHostServices,
  type PaginatedApiClient,
  type ParamValue,
} from "@infrawrench/plugin-base";
import type { paths as CloudPaths } from "./api-types.cloud.gen.js";
import type { paths as SmPaths } from "./api-types.sm.gen.js";
import type { paths as StackPaths } from "./api-types.stack.gen.js";

/** The Grafana Cloud API. Every account-level call goes here. */
export const CLOUD_API_URL = "https://grafana.com/api";

/** Grafana's search reference: "max is 5000", and `limit` acts as the page size. */
const SEARCH_PAGE_SIZE = 5000;
/** 50,000 rows. */
const SEARCH_MAX_PAGES = 10;

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

/** The error every Grafana API answers a non-2xx with, naming the path but never its query. */
export function grafanaError(
  vendor: string,
  status: number,
  path: string,
  body: string,
): GrafanaApiError {
  return new GrafanaApiError(status, `${vendor} API error ${status} for ${path}: ${body}`);
}

/** An empty query value is left out, as with a region missing from a resource id. */
function serializeQuery(query: Record<string, ParamValue>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== "") params.set(k, String(v));
  }
  return params.toString();
}

/**
 * Routed through the host HTTP service whenever there is one: that is the only
 * path that honours bastion egress and a custom CA. `errorPrefix` is the part
 * of a path the base URL holds, which error text still names.
 */
function clientOptions(
  ctx: GrafanaContext,
  vendor: string,
  baseUrl: string,
  token: string,
  errorPrefix = "",
): ApiClientOptions {
  return {
    vendor,
    baseUrl,
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    serializeQuery,
    httpError: ({ status, path, body }) =>
      grafanaError(vendor, status, `${errorPrefix}${path}`, body),
    ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
    ...(ctx.http ? { http: ctx.http } : {}),
  };
}

/** The Grafana Cloud API (`https://grafana.com/api/...`). */
export function cloudApi(ctx: GrafanaContext): ApiClient<CloudPaths> {
  return createApiClient<CloudPaths>(clientOptions(ctx, "Grafana Cloud", CLOUD_API_URL, ctx.token));
}

/** A Cloud API list's `items`, or a `ListPageError` rather than read a bad page as nothing. */
export function cloudItems<T>(page: { items?: T[] } | undefined, path: string): T[] {
  return requireListPage(page?.items, { vendor: "Grafana Cloud", path, key: "items", page });
}

/**
 * A stack's own Grafana HTTP API with a stack service account token
 * (`glsa_…`). `baseUrl` is the stack's `url`, which may be a custom domain
 * rather than `<slug>.grafana.net`.
 */
export function stackApi(
  ctx: GrafanaContext,
  baseUrl: string,
  saToken: string,
): PaginatedApiClient<StackPaths, "page" | "limit"> {
  return withPagination(
    createApiClient<StackPaths>(
      clientOptions(ctx, "Grafana stack", `${baseUrl.replace(/\/+$/, "")}/api`, saToken, "/api"),
    ),
    {
      pageParam: "page",
      sizeParam: "limit",
      pageSize: SEARCH_PAGE_SIZE,
      maxPages: SEARCH_MAX_PAGES,
    },
  );
}

/**
 * The Synthetic Monitoring API of the stack's region, with a Synthetic
 * Monitoring access token (a tenant token, not an access policy token).
 */
export function smApi(ctx: GrafanaContext, apiUrl: string, smToken: string): ApiClient<SmPaths> {
  return createApiClient<SmPaths>(
    clientOptions(ctx, "Grafana Synthetic Monitoring", apiUrl.replace(/\/+$/, ""), smToken),
  );
}

/**
 * A Prometheus range query, which no Grafana document describes: the stack's
 * data source proxy takes any route, and the billing endpoint is undocumented.
 */
export async function promGet<T>(
  ctx: GrafanaContext,
  options: { vendor: string; url: string; errorPath: string; authorization: string },
): Promise<T> {
  const { vendor, url, errorPath, authorization } = options;
  const { body } = await restRequest<T>({
    vendor,
    url,
    errorPath,
    headers: { Accept: "application/json", Authorization: authorization },
    httpError: (failure) => grafanaError(vendor, failure.status, errorPath, failure.body),
    ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
    ...(ctx.http ? { http: ctx.http } : {}),
  });
  return body;
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
