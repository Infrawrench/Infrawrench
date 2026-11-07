import {
  createApiClient,
  ListTruncatedError,
  requireListPage,
  type ApiClient,
  type HostServices,
  type ParamValue,
} from "@infrawrench/plugin-base";
import type { paths } from "./api-types.gen.js";
import { apiError, clerkTransport } from "./http.js";

/**
 * Clerk Backend API client (https://api.clerk.com/v1). Types come from Clerk's
 * published spec for the pinned version (github.com/clerk/openapi-specs,
 * bapi/2026-05-12.yml), through `../plugingen.json`. Auth is
 * `Authorization: Bearer sk_live_…` (or `sk_test_…` for a development
 * instance); the key is per instance.
 */

export const BASE_URL = "https://api.clerk.com/v1";
/** Pinned so a future Clerk version cannot change response shapes under us. */
export const API_VERSION = "2026-05-12";

/** Without the leading `?`. A blank value is not sent, unlike the client's default. */
export function buildQuery(query: Record<string, ParamValue>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === "") continue;
    params.set(key, String(value));
  }
  return params.toString();
}

const PAGE_LIMIT = 500;
/** 100 pages. Above what the host can prune for one account (#572) would not help. */
const MAX_ITEMS = 50_000;

export const VENDOR = "Clerk";

/** What a list route answers. The document picks one for each; both have been seen. */
export type ListBody<T> = T[] | { data?: T[]; total_count?: number };

export interface ListOptions {
  maxItems?: number;
  /** For a picker or a detail view: stop at `maxItems` rather than refuse the list. */
  partial?: boolean;
}

/**
 * Offset pagination (`limit` ≤ 500). Some endpoints answer a bare array, others
 * `{data, total_count}`, and a route can change with `paginated`, so this reads
 * both rather than trust the document's choice: hence one page function per call
 * site, not `withCursorPagination`, whose `getAll` reads a single key.
 *
 * A sync prunes what a list stops returning, and an action acts on what it reads,
 * so past the cap or on a page that is not a list this throws.
 */
export async function listPages<T>(
  path: string,
  fetchPage: (paging: { limit: number; offset: number }) => Promise<ListBody<T> | null | undefined>,
  { maxItems = MAX_ITEMS, partial = false }: ListOptions = {},
): Promise<T[]> {
  const out: T[] = [];
  const maxPages = Math.ceil(maxItems / PAGE_LIMIT);
  for (let page = 0; page < maxPages; page++) {
    const body = await fetchPage({ limit: PAGE_LIMIT, offset: out.length });
    const items = requireListPage(Array.isArray(body) ? body : body?.data, {
      vendor: VENDOR,
      path,
      key: "data",
    });
    out.push(...items);
    const total = Array.isArray(body) ? undefined : body?.total_count;
    // A route may answer fewer than the limit asked for, so a short page only ends a list with no count.
    const done =
      total === undefined ? items.length < PAGE_LIMIT : items.length === 0 || out.length >= total;
    if (done) return out;
  }
  if (partial) return out;
  throw new ListTruncatedError({ vendor: VENDOR, path, items: out.length, maxPages });
}

export type ClerkApi = ApiClient<paths> & { isDevelopment: boolean; list: typeof listPages };

export function createClerkApi(
  secretKey: string,
  caCert: string,
  services: HostServices | undefined,
): ClerkApi {
  const client = createApiClient<paths>({
    vendor: VENDOR,
    baseUrl: BASE_URL,
    headers: {
      Authorization: `Bearer ${secretKey}`,
      Accept: "application/json",
      "Clerk-API-Version": API_VERSION,
    },
    http: clerkTransport(services),
    caCert,
    contentType: "with-body",
    emptyBodyIsUndefined: true,
    serializeQuery: buildQuery,
    httpError: ({ status, path, body }) => apiError(status, path, body),
  });
  return { ...client, isDevelopment: secretKey.startsWith("sk_test_"), list: listPages };
}
