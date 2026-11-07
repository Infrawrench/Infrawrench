/**
 * What a list read throws when it cannot say it has every row. A resource sync
 * soft-deletes whatever a list stops returning, so anything short of "this is all
 * of it" has to be an error, and so does anything that hides one.
 *
 * Plugins are bundled with their own copy of this package, so the host cannot use
 * `instanceof`: {@link isIncompleteListError} reads a marker instead.
 */

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
}

function whatWasThere({ key, found, page }: ListPageProblem): string {
  if (key === null) return `it was ${describe(found)}`;
  if (found !== undefined) return `its "${key}" was ${describe(found)}`;
  if (page === undefined || page === null) return "it was empty";
  return `it has no "${key}", only ${describe(page)}`;
}

/** A 2xx page whose list is not an array: a wrapped error, a renamed key, an empty body. */
export class ListPageError extends IncompleteListError {
  readonly _tag = "ListPageError";
  readonly key: string | null;

  constructor(problem: ListPageProblem) {
    super(
      problem,
      `${problem.vendor} answered ${problem.path} with a page that is not a list: ${whatWasThere(problem)}. Refusing to read that as the end of the list.`,
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
  where: Omit<ListPageProblem, "found">,
): T[] {
  if (!Array.isArray(list)) throw new ListPageError({ ...where, found: list });
  return list;
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
