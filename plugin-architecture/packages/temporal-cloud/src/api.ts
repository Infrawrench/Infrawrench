import type { HttpHostServices } from "@infrawrench/plugin-base";
import { jsonRestFetch } from "@infrawrench/plugin-base";

/**
 * Temporal Cloud Ops API, HTTP/JSON gateway.
 *
 * The Cloud Ops API is gRPC with a grpc-gateway HTTP/JSON surface on the same
 * host (`https://saas-api.tmprl.cloud`, published OpenAPI document at
 * `https://saas-api.tmprl.cloud/spec.json`). The HTTP route supports every
 * operation the gRPC one does, so this plugin takes no gRPC dependency: JSON
 * field names are the protobuf camelCase names, enums travel as their string
 * names (`RESOURCE_STATE_ACTIVE`), int64 values as decimal strings and
 * timestamps as RFC 3339.
 *
 * Authentication is `Authorization: Bearer <API key>` for a user or service
 * account key. `temporal-cloud-api-version` is optional over HTTP (it defaults
 * to the latest); it is pinned here so a server-side default bump cannot
 * change a response shape under the mappers.
 */
export const CLOUD_API_BASE = "https://saas-api.tmprl.cloud";
export const CLOUD_API_VERSION = "v0.22.0";
export const METRICS_API_BASE = "https://metrics.temporal.io";
export const CLOUD_UI_BASE = "https://cloud.temporal.io";

export interface TemporalContext {
  apiKey: string;
  /** OpenMetrics key; falls back to `apiKey` when the account has none. */
  metricsApiKey: string;
  caCert?: string;
  http?: HttpHostServices;
}

/** Thrown for any non-2xx answer, carrying the status the callers branch on. */
export class TemporalApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "TemporalApiError";
    this.status = status;
  }
}

const STATUS_IN_MESSAGE = /Temporal Cloud API error (\d{3})/;

export type Query = Record<string, string | number | boolean | string[] | undefined>;

export function buildQuery(query: Query | undefined): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === "") continue;
    if (Array.isArray(v)) for (const item of v) params.append(k, item);
    else params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/**
 * JSON request against the Cloud Ops API. Routed through the host HTTP
 * service whenever there is one: that is the only path that honours bastion
 * egress and a custom CA.
 */
export async function tcFetch<T>(
  ctx: TemporalContext,
  path: string,
  init?: { method?: string; body?: unknown; query?: Query },
): Promise<T> {
  const method = init?.method ?? "GET";
  try {
    return await jsonRestFetch<T>({
      vendor: "Temporal Cloud",
      url: `${CLOUD_API_BASE}${path}${buildQuery(init?.query)}`,
      errorPath: path,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${ctx.apiKey}`,
        "temporal-cloud-api-version": CLOUD_API_VERSION,
      },
      init: {
        method,
        ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      },
      ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
      ...(ctx.http ? { http: ctx.http } : {}),
    });
  } catch (err) {
    throw asTemporalError(err);
  }
}

function asTemporalError(err: unknown): unknown {
  const message = err instanceof Error ? err.message : String(err);
  const status = Number(STATUS_IN_MESSAGE.exec(message)?.[1] ?? 0);
  return status ? new TemporalApiError(status, message) : err;
}

/** HTTP status of a failed call, or 0 for a transport error. */
export function statusOf(err: unknown): number {
  return err instanceof TemporalApiError ? err.status : 0;
}

/** True for the answers that mean "this key may not do that". */
export function isPermissionError(err: unknown): boolean {
  const status = statusOf(err);
  return status === 401 || status === 403;
}

/**
 * Page through a Cloud Ops list (`pageSize` / `pageToken`, answered with a
 * `nextPageToken`). Hard-stops at `maxPages` so a misbehaving cursor cannot
 * spin forever.
 */
export async function tcPaged<T>(
  ctx: TemporalContext,
  path: string,
  key: string,
  query: Query = {},
  maxPages = 50,
): Promise<T[]> {
  const out: T[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const res = await tcFetch<Record<string, unknown>>(ctx, path, {
      query: { ...query, pageSize: 100, ...(pageToken ? { pageToken } : {}) },
    });
    const batch = (res?.[key] as T[] | undefined) ?? [];
    out.push(...batch);
    const next = res?.["nextPageToken"];
    if (typeof next !== "string" || next === "") break;
    pageToken = next;
  }
  return out;
}

/** Plain-text GET (OpenMetrics, CSV downloads), through the host when present. */
export async function fetchText(
  ctx: TemporalContext,
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  if (ctx.http) {
    const res = await ctx.http.request({
      url,
      method: "GET",
      headers,
      ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
    });
    return { status: res.status, body: res.body, headers: res.headers };
  }
  const res = await fetch(url, { headers });
  const out: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return { status: res.status, body: await res.text(), headers: out };
}

export interface AsyncOperation {
  id?: string;
  state?: string;
  checkDuration?: string;
  operationType?: string;
  failureReason?: string;
  startedTime?: string;
  finishedTime?: string;
}

const OPERATION_DONE = new Set(["STATE_FULFILLED"]);
const OPERATION_FAILED = new Set(["STATE_FAILED", "STATE_CANCELLED", "STATE_REJECTED"]);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Wait for an async operation to settle, up to `timeoutMs`. Every Cloud Ops
 * mutation is asynchronous; a rejected or failed operation throws with the
 * provider's reason, while one that is merely slow returns its last state so
 * the caller can report "still in progress" instead of a false failure.
 */
export async function waitForOperation(
  ctx: TemporalContext,
  operation: AsyncOperation | undefined,
  timeoutMs = 20_000,
  pollMs = 2_000,
): Promise<AsyncOperation | undefined> {
  let op = operation;
  if (!op?.id) return op;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = op?.state ?? "";
    if (OPERATION_DONE.has(state)) return op;
    if (OPERATION_FAILED.has(state)) {
      throw new Error(
        `Temporal Cloud rejected the change${op?.failureReason ? `: ${op.failureReason}` : ` (${state})`}`,
      );
    }
    if (Date.now() >= deadline) return op;
    await sleep(pollMs);
    const res: { asyncOperation?: AsyncOperation } = await tcFetch<{
      asyncOperation?: AsyncOperation;
    }>(ctx, `/cloud/operations/${encodeURIComponent(op?.id ?? "")}`);
    op = res.asyncOperation ?? op;
  }
}
