export interface ListerContext {
  get: <T>(url: string) => Promise<T>;
  paginate: <T>(baseUrl: string, key: string, params?: Record<string, string>) => Promise<T[]>;
  id: (accountId: string, typeId: string, externalId: string) => string;
  now: () => string;
}

/**
 * Paginate a GCP `/aggregated/*` endpoint. The response `items` is an object
 * keyed by scope (e.g. `zones/us-central1-a`). Each scope contains a per-kind
 * array under `innerKey` — we follow `nextPageToken` and flatten to a single
 * array of items.
 */
export async function paginateAggregated<T>(
  ctx: ListerContext,
  baseUrl: string,
  innerKey: string,
): Promise<T[]> {
  const results: T[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(baseUrl);
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const page = await ctx.get<{
      items?: Record<string, Record<string, unknown>>;
      nextPageToken?: string;
    }>(url.toString());
    for (const scopeData of Object.values(page.items ?? {})) {
      const scopeItems = scopeData[innerKey];
      if (Array.isArray(scopeItems)) results.push(...(scopeItems as T[]));
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  return results;
}
