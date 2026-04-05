import { invoke } from "../lib/invoke";

export interface DbClient {
  select<T>(sql: string, params?: unknown[]): Promise<T>;
  execute(sql: string, params?: unknown[]): Promise<{ rowsAffected: number; lastInsertId: number }>;
}

const db: DbClient = {
  select: <T>(sql: string, params?: unknown[]) =>
    invoke<T>("db_select", { sql, params: params ?? [] }),
  execute: (sql: string, params?: unknown[]) =>
    invoke<{ rowsAffected: number; lastInsertId: number }>("db_execute", { sql, params: params ?? [] }),
};

export async function getDb(): Promise<DbClient> {
  return db;
}
