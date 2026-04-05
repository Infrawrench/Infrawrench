import { invoke } from "../lib/invoke";
import type { HostServices } from "@infrawrench/plugin-base";

export function sqlQuery(driverId: string, connectionString: string, sql: string): Promise<Record<string, unknown>[]> {
  return invoke<Record<string, unknown>[]>("plugin_sql_query", { driverId, connectionString, sql });
}

export function sqlExecute(driverId: string, connectionString: string, sql: string, params: unknown[]): Promise<number> {
  return invoke<number>("plugin_sql_execute", { driverId, connectionString, sql, params });
}

export function buildHostServices(driverId: string, connectionString: string): HostServices {
  return {
    sql: {
      query: (sql) => sqlQuery(driverId, connectionString, sql),
      execute: (sql, params) => sqlExecute(driverId, connectionString, sql, params),
    },
  };
}

export function kvCommand(driverId: string, connectionString: string, command: string, ...args: (string | number)[]): Promise<unknown> {
  return invoke<unknown>("plugin_kv_command", { driverId, connectionString, command, args });
}

export function buildKvHostServices(driverId: string, connectionString: string): HostServices {
  return {
    kv: {
      command: (cmd, ...args) => kvCommand(driverId, connectionString, cmd, ...args),
    },
  };
}

// memcached routes through the same plugin_kv_command channel with driverId="memcached"
export const memcachedCommand = kvCommand;
export const buildMemcachedHostServices = buildKvHostServices;
