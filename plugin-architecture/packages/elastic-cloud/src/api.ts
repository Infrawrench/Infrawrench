import {
  createApiClient,
  ListTruncatedError,
  requireListPage,
  type ApiClient,
  type ApiResponse,
  type HttpHostServices,
} from "@infrawrench/plugin-base";
import type {
  operations as BillingOperations,
  paths as BillingPaths,
} from "./api-types.billing.gen.js";
import type { operations as CloudOperations, paths as CloudPaths } from "./api-types.cloud.gen.js";
import type {
  operations as ServerlessOperations,
  paths as ServerlessPaths,
} from "./api-types.serverless.gen.js";

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
export const VENDOR = "Elastic Cloud";

/** Where the Cloud API document's paths start. The other two write it into each path. */
const CLOUD_BASE_PATH = "/api/v1";

/** An operation's response, by its `operationId`, per document. */
export type CloudResponse<Op extends keyof CloudOperations> = ApiResponse<CloudOperations[Op]>;
export type ServerlessResponse<Op extends keyof ServerlessOperations> = ApiResponse<
  ServerlessOperations[Op]
>;
export type BillingResponse<Op extends keyof BillingOperations> = ApiResponse<
  BillingOperations[Op]
>;

/** Serverless project types: one path segment each under `/api/v1/serverless/projects/`. */
export const PROJECT_TYPES = ["elasticsearch", "observability", "security", "vectordb"] as const;
export type ProjectType = (typeof PROJECT_TYPES)[number];

export function isProjectType(value: string): value is ProjectType {
  return PROJECT_TYPES.some((type) => type === value);
}

/** One route of the Serverless document, across the project types it repeats for. */
type ProjectRoute<Suffix extends string> = ServerlessPaths[Extract<
  keyof ServerlessPaths,
  `/api/v1/serverless/projects/${ProjectType}${Suffix}`
>];

/**
 * The document repeats every project route per type. The plugin reads the type out
 * of a resource's external id, so it is a path segment like any other here, and
 * each call is typed as whichever of the four routes that segment names.
 */
interface ProjectPaths {
  "/api/v1/serverless/projects/{type}": CursorListRoute<ProjectRoute<"">>;
  "/api/v1/serverless/projects/{type}/{id}": ProjectRoute<"/{id}">;
  "/api/v1/serverless/projects/{type}/{id}/status": ProjectRoute<"/{id}/status">;
  "/api/v1/serverless/projects/{type}/{id}/_resume": ProjectRoute<"/{id}/_resume">;
  "/api/v1/serverless/projects/{type}/{id}/_reset-credentials": ProjectRoute<"/{id}/_reset-credentials">;
}

/**
 * A list route as `readCursorList` calls it: the same answer, plus the `next_page` query
 * it may try. The document does not name that parameter, hence the type here.
 */
type CursorListRoute<Route> = Route extends { get: { responses: infer Responses } }
  ? Omit<Route, "get"> & {
      get: {
        parameters: {
          query?: { next_page?: string };
          header?: never;
          path?: never;
          cookie?: never;
        };
        requestBody?: never;
        responses: Responses;
      };
    }
  : never;

type EcCloudPaths = Omit<CloudPaths, "/organizations"> & {
  "/organizations": CursorListRoute<CloudPaths["/organizations"]>;
};

/** Everything a request needs; split out so collectors can run without a client. */
export interface EcContext {
  cloud: ApiClient<EcCloudPaths>;
  serverless: ApiClient<ServerlessPaths>;
  projects: ApiClient<ProjectPaths>;
  billing: ApiClient<BillingPaths>;
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

/**
 * Requests go through the host HTTP service whenever there is one: that is the
 * only path that honours bastion egress and a custom CA.
 */
export function createEcContext(options: {
  apiKey: string;
  caCert?: string | undefined;
  http?: HttpHostServices | undefined;
}): EcContext {
  const { apiKey, caCert, http } = options;
  const shared = {
    vendor: VENDOR,
    headers: { Accept: "application/json", Authorization: `ApiKey ${apiKey}` },
    ...(caCert ? { caCert } : {}),
    ...(http ? { http } : {}),
  };
  const httpError =
    (basePath: string) =>
    ({ status, path, body }: { status: number; path: string; body: string }) =>
      new EcApiError(status, `Elastic Cloud API error ${status} for ${basePath}${path}: ${body}`);
  return {
    cloud: createApiClient<EcCloudPaths>({
      ...shared,
      baseUrl: `${CLOUD_API}${CLOUD_BASE_PATH}`,
      httpError: httpError(CLOUD_BASE_PATH),
    }),
    serverless: createApiClient<ServerlessPaths>({
      ...shared,
      baseUrl: CLOUD_API,
      httpError: httpError(""),
    }),
    projects: createApiClient<ProjectPaths>({
      ...shared,
      baseUrl: CLOUD_API,
      httpError: httpError(""),
    }),
    billing: createApiClient<BillingPaths>({
      ...shared,
      baseUrl: BILLING_API,
      httpError: httpError(""),
    }),
  };
}

/** What a follow-up read sends, which the routes under `CursorListRoute` all accept. */
export interface CursorSend {
  headers?: Record<string, string>;
  query?: { next_page: string };
}

/** One answer of a `readCursorList` read: its rows, under whichever key the route uses. */
export interface CursorPage<T> {
  list: readonly T[] | null | undefined;
  next_page?: string | null | undefined;
}

/** The documents give no page size, so this is the sync's ceiling on sequential requests. */
const CURSOR_LIST_MAX_PAGES = 1000;

/** In the order tried: the first is how the Serverless document's traffic filters take it. */
const CURSOR_CARRIERS: ReadonlyArray<(token: string) => CursorSend> = [
  (token) => ({ headers: { "X-Elastic-Next-Page": token } }),
  (token) => ({ query: { next_page: token } }),
];

/** A follow-up answer that says this way of sending the token does not work. */
function refusedCursor(err: unknown): boolean {
  const s = statusOf(err);
  return s >= 400 && s < 500 && s !== 401 && s !== 429;
}

/**
 * Every row of a route that answers `next_page` while its document names no way to send
 * it back (#678). Each way of sending it is judged by what comes back: a new row, or the
 * end of the list, means it works. A repeat of what is in hand means it was ignored. With
 * none left the rest cannot be reached, and the list is refused rather than used as the
 * whole of it. An error on the first read is left as it is for the caller to judge, but a
 * refused follow-up is not: a caller reading a 403 as "no rows" would drop the ones in hand.
 */
export async function readCursorList<T extends { id?: string | undefined }>(
  place: { path: string; key: string },
  read: (send: CursorSend) => Promise<CursorPage<T>>,
): Promise<T[]> {
  const rows = new Map<string, T>();
  const take = (page: CursorPage<T>): number => {
    const before = rows.size;
    for (const row of requireListPage(page.list, { vendor: VENDOR, ...place })) {
      if (row.id && !rows.has(row.id)) rows.set(row.id, row);
    }
    return rows.size - before;
  };
  const unreachable = (pages: number) =>
    new ListTruncatedError({
      vendor: VENDOR,
      path: place.path,
      items: rows.size,
      maxPages: pages,
    });

  const first = await read({});
  take(first);
  let token = first.next_page;
  let carrier = 0;
  let carrierWorks = false;
  for (let requests = 1; token; requests++) {
    const send = CURSOR_CARRIERS[carrier];
    if (!send || requests === CURSOR_LIST_MAX_PAGES) throw unreachable(requests);
    const page = await read(send(token)).catch((err: unknown) => {
      if (refusedCursor(err)) return undefined;
      throw err;
    });
    const added = page ? take(page) : 0;
    if (page && !page.next_page) return [...rows.values()];
    // The document says of its sibling route that a token does not promise rows, so an
    // empty page with a new token is still moving.
    if (page && (added > 0 || (page.list?.length === 0 && page.next_page !== token))) {
      carrierWorks = true;
      token = page.next_page;
      continue;
    }
    if (carrierWorks) throw unreachable(requests + 1);
    carrier++;
  }
  return [...rows.values()];
}

/** HTTP status of a failed call, or 0 for a transport error. */
export function statusOf(err: unknown): number {
  return err instanceof EcApiError ? err.status : 0;
}

/** True for the answers that mean "this key may not do that". */
export function isPermissionError(err: unknown): boolean {
  const s = statusOf(err);
  return s === 401 || s === 403;
}
