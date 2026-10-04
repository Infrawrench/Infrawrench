import type { HttpHostServices } from "@infrawrench/plugin-base";
import { jsonRestFetch } from "@infrawrench/plugin-base";

/**
 * Everything a CoreWeave request needs. One API access token reaches every
 * surface this plugin uses, which is CoreWeave's own design: the same secret
 * is the Bearer token for the Cloud API (`api.coreweave.com`), for the
 * observability query API (`observe.coreweave.com`), and, embedded in a
 * kubeconfig as `users[].user.token`, for each CKS cluster's Kubernetes API
 * server ("Query logs and metrics" and "Manage API access tokens and
 * kubeconfig files", docs.coreweave.com, 2026-10).
 */
export interface CoreWeaveContext {
  token: string;
  caCert?: string;
  http?: HttpHostServices;
}

export const API_BASE = "https://api.coreweave.com";
export const OBSERVE_BASE = "https://observe.coreweave.com";

/** Thrown for any non-2xx answer, carrying the status callers branch on. */
export class CoreWeaveApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "CoreWeaveApiError";
    this.status = status;
  }
}

const STATUS_IN_MESSAGE = /API error (\d{3})/;

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
 * JSON request with the account's token. Routed through the host HTTP
 * service whenever there is one: that is the only path that honours bastion
 * egress and a custom CA.
 */
export async function bearerFetch<T>(
  ctx: CoreWeaveContext,
  url: string,
  init?: RequestInit & { query?: Query; errorPath?: string; contentType?: string },
): Promise<T> {
  const { query, errorPath, contentType, ...rest } = init ?? {};
  try {
    return await jsonRestFetch<T>({
      vendor: "CoreWeave",
      url: withQuery(url, query),
      errorPath: errorPath ?? new URL(url).pathname,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${ctx.token}`,
        ...(contentType ? { "Content-Type": contentType } : {}),
      },
      ...(Object.keys(rest).length > 0 ? { init: rest } : {}),
      ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
      ...(ctx.http ? { http: ctx.http } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = Number(STATUS_IN_MESSAGE.exec(message)?.[1] ?? 0);
    if (status) throw new CoreWeaveApiError(status, message);
    throw err;
  }
}

/** Cloud API call (`https://api.coreweave.com{path}`). */
export function cwFetch<T>(
  ctx: CoreWeaveContext,
  path: string,
  init?: RequestInit & { query?: Query },
): Promise<T> {
  return bearerFetch<T>(ctx, `${API_BASE}${path}`, { ...init, errorPath: path });
}

/**
 * Normalise a cluster's `apiServerEndpoint` to an origin. The API documents
 * it as "the endpoint for the cluster's api-server" without saying whether a
 * scheme is included, so both spellings are accepted.
 */
export function apiServerOrigin(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/** Kubernetes API call against one CKS cluster, authenticated with the same token. */
export function kubeFetch<T>(
  ctx: CoreWeaveContext,
  endpoint: string,
  path: string,
  init?: RequestInit & { query?: Query; contentType?: string },
): Promise<T> {
  const origin = apiServerOrigin(endpoint);
  if (!origin) {
    return Promise.reject(
      new Error("CoreWeave plugin: this cluster has no API server endpoint yet"),
    );
  }
  return bearerFetch<T>(ctx, `${origin}${path}`, { ...init, errorPath: path });
}

/** HTTP status of a failed call, or 0 for a transport error. */
export function statusOf(err: unknown): number {
  return err instanceof CoreWeaveApiError ? err.status : 0;
}

/** Escape a value for a PromQL double-quoted label matcher. */
export function promLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Escape a literal for use inside a PromQL `=~` regex matcher. */
export function promRegexLiteral(value: string): string {
  return promLabel(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}
