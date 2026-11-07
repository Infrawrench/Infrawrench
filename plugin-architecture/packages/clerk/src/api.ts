import {
  createApiClient,
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

/** What a list route answers. The document picks one for each; both have been seen. */
export type ListBody<T> = T[] | { data?: T[]; total_count?: number };

/**
 * Offset pagination (`limit` ≤ 500). Some endpoints answer a bare array, others
 * `{data, total_count}`, and a route can change with `paginated`, so this reads
 * both rather than trust the document's choice: hence one page function per call
 * site, not `withCursorPagination`, whose `getAll` reads a single key.
 */
export async function listPages<T>(
  fetchPage: (paging: { limit: number; offset: number }) => Promise<ListBody<T> | null | undefined>,
  maxItems = 2500,
): Promise<T[]> {
  const out: T[] = [];
  const limit = PAGE_LIMIT;
  for (let offset = 0; offset < maxItems; offset += limit) {
    const body = await fetchPage({ limit, offset });
    const items = Array.isArray(body) ? body : (body?.data ?? []);
    out.push(...items);
    const total = Array.isArray(body) ? undefined : body?.total_count;
    if (items.length < limit || (total !== undefined && out.length >= total)) break;
  }
  return out;
}

export type ClerkApi = ApiClient<paths> & { isDevelopment: boolean; list: typeof listPages };

export function createClerkApi(
  secretKey: string,
  caCert: string,
  services: HostServices | undefined,
): ClerkApi {
  const client = createApiClient<paths>({
    vendor: "Clerk",
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
