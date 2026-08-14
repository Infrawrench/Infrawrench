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
 *
 * ## Shadow mode (`INFRAWRENCH_SHADOW_CLICKHOUSE=1`)
 *
 * The one thing the fake cannot know is whether a real server would accept
 * the statement. In shadow mode every captured statement and insert is *also*
 * executed against the server named by CLICKHOUSE_METRICS_* — results are
 * discarded (the canned rows still drive the assertions), but a rejection
 * fails the test with the server's parse error. Run via
 * `pnpm test:clickhouse:shadow` (vitest.shadow-clickhouse.config.ts), which collects
 * every suite using this helper, migrates the schema first, and only ever
 * against a scratch server: shadow inserts really write the fixture rows.
 *
 * The shadow client is built directly from `@clickhouse/client`, not from
 * `../../clickhouse/client` — the suites using this helper vi.mock that
 * module, and importing it here would hand shadow mode its own fake.
 */
import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { drizzle } from "drizzle-orm/clickhouse";
import * as schema from "../../clickhouse/schema";

let shadow: ClickHouseClient | null = null;

function shadowClient(): ClickHouseClient | null {
  if (process.env["INFRAWRENCH_SHADOW_CLICKHOUSE"] !== "1") return null;
  if (shadow) return shadow;
  const url = process.env["CLICKHOUSE_METRICS_URL"];
  const username = process.env["CLICKHOUSE_METRICS_USER"];
  const password = process.env["CLICKHOUSE_METRICS_PASSWORD"];
  const database = process.env["CLICKHOUSE_METRICS_DATABASE"];
  if (!url || !username || password === undefined || !database) {
    throw new Error(
      "INFRAWRENCH_SHADOW_CLICKHOUSE=1 needs CLICKHOUSE_METRICS_URL, " +
        "CLICKHOUSE_METRICS_USER, CLICKHOUSE_METRICS_PASSWORD and " +
        "CLICKHOUSE_METRICS_DATABASE pointed at a scratch server.",
    );
  }
  shadow = createClient({
    url,
    username,
    password,
    database,
    // Synchronous inserts (no async_insert) so a rejected body fails the
    // issuing test, and no keep-alive so workers exit cleanly.
    keep_alive: { enabled: false },
    clickhouse_settings: { date_time_input_format: "best_effort" },
  });
  return shadow;
}

async function shadowExecute(run: () => Promise<unknown>, statement: string): Promise<void> {
  try {
    await run();
  } catch (err) {
    throw new Error(
      `shadow ClickHouse rejected the statement:\n${statement}\n↳ ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

async function drainRows(values: unknown): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = [];
  for await (const row of values as AsyncIterable<Record<string, unknown>>) rows.push(row);
  return rows;
}

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
    async query({ query, format }) {
      queries.push(query);
      const real = shadowClient();
      if (real) {
        await shadowExecute(async () => {
          const rs = await real.query({ query, format: (format ?? "JSON") as never });
          await rs.text();
        }, query);
      }
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
      const real = shadowClient();
      if (real) await shadowExecute(() => real.command({ query }), query);
      return { query_id: "fake" };
    },
    async insert(opts) {
      const real = shadowClient();
      if (real) {
        // Materialize the dialect's row stream so it can be both written to
        // the server and replayed by insertedRows(); arrays are for-await-able,
        // so the capture below stays drainable either way.
        const values = await drainRows(opts.values);
        await shadowExecute(
          () =>
            real.insert({
              table: opts.table,
              values,
              format: (opts.format ?? "JSONEachRow") as never,
            }),
          `INSERT INTO ${opts.table} (${values.length} rows, ${opts.format ?? "JSONEachRow"})`,
        );
        inserts.push({ ...opts, values });
        return;
      }
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
