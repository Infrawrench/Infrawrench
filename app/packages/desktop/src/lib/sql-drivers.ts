import { invoke } from "../lib/invoke";
import type { HostServices } from "@infrawrench/plugin-base";

/**
 * Generic SQL driver — the Rust side detects the dialect from the connection
 * string scheme (postgres:// → PostgreSQL, mysql:// → MySQL).
 */
export function sqlQuery(connectionString: string, sql: string): Promise<Record<string, unknown>[]> {
  return invoke<Record<string, unknown>[]>("sql_query", { connectionString, sql });
}

export function sqlExecute(connectionString: string, sql: string, params: unknown[]): Promise<number> {
  return invoke<number>("sql_execute", { connectionString, sql, params });
}

/**
 * Build a HostServices object bound to a specific connection string,
 * ready to inject into a plugin client.
 */
export function buildHostServices(connectionString: string): HostServices {
  return {
    sql: {
      query: (sql) => sqlQuery(connectionString, sql),
      execute: (sql, params) => sqlExecute(connectionString, sql, params),
    },
  };
}

/**
 * Run a Redis command via the main process ioredis connection.
 */
export function kvCommand(connectionString: string, command: string, ...args: (string | number)[]): Promise<unknown> {
  return invoke<unknown>("kv_command", { connectionString, command, args });
}

/**
 * Build a HostServices object with KV services bound to a Redis connection string.
 */
export function buildKvHostServices(connectionString: string): HostServices {
  return {
    kv: {
      command: (cmd, ...args) => kvCommand(connectionString, cmd, ...args),
    },
  };
}
