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
  "/api/v1/serverless/projects/{type}": ProjectRoute<"">;
  "/api/v1/serverless/projects/{type}/{id}": ProjectRoute<"/{id}">;
  "/api/v1/serverless/projects/{type}/{id}/status": ProjectRoute<"/{id}/status">;
  "/api/v1/serverless/projects/{type}/{id}/_resume": ProjectRoute<"/{id}/_resume">;
  "/api/v1/serverless/projects/{type}/{id}/_reset-credentials": ProjectRoute<"/{id}/_reset-credentials">;
}

/** Everything a request needs; split out so collectors can run without a client. */
export interface EcContext {
  cloud: ApiClient<CloudPaths>;
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
    cloud: createApiClient<CloudPaths>({
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

/**
 * The list of a route that can answer `next_page` while its document names no way to
 * send it back. A token means rows this read cannot reach, so the page is not used as
 * the whole list. Actually following it waits on a live check: #678.
 */
export function onlyPage<T>(
  body: { next_page?: string | null | undefined },
  list: readonly T[] | null | undefined,
  place: { path: string; key: string },
): T[] {
  const rows = requireListPage(list, { vendor: VENDOR, ...place });
  if (body.next_page) {
    throw new ListTruncatedError({
      vendor: VENDOR,
      path: place.path,
      items: rows.length,
      maxPages: 1,
    });
  }
  return rows;
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
