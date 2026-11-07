/**
 * Reading a whole SHOW list past the 10,000 records SHOW answers with at once.
 *
 * Verified against the SHOW DATABASES, SHOW SCHEMAS, SHOW TASKS, SHOW DYNAMIC
 * TABLES, SHOW USERS and SHOW ROLES references (docs.snowflake.com, 2026-11):
 *
 * - Without LIMIT, SHOW DATABASES, SCHEMAS, TASKS and DYNAMIC TABLES fail when the
 *   answer is longer than ten thousand rows, so an answer that arrives is whole.
 * - `LIMIT <rows> [ FROM '<name>' ]` pages, with LIMIT at most 10,000 and FROM a
 *   case-sensitive cursor on the object's name. "The actual number of rows returned
 *   might be less than the specified limit", so a short page does not end a list.
 * - Rows come "in lexicographic order by name", but a list across databases or
 *   schemas is ordered by database and schema first, and FROM still matches only on
 *   the name. So a cursor only pages a scope whose rows are ordered by name alone:
 *   the account for account objects, a database for schemas, a schema for the
 *   objects in it. A wider scope that is too long is read one scope down instead.
 * - Whether FROM starts at the named row or after it is not documented. Each page
 *   is asked to start from the second-to-last row read, so it must hold the last row
 *   read in its first or second place either way, which proves it carries straight on
 *   from where the list stopped. A page that does not throws instead of guessing.
 *
 * SHOW WAREHOUSES, SHOW PIPES and SHOW RESOURCE MONITORS take no LIMIT and drop what
 * is past 10,000 "even with a filter applied", so a narrower scope cannot prove it is
 * whole either; those still throw at 10,000 (see `SnowflakeClient.rows`).
 */

import {
  IncompleteListError,
  ListTruncatedError,
  reportUnreadListPart,
} from "@infrawrench/plugin-base";
import { SnowflakeError, ident, isPrivilegeDenied, literal, qualified, str } from "./api.js";

/** The most rows one SHOW answers with, and the most LIMIT takes. */
export const SHOW_RECORD_LIMIT = 10_000;
/** The resource sync's ceiling for one list. */
const MAX_LIST_ROWS = 100_000;
/** Pages for one scope; each one carries at least one new row. */
const MAX_PAGES = 1_000;
/**
 * Scope reads a list spends going one scope down, at {@link SCOPE_CONCURRENCY} at a
 * time: about half a minute of a poll at a few hundred milliseconds a statement.
 */
const MAX_SCOPE_READS = 400;
const SCOPE_CONCURRENCY = 4;

type Row = Record<string, unknown>;

/** Runs one SHOW statement and answers with every row it returned. */
export type ShowExec = (statement: string) => Promise<Row[]>;

/**
 * SHOW without LIMIT over ten thousand rows: 090153, "The result set size exceeded
 * the max number of rows(10000) supported for SHOW statements". Anything else is a
 * real failure and is passed on, so a wrong guess here fails the list and keeps its
 * stored rows.
 */
export function isShowOverflow(err: unknown): boolean {
  return (
    err instanceof SnowflakeError &&
    (err.code === "090153" || /max number of rows\s*\(\s*10000\s*\)/i.test(err.message))
  );
}

/** A SHOW page that cannot be placed in the list it was asked to continue. */
export class ShowPagingError extends IncompleteListError {
  readonly _tag = "ShowPagingError";

  constructor(statement: string, problem: string) {
    super(
      { vendor: "Snowflake", path: statement },
      `Snowflake answered ${statement} with ${problem}. Refusing to read that as the whole list.`,
    );
    this.name = "ShowPagingError";
  }
}

const nameOf = (row: Row | undefined) => (row ? str(row["name"]) : undefined);

/**
 * Every row of `statement`, a SHOW whose rows are ordered by name alone, read
 * 10,000 at a time. `atLeast` is how many rows the unpaged answer said there are.
 */
export async function pageShow(exec: ShowExec, statement: string, atLeast = 0): Promise<Row[]> {
  const first = `${statement} LIMIT ${SHOW_RECORD_LIMIT}`;
  const out = await exec(first);
  const seen = new Set<string>();
  const add = (rows: Row[], from: string) => {
    for (const row of rows) {
      const name = str(row["name"]);
      if (seen.has(name)) throw new ShowPagingError(from, `"${name}" a second time`);
      seen.add(name);
    }
  };
  add(out, first);
  for (let page = 1; out.length > 0; page++) {
    if (page >= MAX_PAGES || out.length > MAX_LIST_ROWS) {
      throw new ListTruncatedError({
        vendor: "Snowflake",
        path: statement,
        items: out.length,
        ...(page >= MAX_PAGES ? { maxPages: MAX_PAGES } : { maxItems: MAX_LIST_ROWS }),
      });
    }
    const last = nameOf(out[out.length - 1]);
    const before = out.length >= 2 ? nameOf(out[out.length - 2]) : undefined;
    const next = `${first} FROM ${literal(before ?? last ?? "")}`;
    const rows = await exec(next);
    let carried: number;
    if (rows.length > 0 && nameOf(rows[0]) === last) carried = 1;
    else if (before !== undefined && nameOf(rows[0]) === before && nameOf(rows[1]) === last) {
      carried = 2;
    } else if (before === undefined && rows.length === 0) carried = 0;
    else {
      throw new ShowPagingError(
        next,
        `a page that does not carry on from "${last}", the last row of the page before`,
      );
    }
    const fresh = rows.slice(carried);
    if (fresh.length === 0) break;
    add(fresh, next);
    for (const row of fresh) out.push(row);
  }
  if (out.length < atLeast) {
    throw new ShowPagingError(
      statement,
      `${out.length} rows read page by page, where the whole answer had more than ${atLeast - 1}`,
    );
  }
  return out;
}

/** Where a SHOW looks: the account, one database, or one schema. */
type Scope = readonly [] | readonly [string] | readonly [string, string];

const inClause = (scope: Scope): string => {
  if (scope.length === 0) return " IN ACCOUNT";
  if (scope.length === 1) return ` IN DATABASE ${ident(scope[0])}`;
  return ` IN SCHEMA ${qualified(scope[0], scope[1])}`;
};

export interface ScopedShow {
  /** The SHOW object keyword: `SCHEMAS`, `TASKS`, `DYNAMIC TABLES`. */
  object: string;
  /** How deep a scope has to be for its rows to be ordered by name alone. */
  depth: 1 | 2;
  /**
   * Names a scope this read could not reach, so a sync keeps the rows under it.
   * Answers false where the host keeps no track.
   */
  unread: (scope: readonly string[]) => boolean;
}

/** Spreads the scope reads over the budget, starting somewhere new each minute. */
function rotate(names: string[], budget: number): { now: string[]; later: string[] } {
  if (names.length <= budget) return { now: names, later: [] };
  const sorted = [...names].sort();
  const minute = Math.floor(Date.now() / 60_000);
  const start = Math.floor(((minute * 0.618_033_988_75) % 1) * sorted.length);
  const rotated = [...sorted.slice(start), ...sorted.slice(0, start)];
  return { now: rotated.slice(0, Math.max(budget, 0)), later: rotated.slice(Math.max(budget, 0)) };
}

/**
 * Every row of `SHOW <object> IN ACCOUNT`. One statement while the account has
 * fewer than 10,000; past that, one database at a time, then one schema at a time,
 * and pages within a scope ordered by name.
 */
export async function showAcrossAccount(exec: ShowExec, show: ScopedShow): Promise<Row[]> {
  let reads = 0;
  const counted: ShowExec = (statement) => {
    reads++;
    return exec(statement);
  };

  /** Rows of one scope, or how many it said it holds when it holds too many. */
  const once = async (statement: string): Promise<Row[] | number> => {
    try {
      const rows = await counted(statement);
      return rows.length >= SHOW_RECORD_LIMIT ? rows.length : rows;
    } catch (err) {
      if (isShowOverflow(err)) return SHOW_RECORD_LIMIT + 1;
      throw err;
    }
  };

  const children = async (scope: Scope): Promise<string[]> => {
    if (scope.length === 0) {
      const rows = await whole(counted, "SHOW DATABASES");
      return rows.map((r) => str(r["name"]));
    }
    const rows = await whole(counted, `SHOW SCHEMAS IN DATABASE ${ident(scope[0]!)}`);
    return rows
      .map((r) => str(r["name"]))
      .filter((name) => name.toUpperCase() !== "INFORMATION_SCHEMA");
  };

  const read = async (scope: Scope): Promise<Row[]> => {
    const statement = `SHOW ${show.object}${inClause(scope)}`;
    const answer = await once(statement);
    if (Array.isArray(answer)) return answer;
    if (scope.length === show.depth) return pageShow(counted, statement, answer);
    const names = await children(scope);
    const { now, later } = rotate(names, MAX_SCOPE_READS - reads);
    // A host that keeps no track answers false, and has no poll to outlast: it reads them all.
    const kept = later.every((name) => show.unread([...scope, name]));
    let complete = later.length === 0 || !kept;
    const out: Row[] = [];
    const queue = (kept ? now : names).map((name): Scope =>
      scope.length === 0 ? [name] : [scope[0]!, name],
    );
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        try {
          for (const row of await read(next)) out.push(row);
        } catch (err) {
          // Gone since it was listed, or closed to this role: what the sync stored
          // under it stays rather than reading as deleted.
          if (!isPrivilegeDenied(err)) throw err;
          // Where nothing keeps them, the refusal shows rather than a list short of them.
          if (!show.unread(next)) throw err;
          complete = false;
        }
      }
    };
    await Promise.all(Array.from({ length: SCOPE_CONCURRENCY }, worker));
    if (complete && out.length < answer) {
      throw new ShowPagingError(
        statement,
        `${out.length} rows read one scope at a time, where the whole answer had more than ${answer - 1}`,
      );
    }
    if (out.length > MAX_LIST_ROWS) {
      throw new ListTruncatedError({
        vendor: "Snowflake",
        path: statement,
        items: out.length,
        maxItems: MAX_LIST_ROWS,
      });
    }
    return out;
  };

  return read([]);
}

/**
 * Every row of a SHOW that takes LIMIT ... FROM and whose rows are ordered by name
 * alone: DATABASES, USERS and ROLES, or SCHEMAS in one database. One statement under
 * 10,000 rows, pages at or past it. With `deniedIsEmpty`, a role that may not run
 * the first statement has none; a refusal part way through still fails the list.
 */
export async function whole(
  exec: ShowExec,
  statement: string,
  opts: { deniedIsEmpty?: boolean } = {},
): Promise<Row[]> {
  let atLeast: number;
  try {
    const rows = await exec(statement);
    if (rows.length < SHOW_RECORD_LIMIT) return rows;
    atLeast = rows.length;
  } catch (err) {
    if (opts.deniedIsEmpty && isPrivilegeDenied(err)) return [];
    if (!isShowOverflow(err)) throw err;
    atLeast = SHOW_RECORD_LIMIT + 1;
  }
  return pageShow(exec, statement, atLeast);
}

/** For a caller that names unread scopes with a resource id prefix. */
export function unreadUnder(prefix: (scope: readonly string[]) => string) {
  return (scope: readonly string[]) => reportUnreadListPart({ idPrefixes: [prefix(scope)] });
}
