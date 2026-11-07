/**
 * Reading an ARM list, and telling what a failed read means.
 *
 * A sync soft-deletes whatever a list stops returning, so a list either has every
 * row or throws: ARM pages at each provider's discretion, and nothing in a response
 * says a first page is the whole list except the absence of `nextLink`.
 */
import {
  followableLink,
  ListTruncatedError,
  requireListPage,
  rethrowIncompleteList,
  type ListPlace,
} from "@infrawrench/plugin-base";

/**
 * What one poll can read and write (300 seconds, 2 GB). ARM's page size is the
 * provider's choice and takes no maximum from us, so both are checked.
 */
export const MAX_ARM_LIST_PAGES = 1000;
export const MAX_ARM_LIST_ROWS = 100_000;

interface ArmReader {
  get<R>(url: string): Promise<R>;
}

interface ArmListPage<T> {
  value?: T[] | null;
  nextLink?: string | null;
}

/**
 * Every item of an ARM list, following `nextLink` until it runs out. A page may be
 * empty and still say there is more. A page with no `value` is refused rather than
 * read as the end: no ARM document says an empty list leaves the key out, and on the
 * host's HTTP path an empty body arrives looking just like that.
 */
export async function listAllPages<T = Record<string, unknown>>(
  ctx: ArmReader,
  url: string,
): Promise<T[]> {
  const place = { vendor: "Azure", path: new URL(url).pathname };
  const items: T[] = [];
  let pageUrl = url;
  for (let page = 0; page < MAX_ARM_LIST_PAGES; page++) {
    const body = await ctx.get<ArmListPage<T>>(pageUrl);
    items.push(...requireListPage(body.value, { ...place, key: "value", page: body }));
    if (!body.nextLink) return items;
    if (items.length >= MAX_ARM_LIST_ROWS) {
      throw new ListTruncatedError({ ...place, items: items.length, maxItems: MAX_ARM_LIST_ROWS });
    }
    pageUrl = followableLink(body.nextLink, pageUrl, place);
  }
  throw new ListTruncatedError({ ...place, items: items.length, maxPages: MAX_ARM_LIST_PAGES });
}

/** The HTTP status in the error the client's ARM verbs throw, if that is what this is. */
function armStatus(err: unknown): number | undefined {
  if (!(err instanceof Error)) return undefined;
  const match = /^Azure API (?:[A-Z]+ )?(\d{3})\b/.exec(err.message);
  return match ? Number(match[1]) : undefined;
}

/** This principal may not read it, or it is gone. Neither changes on a retry. */
export function isArmDeniedOrGone(err: unknown): boolean {
  const status = armStatus(err);
  return status === 403 || status === 404;
}

/**
 * ARM said no to this request itself: a 4xx other than an expired credential or a
 * throttle, which say nothing about the thing being read. A 5xx or a dropped
 * connection is not a refusal either.
 */
export function isArmRefusal(err: unknown): boolean {
  const status = armStatus(err);
  if (status === undefined || status < 400 || status >= 500) return false;
  return status !== 401 && status !== 408 && status !== 429;
}

/**
 * How many per-row reads run at once. ARM refills 25 reads a second per subscription
 * and service principal from a bucket of 250, and Microsoft.Network allows 10,000 GETs
 * in 5 minutes, about 33 a second. At about 200 ms a request, 5 at a time is the refill
 * rate. Microsoft Graph's smallest tenant allows 350 such lookups a second.
 * https://learn.microsoft.com/azure/azure-resource-manager/management/request-limits-and-throttling
 * https://learn.microsoft.com/graph/throttling-limits
 */
export const PER_ROW_READS_AT_ONCE = 5;

/** Each item through `read`, a few at a time, with the answers in the items' order. */
export async function mapBounded<T, R>(
  items: readonly T[],
  read: (item: T) => Promise<R>,
  { from = 0 }: { from?: number } = {},
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let started = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && started < items.length) {
      const index = (from + started++) % items.length;
      try {
        results[index] = await read(items[index]!);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  // Settled, not `all`: no read may still be running when this answers or throws.
  const workers = Array.from({ length: Math.min(PER_ROW_READS_AT_ONCE, items.length) }, worker);
  for (const settled of await Promise.allSettled(workers)) {
    if (settled.status === "rejected") throw settled.reason;
  }
  return results;
}

/**
 * Where to start filling rows in. A subscription too big to fill in one poll gets a
 * different stretch each time, and the sync keeps what earlier polls read for the rest.
 */
export function startingRow(rows: readonly unknown[]): number {
  return Math.floor(Math.random() * rows.length);
}

class BudgetSpent extends Error {}

function isThrottled(err: unknown): boolean {
  if (armStatus(err) === 429) return true;
  return typeof err === "object" && err !== null && "statusCode" in err && err.statusCode === 429;
}

/**
 * The requests one list may make, its own pages and its per-row reads together. A poll
 * past 300 seconds is killed with no message, so a list has to stop first: by refusing
 * where the reads supply rows, and by leaving fields out where they only add to a row.
 */
export class ReadBudget {
  private left: number;

  constructor(alreadyMade = 0) {
    this.left = MAX_ARM_LIST_PAGES - alreadyMade;
  }

  /** Count one request, before making it. */
  spend(): void {
    if (this.left <= 0) throw new BudgetSpent();
    this.left -= 1;
  }

  /** `ctx`, with every GET counted. */
  reader(ctx: ArmReader): ArmReader {
    return {
      get: <R>(url: string) => {
        this.spend();
        return ctx.get<R>(url);
      },
    };
  }

  /**
   * A read that only adds fields to a row the list already has. `undefined` when it
   * failed or the budget ran out, so the caller leaves those fields out: the sync
   * merges a row's fields over what is stored and a missing key keeps its value, where
   * a blank would overwrite it and record a change that never happened. A throttle ends
   * the rest, since ARM documents not processing requests sent before Retry-After.
   */
  async hydrate<R>(read: () => Promise<R>): Promise<R | undefined> {
    try {
      return await read();
    } catch (err) {
      rethrowIncompleteList(err);
      if (isThrottled(err)) this.left = 0;
      return undefined;
    }
  }

  /** A read whose answers are rows: past the budget the list cannot be whole. */
  async rows<R>(read: () => Promise<R>, place: ListPlace, items: number): Promise<R> {
    try {
      return await read();
    } catch (err) {
      if (!(err instanceof BudgetSpent)) throw err;
      throw new ListTruncatedError({ ...place, items, maxPages: MAX_ARM_LIST_PAGES });
    }
  }
}
