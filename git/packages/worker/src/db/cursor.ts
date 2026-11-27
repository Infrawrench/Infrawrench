/**
 * The API's opaque page cursors. A list is ordered by a timestamp (or a
 * count) and then by id, and its cursor is the last row's pair, so the next
 * page starts strictly after it however many rows were inserted meanwhile.
 */
import { type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

export const DEFAULT_PAGE_SIZE = 30;
export const MAX_PAGE_SIZE = 100;

export const pageSize = (limit: number | undefined): number =>
  Math.min(Math.max(1, Math.floor(limit ?? DEFAULT_PAGE_SIZE)), MAX_PAGE_SIZE);

export interface TimeCursor {
  /** Milliseconds since the epoch of the last row's sort timestamp. */
  readonly at: number;
  readonly id: string;
}

const toBase64Url = (text: string): string =>
  btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const fromBase64Url = (text: string): string | null => {
  try {
    return atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return null;
  }
};

export const encodeCursor = (cursor: TimeCursor): string =>
  toBase64Url(JSON.stringify([cursor.at, cursor.id]));

/** Null for a cursor we did not write; the list then starts from the top. */
export const decodeCursor = (cursor: string | undefined): TimeCursor | null => {
  if (!cursor) return null;
  const text = fromBase64Url(cursor);
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (!Array.isArray(value) || value.length !== 2) return null;
    const [at, id] = value as [unknown, unknown];
    return typeof at === "number" && Number.isFinite(at) && typeof id === "string"
      ? { at, id }
      : null;
  } catch {
    return null;
  }
};

/**
 * A timestamp column as a cursor compares it: to the millisecond. Postgres
 * keeps microseconds and a cursor made in JavaScript keeps milliseconds, so
 * comparing the raw column would skip the rows that share the last row's
 * millisecond. A list paged by {@link afterCursor} must be ordered by this
 * and then by id, never by the raw column.
 */
export const cursorTime = (time: AnyPgColumn): SQL<Date> =>
  sql<Date>`date_trunc('milliseconds', ${time})`;

/** The `WHERE` that continues a list ordered by `(cursorTime(time), id)` after `cursor`. */
export const afterCursor = (
  time: AnyPgColumn,
  id: AnyPgColumn,
  cursor: TimeCursor | null,
  direction: "asc" | "desc",
): SQL | undefined => {
  if (!cursor) return undefined;
  // Bound as text: a `Date` inside a raw fragment has no column to say how it is sent.
  const at = sql`${new Date(cursor.at).toISOString()}::timestamptz at time zone 'UTC'`;
  return direction === "desc"
    ? sql`(${cursorTime(time)}, ${id}) < (${at}, ${cursor.id})`
    : sql`(${cursorTime(time)}, ${id}) > (${at}, ${cursor.id})`;
};

export interface PageOf<T> {
  readonly items: T[];
  readonly nextCursor: string | null;
}

/**
 * Turn `limit + 1` fetched rows into a page: the extra row only says there
 * is more, and the cursor is the last row actually returned.
 */
export const toPage = <T>(
  rows: readonly T[],
  limit: number,
  cursorOf: (row: T) => TimeCursor,
): PageOf<T> => {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: rows.length > limit && last !== undefined ? encodeCursor(cursorOf(last)) : null,
  };
};
