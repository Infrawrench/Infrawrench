/**
 * The renderer's SQLite access: one read and one write, served by the main
 * process (`LocalDbSelect` / `LocalDbExecute`), where `db-guard` checks every
 * statement and parameter before it reaches the database.
 */
import { DesktopRpcClient, runRpc } from "../lib/rpc/client";

export interface DbClient {
  select<T>(sql: string, params?: unknown[]): Promise<T>;
  execute(sql: string, params?: unknown[]): Promise<{ rowsAffected: number; lastInsertId: number }>;
}

/**
 * The rows, typed as the caller says they are: `T` is the caller's claim
 * about its own query's columns, as it always was over IPC. The overload
 * states it without a cast.
 */
function select<T>(sql: string, params?: unknown[]): Promise<T>;
function select(sql: string, params?: unknown[]): Promise<unknown> {
  return runRpc(DesktopRpcClient.use((rpc) => rpc.LocalDbSelect({ sql, params: params ?? [] })));
}

const db: DbClient = {
  select,
  execute: (sql: string, params?: unknown[]) =>
    runRpc(DesktopRpcClient.use((rpc) => rpc.LocalDbExecute({ sql, params: params ?? [] }))),
};

export async function getDb(): Promise<DbClient> {
  return db;
}
