/**
 * Aggregates all plugin node drivers and re-exports typed maps for use in
 * the IPC handlers (main.ts). All driver interface definitions live in
 * @infrawrench/plugin-base — this file is a pure registration point.
 */
import type { SqlNodeDriver, KvNodeDriver, DockerNodeDriver, StorageNodeDriver } from "@infrawrench/plugin-base";

import { driver as pgDriver }        from "@infrawrench/plugin-postgres/driver";
import { driver as mysqlDriver }     from "@infrawrench/plugin-mysql/driver";
import { driver as redisDriver }     from "@infrawrench/plugin-redis/driver";
import { driver as memcachedDriver } from "@infrawrench/plugin-memcached/driver";
import { driver as mongodbDriver }   from "@infrawrench/plugin-mongodb/driver";
import { driver as dockerDriver }    from "@infrawrench/plugin-docker/driver";
import { nodeDriver as gcpDriver }   from "@infrawrench/plugin-gcp/node-driver";

export { SqlNodeDriver, KvNodeDriver, DockerNodeDriver, StorageNodeDriver };

export const sqlDrivers     = new Map<string, SqlNodeDriver>([
  [pgDriver.id,        pgDriver],
  [mysqlDriver.id,     mysqlDriver],
]);

export const kvDrivers      = new Map<string, KvNodeDriver>([
  [redisDriver.id,     redisDriver],
  [memcachedDriver.id, memcachedDriver],
  [mongodbDriver.id,   mongodbDriver],
]);

export const dockerDrivers  = new Map<string, DockerNodeDriver>([
  [dockerDriver.id,    dockerDriver],
]);

export const storageDrivers = new Map<string, StorageNodeDriver>([
  [gcpDriver.pluginId, gcpDriver],
]);
