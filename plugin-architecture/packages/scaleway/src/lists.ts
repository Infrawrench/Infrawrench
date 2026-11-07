import { ListPageError, ListTruncatedError, reportUnreadListPart } from "@infrawrench/plugin-base";

/**
 * Reading a list across Scaleway's zones and regions. A sync soft-deletes whatever
 * a list stops returning, so anything short of "this is all of it" has to throw.
 */

const VENDOR = "Scaleway";

/** The largest page the SDKs' validation rules and the REST products accept. */
export const PAGE_SIZE = 100;
/** 100,000 rows: past this a poll would be killed before it could write them. */
export const MAX_PAGES = 1000;

/** A non-2xx answer from a route the SDKs do not cover, with its status readable. */
export class ScalewayHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ScalewayHttpError";
    this.status = status;
  }
}

function statusOf(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null || !("status" in err)) return undefined;
  return typeof err.status === "number" ? err.status : undefined;
}

/** Scaleway's `permissions_denied`: the key's policy leaves this out. */
export function isDenied(err: unknown): boolean {
  return statusOf(err) === 403;
}

/**
 * Whether an answer says this request is not served here, rather than that the read
 * failed. Scaleway documents no single answer for a product it does not offer in a
 * location, so this is any 4xx or a 501, the answers that do not change on a retry.
 * A 401 is an expired key, and a 408 or 429 will pass. Those, every other 5xx and a
 * failure with no status at all mean the rows are unknown, not absent.
 */
export function isRefusal(err: unknown): boolean {
  const status = statusOf(err);
  if (status === undefined) return false;
  if (status === 501) return true;
  return status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 429;
}

/**
 * Every location's rows. A location that refuses (see {@link isRefusal}) has none;
 * anything else fails the whole list, so the rows stored for it stay. A refusal from
 * every location says the credential or the request is at fault, not that the
 * account is empty. A 403 among them is a key whose policy leaves this product out,
 * which is normal: the type keeps its stored rows without an error, except where
 * nobody keeps them. Anything else from every location throws.
 */
export async function fanOut<L extends string, T>(
  locations: readonly L[],
  what: string,
  read: (location: L) => Promise<T[]>,
): Promise<T[]> {
  const results = await Promise.allSettled(locations.map(read));
  const rows: T[] = [];
  const refusals: unknown[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") rows.push(...result.value);
    else if (isRefusal(result.reason)) refusals.push(result.reason);
    else throw result.reason;
  }
  if (locations.length > 0 && refusals.length === locations.length) {
    const denied = refusals.some(isDenied);
    if (denied && reportUnreadListPart({ idPrefixes: [""] })) return [];
    const first = refusals[0];
    const reason = first instanceof Error ? first.message : String(first);
    throw new Error(`Scaleway refused ${what} in every location. The first answer: ${reason}`, {
      cause: first,
    });
  }
  return rows;
}

/**
 * Every page of an SDK list. `.all()` has no cap and works out the remaining pages
 * from the first page's total, which `path` names when it stops making sense.
 */
export async function everyPage<T>(
  listing: Promise<{ totalCount?: number }> & { all(): Promise<T[]> },
  path: string,
): Promise<T[]> {
  const first = await listing;
  const total = first.totalCount;
  const maxItems = PAGE_SIZE * MAX_PAGES;
  if (total !== undefined && total > maxItems) {
    throw new ListTruncatedError({ vendor: VENDOR, path, items: 0, maxItems });
  }
  const rows = await listing.all();
  // With no total the SDK reads page one as the last, however full it is.
  if (total === undefined && rows.length >= PAGE_SIZE) {
    throw new ListPageError({
      vendor: VENDOR,
      path,
      key: "total_count",
      found: undefined,
      page: first,
    });
  }
  // The SDK reads a renamed key as an empty list, which only the total gives away.
  if (total !== undefined && total > 0 && rows.length === 0) {
    throw new ListPageError({
      vendor: VENDOR,
      path,
      key: "total_count",
      found: total,
      saysMoreWith: "no rows",
    });
  }
  return rows;
}
