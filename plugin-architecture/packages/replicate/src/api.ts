/**
 * The Replicate HTTP API, typed from Replicate's published OpenAPI document.
 *
 * Auth is `Authorization: Bearer r8_…`. The older `Token` scheme still appears
 * in some of Replicate's own examples, but `bearerAuth` is the only security
 * scheme in the current document.
 * https://replicate.com/docs/reference/http#authentication
 */
import {
  createApiClient,
  restRequest,
  withLinkPagination,
  type ApiClient,
  type ApiListItem,
  type ApiResponse,
  type HttpHostServices,
  type NoSlashString,
} from "@infrawrench/plugin-base";
import type { components, operations, paths } from "./api-types.gen.js";

export const API_BASE = "https://api.replicate.com/v1";

export const VENDOR = "Replicate";

type Schemas = components["schemas"];

/** Identity only: no billing fields exist on it. Empty when `GET /v1/account` could not be read. */
export type ReplicateAccount = Partial<ApiResponse<operations["account.get"]>>;
export type ReplicatePrediction = Schemas["schemas_prediction_response"];
export type ReplicateVersion = Schemas["schemas_version_response"];
export type ReplicateModel = Schemas["schemas_model_response"];
/** `GET /v1/collections` items are slim; the detail response adds `models`. */
export type ReplicateCollection = Schemas["schemas_collection_list_item"] &
  Partial<Pick<Schemas["schemas_collection_response"], "models">>;
export type ReplicateTraining = Schemas["schemas_training_response"];
export type ReplicateDeployment = Schemas["schemas_deployment_response"];
export type ReplicateHardware = ApiListItem<operations["hardware.list"], null>;
/** `name` is read from the answer but is not in the document's file schema. */
export type ReplicateFile = Schemas["schemas_file_response"] & { name?: string };

/** Everything a request needs. */
export interface ReplicateConnection {
  apiToken: string;
  /** Empty when the account has none. */
  caCert: string;
  http: HttpHostServices | undefined;
}

/** A non-2xx answer, for a read that has to tell "this is gone" from "this failed". */
export class ReplicateApiError extends Error {
  readonly status: number;
  constructor(status: number, target: string, body: string) {
    super(`${VENDOR} API error ${status} for ${target}: ${body}`);
    this.name = "ReplicateApiError";
    this.status = status;
  }
}

export function isNotFound(err: unknown): boolean {
  return err instanceof ReplicateApiError && err.status === 404;
}

function jsonHeaders(apiToken: string): Record<string, string> {
  return { Authorization: `Bearer ${apiToken}`, Accept: "application/json" };
}

function textHeaders(apiToken: string): Record<string, string> {
  return { Authorization: `Bearer ${apiToken}`, Accept: "text/plain, */*" };
}

export function createReplicateApi({
  apiToken,
  caCert,
  http,
}: ReplicateConnection): ApiClient<paths> {
  return createApiClient<paths>({
    vendor: VENDOR,
    baseUrl: API_BASE,
    headers: jsonHeaders(apiToken),
    http,
    caCert,
    httpError: ({ status, target, body }) => new ReplicateApiError(status, target, body),
  });
}

/** For the model README, which answers `text/plain` markdown and is asked with no `Content-Type`. */
export function createReplicateTextApi({
  apiToken,
  caCert,
  http,
}: ReplicateConnection): ApiClient<paths> {
  return createApiClient<paths>({
    vendor: VENDOR,
    baseUrl: API_BASE,
    headers: textHeaders(apiToken),
    contentType: "with-body",
    http,
    caCert,
  });
}

/**
 * `DELETE /v1/models/{owner}/{name}/versions/{id}` answers an empty `202`. Whatever
 * does come back on a 2xx is ignored, so it stays out of the typed client, which
 * would parse it.
 */
export async function deleteVersionRequest(
  { apiToken, caCert, http }: ReplicateConnection,
  path: string,
): Promise<void> {
  await restRequest<string>({
    vendor: VENDOR,
    url: `${API_BASE}${path}`,
    errorPath: path,
    headers: textHeaders(apiToken),
    init: { method: "DELETE" },
    contentType: "with-body",
    responseAs: "text",
    ...(http ? { http } : {}),
    ...(caCert ? { caCert } : {}),
  });
}

/**
 * Every list route answers `{next, previous, results}`, where `next` is a whole URL
 * holding an opaque cursor, sent back as written. There is no page-size parameter.
 * The document marks the end of a list only with a null `next`, so an empty page
 * that still names one does not end it, and a wrong end would read as deletions.
 * https://replicate.com/docs/reference/http
 */
export function replicatePages(
  api: ApiClient<paths>,
  options: { maxPages: number; onTruncated?: () => void },
) {
  return withLinkPagination(api, { next: "next", continueOnEmptyPage: true, ...options });
}

/** An `owner/name` reference as the two path segments the document's routes have. */
type OwnerName = `${NoSlashString}/${NoSlashString}`;

/**
 * Encode an `owner/name` pair without escaping the separating slash. The signature
 * is what the document's routes ask for; what it does is what it has always done
 * with any id, so one holding no slash or several still goes out as it did.
 */
export function encodePath(ref: string): OwnerName;
export function encodePath(ref: string): string {
  return ref
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}
