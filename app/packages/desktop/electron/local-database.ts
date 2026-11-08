/**
 * The renderer's generic SQLite access (`LocalDbSelect` / `LocalDbExecute`),
 * as an Effect service over the shared sql.js handle in `./db`.
 *
 * Every statement passes `db-guard` first: `validateSql` (no multi-statements,
 * no ATTACH/DETACH/PRAGMA/VACUUM/LOAD_EXTENSION, capped size) and
 * `validateParams` (capped count, primitives only), and a mutation of a
 * credential-bearing table is written to the audit log. A compromised
 * renderer can still change any user-owned table: the surface is narrowed,
 * not eliminated.
 */
import { Context, Effect, Layer, Predicate } from "effect";
import type { SqlValue } from "sql.js";
import { errorMessage } from "../shared/rpc/errors";
import { LocalDatabaseError, type DbExecuteResult } from "../shared/rpc/groups/local-database";
import { classifyMutation, validateParams, validateSql } from "./db-guard";
import { getSqlite, normalizeSql, persist } from "./db";

/**
 * The guard's checked parameters as sql.js binds them. sql.js binds a
 * boolean as 0/1 itself; spelling that out is what lets the values be typed
 * without a cast. Anything else the guard would already have refused.
 */
function toSqlValues(params: readonly unknown[]): SqlValue[] {
  return params.map((value, i) => {
    if (Predicate.isBoolean(value)) return value ? 1 : 0;
    if (
      Predicate.isString(value) ||
      Predicate.isNumber(value) ||
      Predicate.isNull(value) ||
      Predicate.isUint8Array(value)
    ) {
      return value;
    }
    throw new Error(`db guard: params[${i}] has unsupported type`);
  });
}

/** Guard a statement and its parameters; throws the guard's sentence. */
function guarded(sql: string, params: readonly unknown[]): SqlValue[] {
  validateSql(sql);
  return toSqlValues(validateParams([...params]));
}

async function selectRows(
  sql: string,
  params: readonly unknown[],
): Promise<Record<string, unknown>[]> {
  const values = guarded(sql, params);
  const db = await getSqlite();
  const stmt = db.prepare(normalizeSql(sql));
  const rows: Record<string, unknown>[] = [];
  try {
    stmt.bind(values);
    while (stmt.step()) rows.push(stmt.getAsObject());
  } finally {
    stmt.free();
  }
  return rows;
}

async function executeStatement(sql: string, params: readonly unknown[]): Promise<DbExecuteResult> {
  const values = guarded(sql, params);
  const audit = classifyMutation(sql);
  if (audit) {
    const preview = sql.length > 200 ? `${sql.slice(0, 200)}…` : sql;
    console.log(`[db-audit] ${audit.op} on ${audit.table} (params=${values.length}) :: ${preview}`);
  }
  const db = await getSqlite();
  db.run(normalizeSql(sql), values);
  const rowsAffected = db.getRowsModified();
  persist();
  return { rowsAffected, lastInsertId: 0 };
}

const toDatabaseError = (cause: unknown) =>
  new LocalDatabaseError({ message: errorMessage(cause) });

export class LocalDatabase extends Context.Service<
  LocalDatabase,
  {
    readonly select: (
      sql: string,
      params: readonly unknown[],
    ) => Effect.Effect<Record<string, unknown>[], LocalDatabaseError>;
    readonly execute: (
      sql: string,
      params: readonly unknown[],
    ) => Effect.Effect<DbExecuteResult, LocalDatabaseError>;
  }
>()("infrawrench/desktop/LocalDatabase") {
  static readonly layer = Layer.succeed(LocalDatabase)(
    LocalDatabase.of({
      select: (sql, params) =>
        Effect.tryPromise({ try: () => selectRows(sql, params), catch: toDatabaseError }),
      execute: (sql, params) =>
        Effect.tryPromise({ try: () => executeStatement(sql, params), catch: toDatabaseError }),
    }),
  );
}
