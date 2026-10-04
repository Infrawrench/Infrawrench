import type { HttpHostServices } from "@infrawrench/plugin-base";
import { jsonRestFetch } from "@infrawrench/plugin-base";

/**
 * The Anyscale control plane. Every organization, whatever cloud its clusters
 * run on, is managed through this one host; the CLI and Python SDK call the
 * same `/api/v2` routes this plugin does (spec published at
 * https://console.anyscale.com/api/v2/openapi.json, verified 2026-10).
 */
export const ANYSCALE_HOST = "https://console.anyscale.com";

/** Everything a request needs; split out so collectors can be tested alone. */
export interface AnyscaleContext {
  apiKey: string;
  http?: HttpHostServices;
}

/** Thrown for any non-2xx answer, carrying the status callers branch on. */
export class AnyscaleApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "AnyscaleApiError";
    this.status = status;
  }
}

const STATUS_IN_MESSAGE = /Anyscale API error (\d{3})/;

export type Query = Record<string, string | number | boolean | string[] | undefined>;

/**
 * JSON request against the control plane. Anyscale authenticates API keys
 * (user keys and service account keys alike) as the `cli_token` cookie, which
 * is exactly what the official CLI and SDK send. Routed through the host HTTP
 * service whenever there is one: that path honours bastion egress, and it is
 * the only path on which a `Cookie` header survives (browsers forbid setting
 * it from script).
 */
export async function anyscaleFetch<T>(
  ctx: AnyscaleContext,
  path: string,
  init?: RequestInit & { query?: Query },
): Promise<T> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(init?.query ?? {})) {
    if (v === undefined || v === "") continue;
    if (Array.isArray(v)) for (const item of v) params.append(k, item);
    else params.set(k, String(v));
  }
  const qs = params.toString();
  const { query: _query, ...rest } = init ?? {};
  try {
    return await jsonRestFetch<T>({
      vendor: "Anyscale",
      url: `${ANYSCALE_HOST}${path}${qs ? `?${qs}` : ""}`,
      errorPath: path,
      headers: {
        Accept: "application/json",
        Cookie: `cli_token=${ctx.apiKey}`,
      },
      ...(Object.keys(rest).length > 0 ? { init: rest } : {}),
      ...(ctx.http ? { http: ctx.http } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = Number(STATUS_IN_MESSAGE.exec(message)?.[1] ?? 0);
    if (status) throw new AnyscaleApiError(status, message);
    throw err;
  }
}

/** HTTP status of a failed call, or 0 for a transport error. */
export function statusOf(err: unknown): number {
  return err instanceof AnyscaleApiError ? err.status : 0;
}

/** True for the answers that mean "this key may not do that". */
export function isPermissionError(err: unknown): boolean {
  const status = statusOf(err);
  return status === 401 || status === 403;
}

export interface ListResponse<T> {
  results?: T[];
  metadata?: { total?: number; next_paging_token?: string | null };
}

/**
 * Walk a `paging_token` list to the end, or to `maxPages`. Every Anyscale list
 * route shares the `{ results, metadata.next_paging_token }` envelope; GET
 * routes take the token as a query parameter and POST search routes as well.
 */
export async function anyscalePaged<T>(
  ctx: AnyscaleContext,
  path: string,
  opts: { query?: Query; body?: unknown; count: number; maxPages: number },
): Promise<T[]> {
  const out: T[] = [];
  let token: string | undefined;
  for (let page = 0; page < opts.maxPages; page++) {
    const query: Query = { ...opts.query, count: opts.count, paging_token: token };
    const res = await anyscaleFetch<ListResponse<T>>(
      ctx,
      path,
      opts.body !== undefined
        ? { method: "POST", body: JSON.stringify(opts.body), query }
        : { query },
    );
    out.push(...(res.results ?? []));
    token = res.metadata?.next_paging_token ?? undefined;
    if (!token) break;
  }
  return out;
}
