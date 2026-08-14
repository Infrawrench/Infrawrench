/**
 * A Postgres double that is a *real* Drizzle database over a recording driver
 * — the Postgres counterpart of `fake-clickhouse.ts`, built on Drizzle's
 * pg-proxy driver so every chain renders through the real dialect against the
 * real `db/schema.ts` tables. The hand-rolled chainable stubs this replaces
 * assert the test's idea of the query builder; this asserts the SQL and
 * parameters Postgres would receive.
 *
 * Migrating a suite from a hand stub: mock the module with the fake's `db`
 * (`vi.mock("../db/client", () => ({ db: pg.db }))`), drop any `db/schema`
 * mocks (the real schema is the point), and feed results with
 * {@link FakePostgres.setRows} / {@link FakePostgres.queueRows}. As in the
 * ClickHouse fake, row objects must list their keys in projection order.
 * Note the pg-proxy driver does not support `db.transaction` — suites built
 * around transactions keep their stubs for now.
 *
 * ## Shadow mode (`INFRAWRENCH_SHADOW_POSTGRES=1`)
 *
 * Every captured statement is also `PREPARE`d against the real DATABASE_URL
 * server and deallocated — never executed, so nothing is written and fixture
 * params can reference rows that don't exist. That validates syntax, tables,
 * columns and parameter types against the migrated schema, which is exactly
 * what a chainable stub can never do. Run via `pnpm test:postgres:shadow`
 * (vitest.shadow-postgres.config.ts). A `42P18` ("could not determine data
 * type of parameter") is treated as a pass: it is PREPARE's inference limit,
 * not a defect of the query.
 */
import { drizzle } from "drizzle-orm/pg-proxy";
import postgres from "postgres";
import * as schema from "../../db/schema";

let shadow: postgres.Sql | null = null;
let prepareSeq = 0;

function shadowConnection(): postgres.Sql | null {
  if (process.env["INFRAWRENCH_SHADOW_POSTGRES"] !== "1") return null;
  if (shadow) return shadow;
  const url = process.env["DATABASE_URL"];
  if (!url) {
    throw new Error(
      "INFRAWRENCH_SHADOW_POSTGRES=1 needs DATABASE_URL pointed at a migrated scratch database.",
    );
  }
  // idle_timeout so the connection closes itself and the worker exits cleanly.
  shadow = postgres(url, { max: 1, idle_timeout: 1, onnotice: () => {} });
  return shadow;
}

async function shadowValidate(statement: string): Promise<void> {
  const sql = shadowConnection();
  if (!sql) return;
  const name = `__iw_shadow_${++prepareSeq}`;
  try {
    await sql.unsafe(`PREPARE ${name} AS ${statement}`);
    await sql.unsafe(`DEALLOCATE ${name}`);
  } catch (err) {
    if ((err as { code?: string }).code === "42P18") return;
    throw new Error(
      `shadow Postgres rejected the statement:\n${statement}\n↳ ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

export interface CapturedPostgresQuery {
  sql: string;
  params: unknown[];
  /** "all" for reads Drizzle maps through the projection, "execute" otherwise. */
  method: string;
}

export interface FakePostgres {
  /** The Drizzle handle to hand back from a mocked `db/client`. */
  db: ReturnType<typeof drizzle<typeof schema>>;
  /** Every statement issued, newest last. */
  queries: CapturedPostgresQuery[];
  /** The statement most recently issued. Throws if there was none. */
  lastQuery(): CapturedPostgresQuery;
  /** The default rows every query returns (values read in key order). */
  setRows(rows: Array<Record<string, unknown>>): void;
  /** Queue one query's rows, consumed FIFO before the default takes over. */
  queueRows(rows: Array<Record<string, unknown>>): void;
  reset(): void;
}

export function fakePostgres(): FakePostgres {
  const queries: CapturedPostgresQuery[] = [];
  const queue: Array<Array<Record<string, unknown>>> = [];
  let defaults: Array<Record<string, unknown>> = [];

  const db = drizzle(
    async (sql, params, method) => {
      queries.push({ sql, params, method });
      await shadowValidate(sql);
      const rows = queue.length > 0 ? queue.shift()! : defaults;
      // "all" decodes positionally through the projection, like the real
      // driver's raw mode; anything else is handed back as-is.
      return { rows: method === "all" ? rows.map((row) => Object.values(row)) : rows };
    },
    { schema },
  );

  return {
    db,
    queries,
    lastQuery() {
      const last = queries.at(-1);
      if (last === undefined) throw new Error("no query was issued");
      return last;
    },
    setRows(rows) {
      defaults = rows;
    },
    queueRows(rows) {
      queue.push(rows);
    },
    reset() {
      queries.length = 0;
      queue.length = 0;
      defaults = [];
    },
  };
}
