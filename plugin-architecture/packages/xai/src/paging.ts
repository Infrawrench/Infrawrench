import { ListTruncatedError, requireListPage } from "@infrawrench/plugin-base";

/** A walk's cap: a picker may stop there with what it has, a sync's read may not. */
export interface PageCap {
  maxPages: number;
  partial?: boolean;
}

interface TokenPage<T> {
  rows: readonly T[];
  next: string | null | undefined;
  /** For a route that says so itself, rather than by leaving out the cursor. */
  hasMore?: boolean;
}

interface TokenWalk<T> extends PageCap {
  vendor: string;
  path: string;
  pageSize: number;
  read: (token: string | undefined) => Promise<TokenPage<T>>;
}

/**
 * Every row of a list paged by an opaque token. The cursor is the end-of-list signal, so
 * an empty or short page with a new cursor goes on. A cursor that does not advance ends
 * the list only on a short page, which is how xAI's files guide says a list ends; on a
 * full page, or where the route says `has_more`, it means rows are left behind.
 */
export async function readTokenPages<T>(walk: TokenWalk<T>): Promise<T[]> {
  const { vendor, path, pageSize, maxPages, partial, read } = walk;
  const out: T[] = [];
  let token: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const { rows, next, hasMore } = await read(token);
    out.push(...rows);
    if (hasMore === false || (hasMore === undefined && !next)) return out;
    if (next && next !== token) {
      token = next;
      continue;
    }
    if (hasMore === undefined && rows.length < pageSize) return out;
    break;
  }
  if (partial) return out;
  throw new ListTruncatedError({ vendor, path, items: out.length, maxPages });
}

/**
 * A list on the management host. Its answers are protobuf JSON and its reference marks
 * none of these keys required, so an empty list can arrive as `{}`. Any other answer
 * without the key is a renamed key or a wrapped error, which must not read as empty.
 * `alongside` names the keys that may stand beside a list that was left out.
 */
export function managementList<T, K extends string>(
  body: { readonly [P in K]?: readonly T[] | null | undefined },
  key: K,
  path: string,
  alongside: readonly string[] = [],
): T[] {
  const list: readonly T[] | null | undefined = body?.[key];
  if (list === undefined && body && Object.keys(body).every((k) => alongside.includes(k))) {
    return [];
  }
  return requireListPage(list, { vendor: "xAI Management", path, key });
}
