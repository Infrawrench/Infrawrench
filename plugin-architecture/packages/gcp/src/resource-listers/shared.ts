export interface ListerContext {
  get: <T>(url: string) => Promise<T>;
  paginate: <T>(baseUrl: string, key: string, params?: Record<string, string>) => Promise<T[]>;
  id: (accountId: string, typeId: string, externalId: string) => string;
  now: () => string;
}

/**
 * Last path segment of a GCP reference. Most GCP payloads point at other
 * resources with a full selfLink (`https://…/projects/p/global/networks/default`)
 * while the target's external id is the bare name — dependency matching is
 * exact, so the URL has to be reduced to that name before it can match.
 * Values that are already bare names pass through unchanged.
 */
export function lastSegment(value: unknown): string {
  const parts = String(value ?? "").split("/");
  return (parts[parts.length - 1] ?? "").trim();
}

/**
 * Join reference values into one scalar field. The dependency graph splits a
 * comma-joined value into one edge per element, so a list of references (a VM's
 * network interfaces, a backend service's health checks) becomes one field.
 * Empties are dropped and duplicates collapsed — two NICs on one network are
 * still one edge.
 */
export function joinRefs(values: Array<string | undefined>): string {
  return [...new Set(values.filter((v): v is string => Boolean(v)))].join(", ");
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
