/**
 * Pagination for the resource listers.
 *
 * Every AWS list/describe action returns one page and a continuation token
 * (`Marker`, `NextToken`, `nextToken`, `NextMarker`, ...); a lister that reads
 * only the first page silently truncates large accounts. `collectPages` owns
 * the loop so each lister only has to say how to fetch one page and where the
 * next token lives.
 */

import { ListTruncatedError } from "@infrawrench/plugin-base";

import { ListInterruptedError } from "./aws-errors.js";

/**
 * What one list may read per region before refusing: the most a poll can read
 * and write inside its 300 seconds, about 200 seconds at 200 ms a page.
 */
export const MAX_LIST_PAGES = 1000;
export const MAX_LIST_ITEMS = 100_000;

export interface Page<T> {
  items: T[];
  /** The continuation token for the next page; empty, null or absent ends the walk. */
  next?: unknown;
}

export interface CollectPagesOptions {
  maxPages?: number;
  maxItems?: number;
  /** Named in the error past a cap. The host already says which resource type it was. */
  path?: string;
}

/**
 * Fetch pages until the service stops returning a token (or returns the same
 * token twice, which would otherwise loop until the cap), concatenating each
 * page's items in order. Past a cap it throws: a sync would read the rows it
 * did not get to as deleted.
 */
export async function collectPages<T>(
  fetchPage: (token: string | undefined) => Promise<Page<T>>,
  options: CollectPagesOptions = {},
): Promise<T[]> {
  const { maxPages = MAX_LIST_PAGES, maxItems = MAX_LIST_ITEMS, path = "a list" } = options;
  const items: T[] = [];
  let token: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    let result: Page<T>;
    try {
      result = await fetchPage(token);
    } catch (err) {
      throw page === 0 ? err : new ListInterruptedError(err);
    }
    items.push(...result.items);
    const next = result.next == null ? "" : String(result.next);
    if (!next || next === token) return items;
    if (items.length >= maxItems) {
      throw new ListTruncatedError({ vendor: "AWS", path, items: items.length, maxItems });
    }
    token = next;
  }
  throw new ListTruncatedError({ vendor: "AWS", path, items: items.length, maxPages });
}

/**
 * The continuation param for a request, or nothing on the first page:
 * `{ ...tokenParam("Marker", marker) }`.
 */
export function tokenParam(name: string, token: string | undefined): Record<string, string> {
  return token ? { [name]: token } : {};
}

/**
 * A `?a=1&b=2` query string for the REST list calls, skipping undefined
 * values (so the token drops out on the first page): `queryString({ maxResults: 100, nextToken })`.
 */
export function queryString(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : "";
}
