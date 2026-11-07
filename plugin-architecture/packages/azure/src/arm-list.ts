/**
 * Reading an ARM list, and telling what a failed read means.
 *
 * A sync soft-deletes whatever a list stops returning, so a list either has every
 * row or throws: ARM pages at each provider's discretion, and nothing in a response
 * says a first page is the whole list except the absence of `nextLink`.
 */
import { followableLink, ListTruncatedError, requireListPage } from "@infrawrench/plugin-base";

/**
 * What one poll can read and write (300 seconds, 2 GB). ARM's page size is the
 * provider's choice and takes no maximum from us, so both are checked.
 */
export const MAX_ARM_LIST_PAGES = 1000;
export const MAX_ARM_LIST_ROWS = 100_000;

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
  ctx: { get<R>(url: string): Promise<R> },
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
