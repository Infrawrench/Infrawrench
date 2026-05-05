/**
 * Aggregates all plugin node drivers and re-exports typed maps for use in
 * server actions and API routes. Mirrors app/packages/desktop/electron/drivers.ts.
 */
import type {
  SqlNodeDriver,
  KvNodeDriver,
  DockerNodeDriver,
  StorageNodeDriver,
} from "@infrawrench/plugin-base";

import { driver as pgDriver } from "@infrawrench/plugin-postgres/driver";
import { driver as mysqlDriver } from "@infrawrench/plugin-mysql/driver";
import { driver as mssqlDriver } from "@infrawrench/plugin-mssql/driver";
import { driver as redisDriver } from "@infrawrench/plugin-redis/driver";
import { driver as memcachedDriver } from "@infrawrench/plugin-memcached/driver";
import { driver as mongodbDriver } from "@infrawrench/plugin-mongodb/driver";
import { driver as dockerDriver } from "@infrawrench/plugin-docker/driver";
import { driver as libsqlDriver } from "@infrawrench/plugin-turso/driver";
import { driver as planetscaleDriver } from "@infrawrench/plugin-planetscale/driver";
import { nodeDriver as gcpDriver } from "@infrawrench/plugin-gcp/node-driver";

export const sqlDrivers = new Map<string, SqlNodeDriver>([
  [pgDriver.id, pgDriver],
  [mysqlDriver.id, mysqlDriver],
  [mssqlDriver.id, mssqlDriver],
  [libsqlDriver.id, libsqlDriver],
  [planetscaleDriver.id, planetscaleDriver],
]);

export const kvDrivers = new Map<string, KvNodeDriver>([
  [redisDriver.id, redisDriver],
  [memcachedDriver.id, memcachedDriver],
  [mongodbDriver.id, mongodbDriver],
]);

export const dockerDrivers = new Map<string, DockerNodeDriver>([[dockerDriver.id, dockerDriver]]);

export const storageDrivers = new Map<string, StorageNodeDriver>([[gcpDriver.pluginId, gcpDriver]]);
