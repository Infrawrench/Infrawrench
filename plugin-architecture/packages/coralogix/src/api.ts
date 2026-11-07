import type { ApiClientOptions, HttpHostServices, ParamValue } from "@infrawrench/plugin-base";
import { createApiClient } from "@infrawrench/plugin-base";
import type { paths as V4Paths } from "./api-types.v4.gen.js";
import type { paths as V5Paths } from "./api-types.v5.gen.js";
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

/**
 * Build a grpc-gateway query string: nested message fields are dotted
 * (`pagination.pageSize`) and repeated fields repeat the key
 * (`alert_ids=a&alert_ids=b`).
 */
export function queryString(query: Record<string, ParamValue> = {}): string {
  const params = new URLSearchParams();
  const add = (name: string, value: ParamValue) => {
    if (value === undefined || value === null || value === "") return;
    if (Array.isArray(value)) {
      for (const item of value) params.append(name, String(item));
    } else {
      params.set(name, String(value));
    }
  };
  for (const [name, value] of Object.entries(query)) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const [field, inner] of Object.entries(value)) add(`${name}.${field}`, inner);
    } else {
      add(name, value);
    }
  }
  return params.toString();
}

/**
 * The management REST API is the grpc-gateway face of Coralogix's gRPC
 * services, published as an OpenAPI document under `/mgmt/openapi/<version>`.
 * Every management call takes the API key as a bearer token, a personal or team
 * key whose permissions (usually attached as presets) decide what it may read
 * and change.
 *
 * Routed through the host HTTP service whenever there is one: that is the only
 * path that honours bastion egress and a custom CA.
 */
function clientOptions(ctx: CoralogixContext, version: 4 | 5): ApiClientOptions {
  return {
    vendor: "Coralogix",
    baseUrl: `${ctx.region.apiUrl}/mgmt/openapi/${version}`,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${ctx.apiKey}`,
    },
    caCert: ctx.caCert,
    http: ctx.http,
    serializeQuery: queryString,
    httpError: ({ status, path, body }) =>
      new CoralogixApiError(status, `Coralogix API error ${status} for ${path}: ${body}`),
  };
}

/** Version 5 is current, and what everything uses unless it has to be otherwise. */
export const apiV5 = (ctx: CoralogixContext) => createApiClient<V5Paths>(clientOptions(ctx, 5));

/**
 * A few services (the per-day data-usage breakdown and the usage-metrics export
 * toggle) are only documented up to version 4, which the gateway keeps serving.
 */
export const apiV4 = (ctx: CoralogixContext) => createApiClient<V4Paths>(clientOptions(ctx, 4));

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
