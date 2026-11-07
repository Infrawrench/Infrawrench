import {
  ListPageError,
  ListTruncatedError,
  reportUnreadListPart,
  type UnreadListPart,
} from "@infrawrench/plugin-base";

const VENDOR = "Google Cloud";

/** What one poll can read and write of a list before its lease runs out. */
const MAX_LIST_PAGES = 1000;
const MAX_LIST_ROWS = 100_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface ListerContext {
  get: <T>(url: string) => Promise<T>;
  paginate: <T>(baseUrl: string, key: string, params?: Record<string, string>) => Promise<T[]>;
  id: (accountId: string, typeId: string, externalId: string) => string;
  now: () => string;
}

/**
 * Last path segment of a GCP reference. Most GCP payloads point at other
 * resources with a full selfLink (`https://…/projects/p/global/networks/default`)
 * while the target's external id is the bare name: dependency matching is
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
 * Empties are dropped and duplicates collapsed: two NICs on one network are
 * still one edge.
 */
export function joinRefs(values: Array<string | undefined>): string {
  return [...new Set(values.filter((v): v is string => Boolean(v)))].join(", ");
}

/**
 * Paginate a GCP `/aggregated/*` endpoint. The response `items` is an object
 * keyed by scope (e.g. `zones/us-central1-a`). Each scope contains a per-kind
 * array under `innerKey`: we follow `nextPageToken` and flatten to a single
 * array of items.
 */
export async function paginateAggregated<T>(
  ctx: ListerContext,
  baseUrl: string,
  innerKey: string,
): Promise<T[]> {
  const path = new URL(baseUrl).pathname;
  const results: T[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const url = new URL(baseUrl);
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const body = await ctx.get<{
      items?: Record<string, Record<string, unknown>>;
      nextPageToken?: string;
    }>(url.toString());
    // `items` is keyed by scope and left out when there are none.
    if (body.items !== undefined && !isRecord(body.items)) {
      throw new ListPageError({
        vendor: VENDOR,
        path,
        key: "items",
        found: body.items,
        page: body,
      });
    }
    for (const scopeData of Object.values(body.items ?? {})) {
      const scopeItems = scopeData[innerKey];
      if (Array.isArray(scopeItems)) results.push(...(scopeItems as T[]));
    }
    pageToken = body.nextPageToken;
    if (!pageToken) return results;
    throwPastRowCap(path, results.length);
  }
  throw new ListTruncatedError({
    vendor: VENDOR,
    path,
    items: results.length,
    maxPages: MAX_LIST_PAGES,
  });
}

/**
 * Follow `nextPageToken` until it runs out, collecting `key` from each page. A key left
 * out is an empty page: Google's APIs answer in proto3 JSON, which omits an empty
 * repeated field. Anything else that is not an array is not a list, and reading it as
 * empty would prune whatever it should have held.
 */
export async function readPages<T>(
  get: <R>(url: string) => Promise<R>,
  baseUrl: string,
  key: string,
  params: Record<string, string> = {},
): Promise<T[]> {
  const path = new URL(baseUrl).pathname;
  const results: T[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const url = new URL(baseUrl);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const body = await get<unknown>(url.toString());
    if (!isRecord(body)) throw new ListPageError({ vendor: VENDOR, path, key, found: body });
    const items = body[key];
    if (items !== undefined && items !== null) {
      if (!Array.isArray(items)) {
        throw new ListPageError({ vendor: VENDOR, path, key, found: items, page: body });
      }
      for (const row of items) results.push(row);
    }
    const next = body["nextPageToken"];
    pageToken = typeof next === "string" && next ? next : undefined;
    if (!pageToken) return results;
    throwPastRowCap(path, results.length);
  }
  throw new ListTruncatedError({
    vendor: VENDOR,
    path,
    items: results.length,
    maxPages: MAX_LIST_PAGES,
  });
}

function throwPastRowCap(path: string, items: number): void {
  if (items >= MAX_LIST_ROWS) {
    throw new ListTruncatedError({ vendor: VENDOR, path, items, maxItems: MAX_LIST_ROWS });
  }
}

function statusOf(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null || !("status" in err)) return undefined;
  return typeof err.status === "number" ? err.status : undefined;
}

/**
 * Google sends some throttles as a 403: BigQuery documents `quotaExceeded` and
 * `rateLimitExceeded` there, and Compute and Cloud DNS do the same. Those say nothing
 * about what this credential may see.
 */
const THROTTLED_403 = /limit.?exceeded|quota.?exceeded|RESOURCE_EXHAUSTED/i;

function isPermissionRefusal(err: unknown): boolean {
  return statusOf(err) === 403 && !(err instanceof Error && THROTTLED_403.test(err.message));
}

/** Whether a read that failed says nothing is there, or that the credential can't see. */
type FanOutAnswer = "gone" | "refused" | "failed";

/** A parent the API just named: a 404 means it went away since, and took its children. */
function answerOfParent(err: unknown): FanOutAnswer {
  if (statusOf(err) === 404) return "gone";
  return isPermissionRefusal(err) ? "refused" : "failed";
}

/**
 * A region or location: the same path works elsewhere, so only the region can be the
 * problem with a missing endpoint or a rejected location. Never a throttle, a 5xx or an
 * expired credential, which say nothing about the region.
 */
function answerOfRegion(err: unknown): FanOutAnswer {
  const status = statusOf(err);
  if (status === 400 || status === 404 || status === 501) return "refused";
  return isPermissionRefusal(err) ? "refused" : "failed";
}

async function readFanOut<P, T>(
  parents: readonly P[],
  read: (parent: P) => Promise<T[]>,
  answerOf: (err: unknown) => FanOutAnswer,
  options: FanOutOptions<P>,
): Promise<T[]> {
  let answered = false;
  let refusal: { err: unknown } | undefined;
  const readOne = async (parent: P): Promise<T[]> => {
    try {
      const rows = await read(parent);
      answered = true;
      return rows;
    } catch (err) {
      const answer = answerOf(err);
      if (answer === "failed") throw err;
      if (answer === "refused") {
        refusal ??= { err };
        reportUnreadListPart(options.unread(parent));
      }
      return [];
    }
  };
  const perParent: T[][] = [];
  if (options.sequential) {
    for (const parent of parents) perParent.push(await readOne(parent));
  } else {
    perParent.push(...(await Promise.all(parents.map(readOne))));
  }
  // Every parent refusing is the credential or a disabled API, not the parents, and
  // an empty list would read as "all of it is gone".
  if (refusal && !answered) throw refusal.err;
  return perParent.flat();
}

export interface FanOutOptions<P> {
  /** The rows a refused read could not vouch for, which a sync then leaves unpruned. */
  unread: (parent: P) => UnreadListPart;
  /** One at a time, where the old loop was, to stay clear of a per-minute limit. */
  sequential?: boolean;
}

/**
 * Read each parent's children. A parent gone since it was listed has none. One refusing
 * this credential costs that parent's rows a refresh, not their existence, and the
 * others still read. Anything else, a throttle or a 5xx above all, fails the whole type
 * so that stored rows stay: reading it as none would prune that parent's children.
 */
export function readEachParent<P, T>(
  parents: readonly P[],
  read: (parent: P) => Promise<T[]>,
  options: FanOutOptions<P>,
): Promise<T[]> {
  return readFanOut(parents, read, answerOfParent, options);
}

/** {@link readEachParent} over regions or locations, where an unavailable one has none. */
export function readEachRegion<R, T>(
  regions: readonly R[],
  read: (region: R) => Promise<T[]>,
  options: FanOutOptions<R>,
): Promise<T[]> {
  return readFanOut(regions, read, answerOfRegion, options);
}
