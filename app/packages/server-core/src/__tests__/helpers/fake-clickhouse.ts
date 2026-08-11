/**
 * A ClickHouse double that is a *real* Drizzle database over a fake driver.
 *
 * The point is that the SQL under test is the SQL that would be sent: the
 * dialect, the literal escaping, `FINAL`, the subqueries and the projection
 * order are all exercised, and only the socket is replaced. A hand-written stub
 * of `db.select()` would assert that the test's idea of the query builder is
 * self-consistent, which is not a fact about this codebase.
 *
 * ## Rows go in as objects, in projection order
 *
 * Drizzle asks ClickHouse for `JSONCompact` whenever it knows the projection —
 * each row arrives as an array of values positionally matched to the selected
 * fields. {@link FakeClickHouse.setRows} takes the row objects a test finds
 * readable and converts them with `Object.values`, so **the keys have to be
 * written in the same order the query selects them**. Get that wrong and the
 * values land in the wrong columns, which is exactly what would happen against
 * a real server if the projection and the decoder disagreed.
 */
import { drizzle } from "drizzle-orm/clickhouse";
import * as schema from "../../clickhouse/schema";

export interface FakeClickHouse {
  /** The Drizzle handle to hand back from a mocked `getClickHouseDb`. */
  db: ReturnType<typeof drizzle<typeof schema>>;
  /** The driver double, for the writers and the streaming export reader. */
  client: {
    query: (opts: { query: string; format?: string }) => Promise<unknown>;
    command: (opts: { query: string }) => Promise<{ query_id: string }>;
    insert: (opts: { table: string; values: unknown; format?: string }) => Promise<void>;
    close: () => Promise<void>;
  };
  /** Every statement issued, newest last. */
  queries: string[];
  /** Every `insert()` the writers made. */
  inserts: Array<{ table: string; values: unknown; format?: string }>;
  /**
   * The rows of one insert, drained from its stream.
   *
   * The dialect hands the driver a `Readable` in object mode so a batch never
   * materialises, which means the rows only exist once something pulls them —
   * consuming it here is what a real driver does while writing the body.
   */
  insertedRows(index?: number): Promise<Array<Record<string, unknown>>>;
  /** The statement most recently issued. Throws if there was none. */
  lastQuery(): string;
  /** Queue the rows the next queries return. */
  setRows(rows: Array<Record<string, unknown>>): void;
  reset(): void;
}

export function fakeClickHouse(): FakeClickHouse {
  const queries: string[] = [];
  const inserts: FakeClickHouse["inserts"] = [];
  let rows: unknown[][] = [];

  const client: FakeClickHouse["client"] = {
    async query({ query }) {
      queries.push(query);
      const data = rows;
      return {
        query_id: "fake",
        json: async () => ({ data }),
        // `cost-exports/rows.ts` streams; one chunk is enough to exercise it.
        stream: () => [data.map((row) => ({ json: () => row }))],
        close: async () => {},
      };
    },
    async command({ query }) {
      queries.push(query);
      return { query_id: "fake" };
    },
    async insert(opts) {
      inserts.push(opts);
    },
    async close() {},
  };

  return {
    db: drizzle(client as never, { schema }),
    client,
    queries,
    inserts,
    async insertedRows(index = 0) {
      const call = inserts[index];
      if (call === undefined) throw new Error(`no insert at index ${index}`);
      const rows: Array<Record<string, unknown>> = [];
      for await (const row of call.values as AsyncIterable<Record<string, unknown>>) {
        rows.push(row);
      }
      return rows;
    },
    lastQuery() {
      const last = queries.at(-1);
      if (last === undefined) throw new Error("no query was issued");
      return last;
    },
    setRows(next) {
      rows = next.map((row) => Object.values(row));
    },
    reset() {
      queries.length = 0;
      inserts.length = 0;
      rows = [];
    },
  };
}
