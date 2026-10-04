import type { HttpHostServices } from "@infrawrench/plugin-base";
import { jsonRestFetch } from "@infrawrench/plugin-base";
import type { DatadogSite } from "./sites.js";

/**
 * Everything a Datadog request needs. Split out of the client so the cost
 * collector and the preflight probe can be exercised without one.
 */
export interface DatadogContext {
  apiKey: string;
  appKey: string;
  site: DatadogSite;
  caCert?: string;
  http?: HttpHostServices;
}

/** Thrown for any non-2xx answer, carrying the status the callers branch on. */
export class DatadogApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "DatadogApiError";
    this.status = status;
  }
}

const STATUS_IN_MESSAGE = /Datadog API error (\d{3})/;

/**
 * JSON request against the account's site. Datadog authenticates every
 * management call with two headers: `DD-API-KEY` identifies the organization
 * and `DD-APPLICATION-KEY` identifies the user (or service account) and
 * carries their permissions, or the key's narrower scopes when it has any.
 *
 * Routed through the host HTTP service whenever there is one: that is the only
 * path that honours bastion egress and a custom CA.
 */
export async function ddFetch<T>(
  ctx: DatadogContext,
  path: string,
  init?: RequestInit & { query?: Record<string, string | number | boolean | undefined> },
): Promise<T> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(init?.query ?? {})) {
    if (v !== undefined && v !== "") params.set(k, String(v));
  }
  const qs = params.toString();
  const { query: _query, ...rest } = init ?? {};
  try {
    return await jsonRestFetch<T>({
      vendor: "Datadog",
      url: `${ctx.site.apiUrl}${path}${qs ? `?${qs}` : ""}`,
      errorPath: path,
      headers: {
        Accept: "application/json",
        "DD-API-KEY": ctx.apiKey,
        "DD-APPLICATION-KEY": ctx.appKey,
      },
      ...(Object.keys(rest).length > 0 ? { init: rest } : {}),
      ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
      ...(ctx.http ? { http: ctx.http } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = Number(STATUS_IN_MESSAGE.exec(message)?.[1] ?? 0);
    if (status) throw new DatadogApiError(status, message);
    throw err;
  }
}

/** HTTP status of a failed call, or 0 for a transport error. */
export function statusOf(err: unknown): number {
  return err instanceof DatadogApiError ? err.status : 0;
}

/** True for the answers that mean "this key may not do that". */
export function isPermissionError(err: unknown): boolean {
  const status = statusOf(err);
  return status === 401 || status === 403;
}

/**
 * Page through a JSON:API style list (`page[size]` / `page[number]`), the
 * shape the v2 users, API key and application key endpoints share. Stops on a
 * short page, and hard-stops at `maxPages` so a misbehaving cursor cannot
 * spin forever.
 */
export async function ddPaged<T>(
  ctx: DatadogContext,
  path: string,
  query: Record<string, string | number | boolean | undefined> = {},
  pageSize = 100,
  maxPages = 50,
): Promise<{ data: T[]; included: unknown[] }> {
  const data: T[] = [];
  const included: unknown[] = [];
  for (let page = 0; page < maxPages; page++) {
    const res = await ddFetch<{ data?: T[]; included?: unknown[] }>(ctx, path, {
      query: { ...query, "page[size]": pageSize, "page[number]": page },
    });
    const batch = res.data ?? [];
    data.push(...batch);
    included.push(...(res.included ?? []));
    if (batch.length < pageSize) break;
  }
  return { data, included };
}
