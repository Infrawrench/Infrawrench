/**
 * What a list read throws when it cannot say it has every row. A resource sync
 * soft-deletes whatever a list stops returning, so anything short of "this is all
 * of it" has to be an error, and so does anything that hides one.
 *
 * Plugins are bundled with their own copy of this package, so the host cannot use
 * `instanceof`: {@link isIncompleteListError} reads a marker instead.
 */

const INCOMPLETE_LIST_HOOK = Symbol.for("infrawrench.incompleteList");

/** Where a list was being read, for the error's message. */
export interface ListPlace {
  /** The provider, e.g. `"Vercel"`. */
  vendor: string;
  /** The route as the call wrote it, with no query. */
  path: string;
}

/** The base of every error that means "this list cannot be trusted". */
export abstract class IncompleteListError extends Error {
  readonly incompleteList = true;
  readonly vendor: string;
  readonly path: string;

  protected constructor(place: ListPlace, message: string) {
    super(message);
    this.vendor = place.vendor;
    this.path = place.path;
    // A plugin that swallows this still returns a list the host must not trust.
    // Set on the host, by `runListChecked`; a global because the plugin's copy of
    // this package is not the host's.
    const noted: unknown = Reflect.get(globalThis, INCOMPLETE_LIST_HOOK);
    if (typeof noted === "function") noted(this);
  }
}

function describe(value: unknown): string {
  if (value === undefined) return "nothing";
  if (value === null) return "null";
  if (typeof value !== "object") return `a ${typeof value}`;
  if (Array.isArray(value)) return "an array";
  const keys = Object.keys(value);
  if (keys.length === 0) return "an empty object";
  const shown = keys.slice(0, 8).join(", ");
  return `an object with ${shown}${keys.length > 8 ? ", ..." : ""}`;
}

export interface ListPageProblem extends ListPlace {
  /** The field that should have held the list; `null` when the answer is the list. */
  key: string | null;
  /** What was there instead. Only its type and field names reach the message. */
  found: unknown;
  /** The whole answer, which says more than a missing field does. */
  page?: unknown;
  /**
   * For a page whose list is fine, but which says there is more with nothing to ask
   * for it by: it has no rows, or no cursor.
   */
  saysMoreWith?: "no rows" | "no cursor";
}

function whatWasThere({ key, found, page }: ListPageProblem): string {
  if (key === null) return `it was ${describe(found)}`;
  if (found !== undefined) return `its "${key}" was ${describe(found)}`;
  if (page === undefined || page === null) return "it was empty";
  return `it has no "${key}", only ${describe(page)}`;
}

function pageProblem(problem: ListPageProblem): string {
  return problem.saysMoreWith
    ? `a page that says there is more, with ${problem.saysMoreWith} to read it by`
    : `a page that is not a list: ${whatWasThere(problem)}`;
}

/**
 * A 2xx page that cannot be read as part of a list: one whose list is not an array (a
 * wrapped error, a renamed key, an empty body), or one that says there is more and
 * gives no way to get it.
 */
export class ListPageError extends IncompleteListError {
  readonly _tag = "ListPageError";
  readonly key: string | null;

  constructor(problem: ListPageProblem) {
    super(
      problem,
      `${problem.vendor} answered ${problem.path} with ${pageProblem(problem)}. Refusing to read that as the end of the list.`,
    );
    this.name = "ListPageError";
    this.key = problem.key;
  }
}

/**
 * The page's list, or a {@link ListPageError}, for a hand-written loop:
 *
 *   const rows = requireListPage(body.items, { vendor: "Okta", path, key: "items" });
 */
export function requireListPage<T>(
  list: readonly T[] | null | undefined,
  where: Omit<ListPageProblem, "found" | "saysMoreWith">,
): T[] {
  // A named key set to null is how Go serialises a nil slice. A whole answer of null
  // can't be told from no answer, so it needs `emptyBodyEndsList` or a check of its own.
  if (list === null && where.key !== null) return [];
  if (!Array.isArray(list)) throw new ListPageError({ ...where, found: list });
  return list;
}

export interface ListTruncation extends ListPlace {
  /** How many rows had been read when it stopped. */
  items: number;
  /** The page cap it reached, for a loop that counts pages. */
  maxPages?: number;
  /** The row cap it reached, for a loop that counts rows or a list cut with `slice`. */
  maxItems?: number;
}

function capReached({ items, maxPages, maxItems }: ListTruncation): string {
  const read = `${items} ${items === 1 ? "item" : "items"}`;
  if (maxPages !== undefined) return `${maxPages} ${maxPages === 1 ? "page" : "pages"} (${read})`;
  return maxItems !== undefined ? `${maxItems} items` : read;
}

/**
 * A list with more to read than its cap allows. What the sync's prune needs instead
 * of part of a list; a read where part is fine asks for `partial: true`.
 *
 *   for (let page = 0; page < MAX_PAGES; page++) {
 *     ...
 *     if (!next) return out;
 *   }
 *   throw new ListTruncatedError({ vendor: "Okta", path, items: out.length, maxPages: MAX_PAGES });
 */
export class ListTruncatedError extends IncompleteListError {
  readonly _tag = "ListTruncatedError";
  readonly items: number;
  readonly maxPages: number | undefined;
  readonly maxItems: number | undefined;

  constructor(truncation: ListTruncation) {
    super(
      truncation,
      `${truncation.vendor}: ${truncation.path} has more than Infrawrench reads. It stopped at ${capReached(truncation)}, and a partial list would read the rest as deleted, so this one was not used.`,
    );
    this.name = "ListTruncatedError";
    this.items = truncation.items;
    this.maxPages = truncation.maxPages;
    this.maxItems = truncation.maxItems;
  }
}

/**
 * `items` if it fits under `maxItems`, for a cap that is a `slice` of what a list
 * fans out over. Throws rather than quietly drop the children of whatever is past it.
 */
export function withinListCap<T>(items: T[], maxItems: number, place: ListPlace): T[] {
  if (items.length > maxItems) {
    throw new ListTruncatedError({ ...place, items: items.length, maxItems });
  }
  return items;
}

/**
 * What to do about a next link to another origin, which would carry the credentials
 * there. `"refuse"` is the default; a function allows the hosts a provider really
 * hands out, as {@link linkHostsUnder} does; `"follow"` allows anything, and is only
 * for keeping an old client's behaviour while it waits to be moved.
 */
export type ForeignLinks = "follow" | "refuse" | ((link: URL) => boolean);

/** Whether a link, absolute or relative to the page it came from, stays on that page's origin. */
export function isSameOrigin(link: string, pageUrl: string): boolean {
  try {
    return new URL(link, pageUrl).origin === new URL(pageUrl).origin;
  } catch {
    return false;
  }
}

/**
 * For a provider whose next links name a regional host: `foreignLinks:
 * linkHostsUnder("sentry.io")` allows that host and its subdomains, over HTTPS only.
 */
export function linkHostsUnder(...domains: string[]): (link: URL) => boolean {
  return ({ protocol, hostname }) =>
    protocol === "https:" &&
    domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

function originOf(link: string): string {
  try {
    return new URL(link).origin;
  } catch {
    return "something that is not a URL";
  }
}

/** A next link that would have carried the credentials off the host they are for. */
export class ForeignLinkError extends IncompleteListError {
  readonly _tag = "ForeignLinkError";

  constructor(place: ListPlace, link: string, origin: string) {
    super(
      place,
      `${place.vendor}: the next page of ${place.path} is on ${originOf(link)}, not ${origin}. Refusing to send the account's credentials there.`,
    );
    this.name = "ForeignLinkError";
  }
}

/** Whether `link`, which must be absolute, may be followed from a list that started on `origin`. */
export function isFollowable(link: string, origin: string, foreignLinks: ForeignLinks): boolean {
  if (foreignLinks === "follow") return true;
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return false;
  }
  if (url.origin === origin) return true;
  return typeof foreignLinks === "function" && foreignLinks(url);
}

export interface FollowLinkOptions extends ListPlace {
  /** `"refuse"` by default. See {@link ForeignLinks}. */
  foreignLinks?: ForeignLinks;
}

/**
 * The URL to ask for next, for a hand-written loop: `link` resolved against the page
 * it came from as a browser would, or a {@link ForeignLinkError} rather than send the
 * token anywhere else.
 *
 *   const url = followableLink(next, pageUrl, { vendor: "Okta", path });
 */
export function followableLink(link: string, pageUrl: string, options: FollowLinkOptions): string {
  const origin = new URL(pageUrl).origin;
  let resolved: string;
  try {
    resolved = new URL(link, pageUrl).href;
  } catch {
    throw new ForeignLinkError(options, link, origin);
  }
  if (!isFollowable(resolved, origin, options.foreignLinks ?? "refuse")) {
    throw new ForeignLinkError(options, resolved, origin);
  }
  return resolved;
}

/**
 * A stored secret whose row is there and could not be read: the key has rotated, its
 * AAD does not match, or the store itself failed. `getPlaintext` rejects with this,
 * because a plugin deciding what to list from a secret reads "no secret" as "nothing
 * here", and a sync then prunes what it stopped seeing. It is an incomplete list for
 * the same reason, so a catch around a list read passes it on and a swallowed one still
 * fails the read. `cause` holds what went wrong; only the field's name reaches the
 * message, which is shown to people.
 */
export class SecretReadError extends IncompleteListError {
  readonly _tag = "SecretReadError";

  constructor(fieldKey: string, cause?: unknown) {
    super(
      { vendor: "Infrawrench", path: `secret "${fieldKey}"` },
      `Infrawrench could not read its stored secret "${fieldKey}". Refusing to read that as no secret. Setting the secret again replaces it.`,
    );
    this.name = "SecretReadError";
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * What a list that cannot be read whole left unread, so a sync does not read those
 * rows as deleted. A row stays if it matches either: its parent, or its parent's parent
 * and so on, is named here, or its id starts with one of the prefixes. Anything else of
 * the type a sync still prunes.
 */
export interface UnreadListPart {
  /** For a list that reads children for only some parents. */
  parentResourceIds?: readonly string[];
  /** For a list with no parents to name, whose rows a whole id prefix cannot vouch for. */
  idPrefixes?: readonly string[];
}

const UNREAD_LIST_PART_HOOK = Symbol.for("infrawrench.unreadListPart");

/**
 * Called from inside `listResources`, for a list no request budget can read whole: a
 * fan-out over more parents than the provider's rate limit allows, or a type whose
 * only source is a rolling window. Not for a list that could be read and was cut short,
 * which throws. A row it leaves goes stale rather than being deleted, so name only what
 * really was not read. What is deleted upstream under a named parent stays until a read
 * reaches it; a parent that is gone upstream is no longer named, and its children go.
 *
 *   reportUnreadListPart({ parentResourceIds: pastTheCap.map((p) => `${accountId}:project:${p.id}`) });
 *
 * A global because the plugin's copy of this package is not the host's, as for
 * {@link IncompleteListError}. Where a host keeps no track, as on the desktop, whose lists
 * prune nothing, it does nothing and answers false, so a refusal can still be shown there.
 * It also answers false outside a sync (a cost, seat or findings read, which then fails,
 * or a workflow's own call), so a rotating budget should read everything when it does:
 *
 *   if (!reportUnreadListPart({ idPrefixes: [""] })) throw err;
 *   return [];
 */
export function reportUnreadListPart(part: UnreadListPart): boolean {
  const note: unknown = Reflect.get(globalThis, UNREAD_LIST_PART_HOOK);
  if (typeof note !== "function") return false;
  // A host answers false when nobody keeps the rows; anything else means taken.
  return note(part) !== false;
}

/** True for any {@link IncompleteListError}, or anything wrapping one as its `cause`. */
export function isIncompleteListError(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 8; depth++) {
    if (typeof current !== "object" || current === null) return false;
    if ("incompleteList" in current && current.incompleteList === true) return true;
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

/**
 * For a `catch` around a list read, which otherwise reads an incomplete list as an
 * empty one, and an empty list prunes everything the last sync saw:
 *
 *   .catch((err) => { rethrowIncompleteList(err); return []; })
 */
export function rethrowIncompleteList(err: unknown): void {
  if (isIncompleteListError(err)) throw err;
}
