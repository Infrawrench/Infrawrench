/**
 * Pagination for the resource listers.
 *
 * Every AWS list/describe action returns one page and a continuation token
 * (`Marker`, `NextToken`, `nextToken`, `NextMarker`, ...); a lister that reads
 * only the first page silently truncates large accounts. `collectPages` owns
 * the loop so each lister only has to say how to fetch one page and where the
 * next token lives.
 */

/** Safety cap: at the usual 100 items a page this is 10,000 resources per region. */
export const MAX_LIST_PAGES = 100;

export interface Page<T> {
  items: T[];
  /** The continuation token for the next page; empty, null or absent ends the walk. */
  next?: unknown;
}

/**
 * Fetch pages until the service stops returning a token (or returns the same
 * token twice, which would otherwise loop until the cap), concatenating each
 * page's items in order.
 */
export async function collectPages<T>(
  fetchPage: (token: string | undefined) => Promise<Page<T>>,
  maxPages: number = MAX_LIST_PAGES,
): Promise<T[]> {
  const items: T[] = [];
  let token: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const result = await fetchPage(token);
    items.push(...result.items);
    const next = result.next == null ? "" : String(result.next);
    if (!next || next === token) return items;
    token = next;
  }
  console.warn(`[aws] stopped paging after ${maxPages} pages; the list may be incomplete`);
  return items;
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
