import type { HttpHostServices } from "@infrawrench/plugin-base";
import { jsonRestFetch, utf8ToBase64 } from "@infrawrench/plugin-base";

/**
 * Confluent Cloud has two HTTP surfaces this plugin talks to, both of which
 * authenticate with the same organization-level **Cloud API key** sent as
 * HTTP Basic (`key:secret`):
 *
 * - `https://api.confluent.cloud`: every management API (org, IAM, cmk,
 *   connect, fcpm, ksqldbcm, srcm, networking, byok) and the Billing Costs
 *   API. Verified against the published spec at
 *   https://docs.confluent.io/cloud/current/openapi.yaml (2026-10).
 * - `https://api.telemetry.confluent.cloud`: the Metrics API
 *   (`POST /v2/metrics/cloud/query`). A Cloud API key is required there too;
 *   cluster-scoped keys are rejected.
 */
export const MANAGEMENT_API = "https://api.confluent.cloud";
export const TELEMETRY_API = "https://api.telemetry.confluent.cloud";
export const CONSOLE_URL = "https://confluent.cloud";

export interface ConfluentContext {
  apiKey: string;
  apiSecret: string;
  caCert?: string;
  http?: HttpHostServices;
}

/** Thrown for any non-2xx answer, carrying the status the callers branch on. */
export class ConfluentApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ConfluentApiError";
    this.status = status;
  }
}

const STATUS_IN_MESSAGE = /Confluent Cloud API error (\d{3})/;

type Query = Record<string, string | number | boolean | undefined>;

function withQuery(url: string, query?: Query): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== "") params.set(k, String(v));
  }
  const qs = params.toString();
  if (!qs) return url;
  return `${url}${url.includes("?") ? "&" : "?"}${qs}`;
}

/**
 * JSON request with the account's Cloud API key. `pathOrUrl` is either a path
 * on the management API or an absolute URL (the `metadata.next` links the
 * list endpoints return are absolute). Routed through the host HTTP service
 * whenever there is one: that is the only path that honours bastion egress
 * and a custom CA.
 */
export async function ccFetch<T>(
  ctx: ConfluentContext,
  pathOrUrl: string,
  init?: RequestInit & { query?: Query; base?: string },
): Promise<T> {
  const { query, base, ...rest } = init ?? {};
  const absolute = /^https?:\/\//.test(pathOrUrl);
  const url = withQuery(absolute ? pathOrUrl : `${base ?? MANAGEMENT_API}${pathOrUrl}`, query);
  const errorPath = absolute ? new URL(pathOrUrl).pathname : pathOrUrl;
  try {
    return await jsonRestFetch<T>({
      vendor: "Confluent Cloud",
      url,
      errorPath,
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${utf8ToBase64(`${ctx.apiKey}:${ctx.apiSecret}`)}`,
      },
      ...(Object.keys(rest).length > 0 ? { init: rest } : {}),
      ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
      ...(ctx.http ? { http: ctx.http } : {}),
    });
  } catch (err) {
    // Action endpoints (connector pause/resume, 202 Accepted) can answer
    // with an empty body that the direct-fetch path fails to parse.
    if (err instanceof SyntaxError) return undefined as T;
    const message = err instanceof Error ? err.message : String(err);
    const status = Number(STATUS_IN_MESSAGE.exec(message)?.[1] ?? 0);
    if (status) throw new ConfluentApiError(status, message);
    throw err;
  }
}

/** HTTP status of a failed call, or 0 for a transport error. */
export function statusOf(err: unknown): number {
  return err instanceof ConfluentApiError ? err.status : 0;
}

/** True for the answers that mean "this key's owner may not do that". */
export function isPermissionError(err: unknown): boolean {
  const status = statusOf(err);
  return status === 401 || status === 403;
}

interface ListPage<T> {
  data?: T[];
  metadata?: { next?: string | null; total_size?: number };
}

/**
 * Walk a Confluent list endpoint. Every list in the management API shares
 * one shape: `{ data: [...], metadata: { next } }`, where `next` is an
 * absolute URL carrying an opaque `page_token`. Hard-stops at `maxPages` so a
 * misbehaving cursor cannot spin forever.
 */
export async function ccList<T>(
  ctx: ConfluentContext,
  path: string,
  query: Query = {},
  pageSize = 100,
  maxPages = 100,
): Promise<T[]> {
  const out: T[] = [];
  let next: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const res: ListPage<T> = next
      ? await ccFetch<ListPage<T>>(ctx, next)
      : await ccFetch<ListPage<T>>(ctx, path, { query: { ...query, page_size: pageSize } });
    out.push(...(res.data ?? []));
    const link = res.metadata?.next;
    if (!link || (res.data ?? []).length === 0) break;
    next = link;
  }
  return out;
}
