import { drizzle } from "drizzle-orm/postgres-js";
import postgres, { type Options, type PostgresType, type Sql } from "postgres";
import * as schema from "./schema";
import { currentRequestScope } from "../runtime/request-scope";

function wrap(sql: Sql) {
  return drizzle(sql, { schema });
}

/** The Drizzle handle, `$client` (the postgres.js client) included. */
export type Db = ReturnType<typeof wrap>;

/**
 * Build a Drizzle handle over its own postgres.js client. Node calls this once
 * for the process-wide pool; edge entry points call it per invocation against
 * Hyperdrive and hand the result to `runInRequestScope` (see
 * `runtime/request-scope.ts` for why an edge client cannot outlive its
 * invocation). `close` ends the client, letting in-flight queries finish.
 */
export function createDb(
  connectionString: string,
  options: Options<Record<string, PostgresType>> = {},
): { db: Db; close: () => Promise<void> } {
  const sql = postgres(connectionString, options);
  return { db: wrap(sql), close: () => sql.end({ timeout: 5 }) };
}

let processDb: Db | null = null;

function getProcessDb(): Db {
  if (processDb) return processDb;
  const connectionString = process.env["DATABASE_URL"];
  if (!connectionString) {
    throw new Error("DATABASE_URL environment variable is required");
  }
  processDb = createDb(connectionString, { max: 10 }).db;
  return processDb;
}

function resolveDb(): Db {
  return (currentRequestScope()?.db as Db | undefined) ?? getProcessDb();
}

/**
 * The database every module imports. It resolves on each access: to the
 * active request scope's handle on the edge, otherwise to the process pool
 * (created on first use, so importing this module never needs DATABASE_URL).
 * Methods are bound to the resolved handle, so `db.transaction(...)` and
 * friends keep their `this`.
 */
export const db: Db = new Proxy({} as Db, {
  get(_target, prop) {
    const target = resolveDb();
    const value: unknown = Reflect.get(target, prop, target);
    return typeof value === "function"
      ? (value as (...args: unknown[]) => unknown).bind(target)
      : value;
  },
  has(_target, prop) {
    return Reflect.has(resolveDb(), prop);
  },
});
