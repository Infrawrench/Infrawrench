import {
  createApiClient,
  ListTruncatedError,
  requireListPage,
  type ApiClient,
  type ApiFailure,
  type HttpHostServices,
} from "@infrawrench/plugin-base";
import type { paths as V1Paths } from "./api-types.v1.gen.js";
import type { paths as V2Paths } from "./api-types.v2.gen.js";
import type { DatadogSite } from "./sites.js";

/**
 * Everything a Datadog request needs. Split out of the client so the cost
 * collector and the preflight probe can be exercised without one. Datadog
 * publishes one OpenAPI document per API version and both are in use; each
 * client only accepts the paths of its own.
 */
export interface DatadogContext {
  site: DatadogSite;
  v1: ApiClient<V1Paths>;
  v2: ApiClient<V2Paths>;
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

/**
 * Clients for the account's site. Datadog authenticates every management call
 * with two headers: `DD-API-KEY` identifies the organization and
 * `DD-APPLICATION-KEY` identifies the user (or service account) and carries
 * their permissions, or the key's narrower scopes when it has any.
 *
 * Routed through the host HTTP service whenever there is one: that is the only
 * path that honours bastion egress and a custom CA.
 */
export function createDatadogContext(options: {
  apiKey: string;
  appKey: string;
  site: DatadogSite;
  caCert?: string | undefined;
  http?: HttpHostServices | undefined;
}): DatadogContext {
  const { apiKey, appKey, site, caCert, http } = options;
  const shared = {
    vendor: "Datadog",
    baseUrl: site.apiUrl,
    headers: {
      Accept: "application/json",
      "DD-API-KEY": apiKey,
      "DD-APPLICATION-KEY": appKey,
    },
    caCert,
    http,
    // Names the path alone: a query can hold tag values and search text.
    httpError: ({ status, path, body }: ApiFailure) =>
      new DatadogApiError(status, `Datadog API error ${status} for ${path}: ${body}`),
  };
  return {
    site,
    v1: createApiClient<V1Paths>(shared),
    v2: createApiClient<V2Paths>(shared),
  };
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

/** Which list is being read, and how far. */
export interface PagedList {
  /** The route, for the errors this throws. */
  path: string;
  /** The field holding the list, or `null` when the answer is the list. */
  key: string | null;
  pageSize: number;
  maxPages: number;
  /** For a picker, where the first `maxPages` will do. Never for a list that is stored. */
  partial?: boolean;
}

/**
 * Read a list page by page, ending on a short page. A hand loop because Datadog pages
 * each route with its own parameter names, zero-based, with no `next` to follow. A sync
 * prunes what a list stops returning, so a page that is not a list and a list longer
 * than the cap both throw. `page` counts from zero.
 */
export async function readPages<Item>(
  list: PagedList,
  fetchPage: (page: number) => Promise<readonly Item[] | null | undefined>,
): Promise<Item[]> {
  const { path, key, pageSize, maxPages, partial } = list;
  const out: Item[] = [];
  for (let page = 0; page < maxPages; page++) {
    const batch = requireListPage(await fetchPage(page), { vendor: "Datadog", path, key });
    out.push(...batch);
    if (batch.length < pageSize) return out;
  }
  if (partial) return out;
  throw new ListTruncatedError({ vendor: "Datadog", path, items: out.length, maxPages });
}

/** {@link readPages} for a JSON:API answer, collecting `included` beside `data`. */
export async function readJsonApiPages<Item, Included>(
  list: Omit<PagedList, "key">,
  fetchPage: (page: number) => Promise<{ data?: Item[]; included?: Included[] }>,
): Promise<{ data: Item[]; included: Included[] }> {
  const included: Included[] = [];
  const data = await readPages({ ...list, key: "data" }, async (page) => {
    const res = await fetchPage(page);
    included.push(...(res.included ?? []));
    return res.data;
  });
  return { data, included };
}

/** The paging parameters of a JSON:API style list, for the call to send last. */
export interface JsonApiPage {
  "page[size]": number;
  "page[number]": number;
}

/** The document's maximum for `page[size]` on these routes. */
const JSON_API_PAGE_SIZE = 100;
const JSON_API_MAX_PAGES = 500;

/**
 * Every page of a JSON:API style list (`page[size]` / `page[number]`), the shape the
 * v2 users, API key and application key endpoints share.
 */
export function ddPaged<Item, Included>(
  path: string,
  fetchPage: (page: JsonApiPage) => Promise<{ data?: Item[]; included?: Included[] }>,
): Promise<{ data: Item[]; included: Included[] }> {
  return readJsonApiPages(
    { path, pageSize: JSON_API_PAGE_SIZE, maxPages: JSON_API_MAX_PAGES },
    (page) => fetchPage({ "page[size]": JSON_API_PAGE_SIZE, "page[number]": page }),
  );
}
