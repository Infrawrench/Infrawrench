import type { HttpHostServices } from "@infrawrench/plugin-base";
import { jsonRestFetch } from "@infrawrench/plugin-base";

/**
 * Astra DevOps API (`https://api.astra.datastax.com`), verified 2026-10
 * against the OpenAPI documents DataStax publishes with its Go client
 * (github.com/datastax/astra-client-go `openapi/astra-devops-api.yaml` v2.3.0
 * and `openapi/streaming-devops-api.yaml`) and the Astra docs.
 *
 * One application token (`AstraCS:…`) authenticates every host: `Bearer` on
 * the DevOps and streaming APIs, a `Token` header on a database's Data API
 * endpoint, and `Astra-Token` on the metrics scrape host. The token belongs
 * to one organization and carries its role's permissions.
 */
export const ASTRA_API = "https://api.astra.datastax.com";
export const METRICS_API = "https://metrics.astra.datastax.com";

export interface AstraContext {
  token: string;
  http?: HttpHostServices;
  /** Overridable for tests. */
  baseUrl?: string;
}

export class AstraApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "AstraApiError";
    this.status = status;
  }
}

const STATUS_IN_MESSAGE = /Astra API error (\d{3})/;

export function statusOf(err: unknown): number {
  return err instanceof AstraApiError ? err.status : 0;
}

/** A 403/404 on one listing means the token's role cannot see it, or the feature is off. */
export function isUnavailable(err: unknown): boolean {
  const s = statusOf(err);
  return s === 403 || s === 404 || s === 501;
}

function friendly(status: number, raw: string): string {
  if (status === 401) {
    return "Astra API error 401: the application token was rejected. Generate a new one under Settings, Tokens in the Astra Portal.";
  }
  const start = raw.search(/[[{]/);
  if (start >= 0) {
    try {
      const parsed = JSON.parse(raw.slice(start)) as {
        errors?: Array<{ message?: string; description?: string }>;
        message?: string;
        description?: string;
      };
      const detail =
        parsed.errors
          ?.map((e) => e.message ?? e.description)
          .filter(Boolean)
          .join("; ") ||
        parsed.message ||
        parsed.description;
      if (detail) return `Astra API error ${status}: ${detail}`;
    } catch {
      /* not JSON */
    }
  }
  return raw;
}

export async function astraRequest<T>(
  ctx: AstraContext,
  method: string,
  url: string,
  opts: {
    body?: unknown;
    headers?: Record<string, string>;
    /** Send the token as `Token` (Data API) instead of `Authorization: Bearer`. */
    dataApi?: boolean;
    query?: Array<[string, string | number | boolean | undefined]>;
  } = {},
): Promise<T> {
  const params = new URLSearchParams();
  for (const [k, v] of opts.query ?? []) {
    if (v !== undefined && v !== "") params.append(k, String(v));
  }
  const qs = params.toString();
  const full = `${url}${qs ? `?${qs}` : ""}`;
  const path = (() => {
    try {
      return new URL(url).pathname;
    } catch {
      return url;
    }
  })();
  try {
    return await jsonRestFetch<T>({
      vendor: "Astra",
      url: full,
      errorPath: path,
      headers: {
        Accept: "application/json",
        ...(opts.dataApi ? { Token: ctx.token } : { Authorization: `Bearer ${ctx.token}` }),
        ...opts.headers,
      },
      init: {
        method,
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      },
      ...(ctx.http ? { http: ctx.http } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = Number(STATUS_IN_MESSAGE.exec(message)?.[1] ?? 0);
    if (status) throw new AstraApiError(status, friendly(status, message));
    throw err;
  }
}

/** DevOps API call, path relative to {@link ASTRA_API}. */
export function devops<T>(
  ctx: AstraContext,
  method: string,
  path: string,
  opts: Parameters<typeof astraRequest>[3] = {},
): Promise<T> {
  return astraRequest<T>(ctx, method, `${ctx.baseUrl ?? ASTRA_API}${path}`, opts);
}

/** Streaming responses are documented both bare and wrapped in `{Body: …}`; accept either. */
export function unwrapBody<T>(value: unknown): T | undefined {
  if (value && typeof value === "object" && !Array.isArray(value) && "Body" in value) {
    return (value as { Body: T }).Body;
  }
  return value as T | undefined;
}

/**
 * GET text through the host (or fetch), for the Prometheus scrape host. Throws
 * an {@link AstraApiError} on a non-2xx answer.
 */
export async function fetchText(
  ctx: AstraContext,
  url: string,
  headers: Record<string, string>,
): Promise<string> {
  if (ctx.http) {
    const res = await ctx.http.request({ url, method: "GET", headers });
    if (res.status < 200 || res.status >= 300) {
      throw new AstraApiError(res.status, `Astra API error ${res.status} for ${url}`);
    }
    return res.body;
  }
  const res = await fetch(url, { headers });
  if (!res.ok) throw new AstraApiError(res.status, `Astra API error ${res.status} for ${url}`);
  return res.text();
}
