import {
  createApiClient,
  type ApiClient,
  type ApiClientOptions,
  type ApiFailure,
  type HttpHostServices,
  type ParamValue,
} from "@infrawrench/plugin-base";
import type { paths as EdgePaths } from "./api-types.edge.gen.js";
import type { paths as V1Paths } from "./api-types.v1.gen.js";
import type { paths as V2Paths } from "./api-types.v2.gen.js";

/**
 * Everything an Axiom request needs. Management calls go to
 * `https://api.axiom.co` (`/v1` and `/v2`); queries go to the edge
 * deployment the dataset lives in (`https://<edge>/v1/query/_apl`), which
 * only accepts API tokens, so a personal access token queries through the
 * older `api.axiom.co/v1/datasets/_apl` route instead.
 *
 * Auth is `Authorization: Bearer <token>`. A personal access token (`xapt-`)
 * also needs `x-axiom-org-id`; an API token (`xaat-`) is already org-scoped.
 * Axiom answers a bad token with 403, not 401.
 */
export interface AxiomContext {
  token: string;
  orgId?: string;
  caCert?: string;
  http?: HttpHostServices;
}

export const API_URL = "https://api.axiom.co";

/** Known edge deployments (base domains for ingest and query). */
export const EDGE_DEPLOYMENTS: Record<string, { label: string; host: string }> = {
  "cloud.us-east-1.aws": { label: "US East 1 (AWS)", host: "us-east-1.aws.edge.axiom.co" },
  "cloud.eu-central-1.aws": { label: "EU Central 1 (AWS)", host: "eu-central-1.aws.edge.axiom.co" },
};

/** Thrown for any non-2xx answer, carrying the status the callers branch on. */
export class AxiomApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "AxiomApiError";
    this.status = status;
  }
}

const STATUS_IN_MESSAGE = /Axiom API error (\d{3})/;

export function isPersonalToken(token: string): boolean {
  return token.startsWith("xapt-");
}

function axiomMessage(body: string): string {
  try {
    const parsed: { message?: string; error?: string } | null = JSON.parse(body);
    return parsed?.message ?? parsed?.error ?? body;
  } catch {
    return body;
  }
}

/** An empty or missing value is left out rather than sent as `key=`. */
function serializeQuery(query: Record<string, ParamValue>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== "") params.set(k, String(v));
  }
  return params.toString();
}

/** Whether an error names the path alone, or the path with the call's own query. */
type ErrorPath = "path" | "target";

/** What every client shares: `version` is in the client's base URL and in error text. */
function clientOptions(
  ctx: AxiomContext,
  baseUrl: string,
  version: string,
  errorPath: ErrorPath = "path",
): ApiClientOptions {
  return {
    vendor: "Axiom",
    baseUrl: `${baseUrl}${version}`,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${ctx.token}`,
      ...(ctx.orgId ? { "x-axiom-org-id": ctx.orgId } : {}),
    },
    caCert: ctx.caCert,
    http: ctx.http,
    serializeQuery,
    httpError: (failure: ApiFailure) => {
      const path = `${version}${failure[errorPath]}`;
      const message = `Axiom API error ${failure.status} for ${path}: ${failure.body}`;
      // Read back out of the text, so a status that is not three digits stays a plain Error.
      const status = Number(STATUS_IN_MESSAGE.exec(message)?.[1] ?? 0);
      if (!status) return new Error(message);
      return new AxiomApiError(
        status,
        `Axiom API error ${status} for ${path}: ${axiomMessage(failure.body)}`,
      );
    },
  };
}

export type AxiomApi = ApiClient<V2Paths>;

/** The management API, `api.axiom.co/v2`. */
export function managementApi(ctx: AxiomContext, errorPath?: ErrorPath): AxiomApi {
  return createApiClient<V2Paths>(clientOptions(ctx, API_URL, "/v2", errorPath));
}

/** The older query route, `api.axiom.co/v1`, which personal access tokens can use. */
export function legacyQueryApi(ctx: AxiomContext): ApiClient<V1Paths> {
  return createApiClient<V1Paths>(clientOptions(ctx, API_URL, "/v1"));
}

/** The query API of one edge deployment, `https://<edge>/v1`. */
export function edgeQueryApi(ctx: AxiomContext, edgeBase: string): ApiClient<EdgePaths> {
  return createApiClient<EdgePaths>(clientOptions(ctx, edgeBase, "/v1"));
}

/** HTTP status of a failed call, or 0 for a transport error. */
export function statusOf(err: unknown): number {
  return err instanceof AxiomApiError ? err.status : 0;
}

/** Run `fn` over `items` with at most `limit` in flight, keeping order. */
export async function mapPooled<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}
