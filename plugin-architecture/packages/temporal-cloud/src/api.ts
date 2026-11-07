import {
  createApiClient,
  pathEncode,
  withCursorPagination,
  type ApiResponse,
  type HttpHostServices,
  type ParamValue,
} from "@infrawrench/plugin-base";
import type { components, operations, paths } from "./api-types.gen.js";

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
 *
 * Typed from that document through `ctx.api`. It leaves out deprecated
 * operations, so `plugingen.json` adds `GET /cloud/usage` back. OpenMetrics and
 * the billing report CSVs are not part of it and stay on `fetchText`.
 */
export const CLOUD_API_BASE = "https://saas-api.tmprl.cloud";
export const CLOUD_API_VERSION = "v0.22.0";
export const METRICS_API_BASE = "https://metrics.temporal.io";
export const CLOUD_UI_BASE = "https://cloud.temporal.io";

/** The most the document lets a Cloud Ops list ask for ("Cannot exceed 1000"). */
const PAGE_SIZE = 1000;

export interface TemporalContextOptions {
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

export function buildQuery(query: Record<string, ParamValue> | undefined): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === "") continue;
    if (Array.isArray(v)) for (const item of v) params.append(k, String(item));
    else params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/**
 * Everything a request needs. An empty query value is left out rather than sent
 * empty, and an error names the path without its query.
 */
function createTemporalApi({ apiKey, caCert, http }: TemporalContextOptions) {
  return withCursorPagination(
    createApiClient<paths>({
      vendor: "Temporal Cloud",
      baseUrl: CLOUD_API_BASE,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
        "temporal-cloud-api-version": CLOUD_API_VERSION,
      },
      http,
      caCert,
      serializeQuery: (query) => buildQuery(query).slice(1),
      httpError: ({ status, path, body }) =>
        new TemporalApiError(status, `Temporal Cloud API error ${status} for ${path}: ${body}`),
    }),
    {
      cursorParam: "pageToken",
      sizeParam: "pageSize",
      pageSize: PAGE_SIZE,
      next: "nextPageToken",
      // 50,000 rows, the most the host's resource sync can prune.
      maxPages: 50,
      // This is a gRPC gateway (the document's errors are `rpcStatus`). Proto3 JSON
      // leaves an empty repeated field out, so an empty account answers `{}`...
      missingListIsEmpty: true,
      // ...and a token on an empty page still means there is more. Stopping there
      // would read as the rest having gone, which a sync prunes.
      continueOnEmptyPage: true,
    },
  );
}

export type TemporalApi = ReturnType<typeof createTemporalApi>;

export interface TemporalContext extends TemporalContextOptions {
  /** The Cloud Ops API. Requests go through the host whenever there is one. */
  api: TemporalApi;
}

export function createTemporalContext(options: TemporalContextOptions): TemporalContext {
  return { ...options, api: createTemporalApi(options) };
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

export type AsyncOperation = components["schemas"]["v1AsyncOperation"];

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
    const res: ApiResponse<operations["GetAsyncOperation"]> = await ctx.api.get(
      `/cloud/operations/${pathEncode(op?.id ?? "")}`,
    );
    op = res.asyncOperation ?? op;
  }
}
