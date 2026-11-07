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
  jsonRestFetch,
  restRequest,
  type ApiClient,
  type ApiListItem,
  type ApiResponse,
  type HttpHostServices,
  type NoSlashString,
} from "@infrawrench/plugin-base";
import type { components, operations, paths } from "./api-types.gen.js";

export const API_BASE = "https://api.replicate.com/v1";

const VENDOR = "Replicate";

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
 * Every list endpoint answers `{next, previous, results}` where the cursors are
 * fully-qualified URLs carrying an opaque `cursor` query param. They must be
 * followed verbatim: there is no documented way to build one by hand.
 * https://replicate.com/docs/reference/http
 */
export interface ListPage<Item> {
  next?: string | null;
  results?: Item[];
}

/** One `next` link, sent as written, to whichever host it names. */
async function followPage<Item>(
  { apiToken, caCert, http }: ReplicateConnection,
  url: string,
): Promise<ListPage<Item>> {
  return jsonRestFetch<ListPage<Item>>({
    vendor: VENDOR,
    url,
    errorPath: url.startsWith(API_BASE) ? url.slice(API_BASE.length) || "/" : url,
    headers: jsonHeaders(apiToken),
    ...(http ? { http } : {}),
    ...(caCert ? { caCert } : {}),
  });
}

/**
 * Walk a list from its typed first page. A hand loop rather than
 * `withLinkPagination` because that reads a `results` that is not an array as an
 * empty page, where this has always failed on it, and `next` is passed straight
 * back rather than decomposed because the cursor inside it is base64 of a
 * provider-private ordering key. `truncated` says a link was still in hand at
 * `maxPages`.
 */
export async function walkList<Item>(
  connection: ReplicateConnection,
  first: () => Promise<ListPage<Item>>,
  maxPages: number,
): Promise<{ items: Item[]; truncated: boolean }> {
  const items: Item[] = [];
  let data = await first();
  for (let page = 1; ; page += 1) {
    items.push(...(data.results ?? []));
    const url = data.next ?? undefined;
    if (!url) return { items, truncated: false };
    if (page >= maxPages) return { items, truncated: true };
    data = await followPage<Item>(connection, url);
  }
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
