import { driver as pgDriver } from "@infrawrench/plugin-postgres/driver";
import { driver as mysqlDriver } from "@infrawrench/plugin-mysql/driver";
import { driver as redisDriver } from "@infrawrench/plugin-redis/driver";
import { driver as memcachedDriver } from "@infrawrench/plugin-memcached/driver";

export interface SqlDriver {
  id: string;
  query(connectionString: string, sql: string): Promise<Record<string, unknown>[]>;
  execute(connectionString: string, sql: string, params: unknown[]): Promise<number>;
}

export interface KvDriver {
  id: string;
  command(connectionString: string, cmd: string, args: (string | number)[]): Promise<unknown>;
}

export const sqlDrivers = new Map<string, SqlDriver>([
  [pgDriver.id, pgDriver],
  [mysqlDriver.id, mysqlDriver],
]);

export const kvDrivers = new Map<string, KvDriver>([
  [redisDriver.id, redisDriver],
  [memcachedDriver.id, memcachedDriver],
]);
