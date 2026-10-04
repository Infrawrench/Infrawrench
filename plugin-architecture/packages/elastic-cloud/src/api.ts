import type { HttpHostServices } from "@infrawrench/plugin-base";
import { jsonRestFetch } from "@infrawrench/plugin-base";

/**
 * The two hosts the Elastic Cloud API is served from, both authenticated with
 * the same `Authorization: ApiKey <key>` header:
 *
 * - `api.elastic-cloud.com` serves the Cloud API (`/api/v1/deployments`,
 *   `/api/v1/organizations`, the legacy `/api/v1/billing/costs/...` overview)
 *   and the Serverless API (`/api/v1/serverless/...`).
 * - `billing.elastic-cloud.com` serves the Billing API: the v2 cost endpoints
 *   that cover hosted deployments and serverless projects alike
 *   (`/api/v2/billing/organizations/{id}/costs/instances`, charts) and the
 *   budgets. It is the default host of Elastic's own billing integration.
 */
export const CLOUD_API = "https://api.elastic-cloud.com";
export const BILLING_API = "https://billing.elastic-cloud.com";

/** Everything a request needs; split out so collectors can run without a client. */
export interface EcContext {
  apiKey: string;
  caCert?: string;
  http?: HttpHostServices;
}

/** Thrown for any non-2xx answer, carrying the status callers branch on. */
export class EcApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "EcApiError";
    this.status = status;
  }
}

const STATUS_IN_MESSAGE = /Elastic Cloud API error (\d{3})/;

export type Query = Record<string, string | number | boolean | undefined>;

/**
 * JSON request against one of the two hosts. Routed through the host HTTP
 * service whenever there is one: that is the only path that honours bastion
 * egress and a custom CA.
 */
export async function ecFetch<T>(
  ctx: EcContext,
  base: string,
  path: string,
  init?: RequestInit & { query?: Query },
): Promise<T> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(init?.query ?? {})) {
    if (v !== undefined && v !== "") params.set(k, String(v));
  }
  const qs = params.toString();
  const { query: _query, ...rest } = init ?? {};
  try {
    return await jsonRestFetch<T>({
      vendor: "Elastic Cloud",
      url: `${base}${path}${qs ? `?${qs}` : ""}`,
      errorPath: path,
      headers: { Accept: "application/json", Authorization: `ApiKey ${ctx.apiKey}` },
      ...(Object.keys(rest).length > 0 ? { init: rest } : {}),
      ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
      ...(ctx.http ? { http: ctx.http } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = Number(STATUS_IN_MESSAGE.exec(message)?.[1] ?? 0);
    if (status) throw new EcApiError(status, message);
    throw err;
  }
}

export const cloudApi = <T>(ctx: EcContext, path: string, init?: RequestInit & { query?: Query }) =>
  ecFetch<T>(ctx, CLOUD_API, path, init);

export const billingApi = <T>(
  ctx: EcContext,
  path: string,
  init?: RequestInit & { query?: Query },
) => ecFetch<T>(ctx, BILLING_API, path, init);

/** HTTP status of a failed call, or 0 for a transport error. */
export function statusOf(err: unknown): number {
  return err instanceof EcApiError ? err.status : 0;
}

/** True for the answers that mean "this key may not do that". */
export function isPermissionError(err: unknown): boolean {
  const s = statusOf(err);
  return s === 401 || s === 403;
}
