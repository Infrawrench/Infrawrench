import type { HttpHostServices } from "@infrawrench/plugin-base";
import { jsonRestFetch } from "@infrawrench/plugin-base";
import type { CoralogixRegion } from "./regions.js";

/**
 * Everything a Coralogix request needs. Split out of the client so the cost
 * collector, the quota reader and the preflight probe can be exercised
 * without one.
 */
export interface CoralogixContext {
  apiKey: string;
  region: CoralogixRegion;
  caCert?: string;
  http?: HttpHostServices;
}

/** Thrown for any non-2xx answer, carrying the status the callers branch on. */
export class CoralogixApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "CoralogixApiError";
    this.status = status;
  }
}

const STATUS_IN_MESSAGE = /Coralogix API error (\d{3})/;

/**
 * The management REST API is the grpc-gateway face of Coralogix's gRPC
 * services, published as an OpenAPI document under `/mgmt/openapi/<version>`.
 * Version 5 is current. A few services (the per-day data-usage breakdown and
 * the usage-metrics export toggle) are only documented up to version 4, which
 * the gateway keeps serving, so callers name the version.
 */
export type ApiVersion = 4 | 5;

export type QueryValue = string | number | boolean | undefined | Array<string | number>;

/**
 * Build a grpc-gateway query string: nested message fields are dotted
 * (`pagination.pageSize`) and repeated fields repeat the key
 * (`alert_ids=a&alert_ids=b`).
 */
export function queryString(query: Record<string, QueryValue> = {}): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === "") continue;
    if (Array.isArray(v)) {
      for (const item of v) params.append(k, String(item));
    } else {
      params.set(k, String(v));
    }
  }
  return params.toString();
}

/**
 * JSON request against the account's region. Every management call takes
 * the API key as a bearer token, a personal or team key whose permissions
 * (usually attached as presets) decide what it may read and change.
 *
 * Routed through the host HTTP service whenever there is one: that is the only
 * path that honours bastion egress and a custom CA.
 */
export async function cxFetch<T>(
  ctx: CoralogixContext,
  path: string,
  init?: Omit<RequestInit, "body"> & {
    body?: unknown;
    query?: Record<string, QueryValue>;
    version?: ApiVersion;
  },
): Promise<T> {
  const { query, version = 5, body, ...rest } = init ?? {};
  const qs = queryString(query);
  const requestInit: RequestInit = {
    ...rest,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
  try {
    return await jsonRestFetch<T>({
      vendor: "Coralogix",
      url: `${ctx.region.apiUrl}/mgmt/openapi/${version}${path}${qs ? `?${qs}` : ""}`,
      errorPath: path,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${ctx.apiKey}`,
      },
      ...(Object.keys(requestInit).length > 0 ? { init: requestInit } : {}),
      ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
      ...(ctx.http ? { http: ctx.http } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = Number(STATUS_IN_MESSAGE.exec(message)?.[1] ?? 0);
    if (status) throw new CoralogixApiError(status, message);
    throw err;
  }
}

/** HTTP status of a failed call, or 0 for a transport error. */
export function statusOf(err: unknown): number {
  return err instanceof CoralogixApiError ? err.status : 0;
}

/** True for the answers that mean "this key may not do that". */
export function isPermissionError(err: unknown): boolean {
  const status = statusOf(err);
  return status === 401 || status === 403;
}

/** True for the answers that mean "this route is not served here". */
export function isMissingRoute(err: unknown): boolean {
  const status = statusOf(err);
  return status === 404 || status === 405 || status === 501;
}

/**
 * Page through a list that uses Coralogix's token pagination
 * (`pagination.pageSize` / `pagination.pageToken` in, `pagination.nextPageToken`
 * out). Hard-stops at `maxPages` so a misbehaving token cannot spin forever.
 */
export async function cxPaged<T, R extends { pagination?: { nextPageToken?: string } }>(
  ctx: CoralogixContext,
  path: string,
  pick: (res: R) => T[] | undefined,
  query: Record<string, QueryValue> = {},
  pageSize = 100,
  maxPages = 50,
): Promise<T[]> {
  const out: T[] = [];
  let token: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const res = await cxFetch<R>(ctx, path, {
      query: {
        ...query,
        "pagination.pageSize": pageSize,
        ...(token ? { "pagination.pageToken": token } : {}),
      },
    });
    out.push(...(pick(res) ?? []));
    token = res?.pagination?.nextPageToken || undefined;
    if (!token) break;
  }
  return out;
}
