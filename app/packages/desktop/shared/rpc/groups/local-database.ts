/**
 * The renderer's generic access to the local SQLite database: one read and
 * one write, each a single SQL string the renderer bundle wrote, with its
 * bound parameters.
 *
 * The payload is deliberately loose (any JSON values as parameters): the
 * main process's `db-guard` is the boundary, not this schema, so every
 * statement and parameter reaches `validateSql`/`validateParams` and is
 * refused there with the guard's own sentence. A byte parameter cannot be
 * carried (JSON has no bytes); no table has a BLOB column.
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

const DbStatement = {
  sql: Schema.String,
  params: Schema.Array(Schema.Unknown),
};

/** One row, keyed by column name, as sql.js's `getAsObject` returns it. */
export const DbRow = Schema.Record(Schema.String, Schema.Unknown);

export const DbExecuteResult = Schema.Struct({
  rowsAffected: Schema.Int,
  /** Always 0: sql.js does not report it, and no caller reads it. */
  lastInsertId: Schema.Int,
});
export type DbExecuteResult = typeof DbExecuteResult.Type;

/**
 * A statement the guard refused (`db guard: ...`), or the database's own
 * error (a constraint, a syntax error), as the sentence it threw.
 */
export class LocalDatabaseError extends Schema.TaggedError<LocalDatabaseError>()(
  "LocalDatabaseError",
  { message: Schema.String },
) {}

export class LocalDatabaseRpcs extends RpcGroup.make(
  Rpc.make("LocalDbSelect", {
    payload: DbStatement,
    success: Schema.Array(DbRow),
    error: LocalDatabaseError,
  }),
  Rpc.make("LocalDbExecute", {
    payload: DbStatement,
    success: DbExecuteResult,
    error: LocalDatabaseError,
  }),
) {}
