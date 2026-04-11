/**
 * Builds HostServices for integration tests.
 * Mirrors app/packages/web/src/services/host-services.ts but imported
 * directly from each plugin's driver export.
 */

import type { HostServices, Plugin } from "@infrawrench/plugin-base";

// SQL drivers
import { driver as pgDriver } from "@infrawrench/plugin-postgres/driver";
import { driver as mysqlDriver } from "@infrawrench/plugin-mysql/driver";
import { driver as libsqlDriver } from "@infrawrench/plugin-turso/driver";

// KV drivers
import { driver as redisDriver } from "@infrawrench/plugin-redis/driver";
import { driver as memcachedDriver } from "@infrawrench/plugin-memcached/driver";
import { driver as mongodbDriver } from "@infrawrench/plugin-mongodb/driver";

// Docker driver
import { driver as dockerDriver } from "@infrawrench/plugin-docker/driver";

// Storage driver
import { nodeDriver as gcpDriver } from "@infrawrench/plugin-gcp/node-driver";

import type { SqlNodeDriver, KvNodeDriver, DockerNodeDriver } from "@infrawrench/plugin-base";

const sqlDrivers = new Map<string, SqlNodeDriver>([
  [pgDriver.id, pgDriver],
  [mysqlDriver.id, mysqlDriver],
  [libsqlDriver.id, libsqlDriver],
]);

const kvDrivers = new Map<string, KvNodeDriver>([
  [redisDriver.id, redisDriver],
  [memcachedDriver.id, memcachedDriver],
  [mongodbDriver.id, mongodbDriver],
]);

const dockerDrivers = new Map<string, DockerNodeDriver>([
  [dockerDriver.id, dockerDriver],
]);

const httpHostServices: HostServices = {
  http: {
    request: async (req) => {
      const resp = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        ...(req.body != null ? { body: req.body } : {}),
      });
      return { status: resp.status, body: await resp.text() };
    },
  },
};

/**
 * Build HostServices for a plugin given its manifest and credentials.
 * Returns undefined if no driver is needed.
 */
export function buildHostServices(
  plugin: Plugin,
  credentials: Record<string, string>,
): HostServices | undefined {
  const manifest = plugin.manifest;

  if (manifest.dockerDriver) {
    const dockerHost = credentials[manifest.dockerDriver.credentialKey] ?? "";
    const driver = dockerDrivers.get(manifest.dockerDriver.driver);
    if (!driver) return httpHostServices;
    return {
      docker: {
        command: (op, params) => driver.command(dockerHost, op, params),
      },
      ...httpHostServices,
    };
  }

  if (manifest.sqlDriver) {
    const connectionString = credentials[manifest.sqlDriver.credentialKey] ?? "";
    const driver = sqlDrivers.get(manifest.sqlDriver.driver);
    if (!driver) return httpHostServices;
    return {
      sql: {
        query: (sql) => driver.query(connectionString, sql),
        execute: (sql, params) => driver.execute(connectionString, sql, params),
      },
      ...httpHostServices,
    };
  }

  if (manifest.kvDriver) {
    const connectionString = credentials[manifest.kvDriver.credentialKey] ?? "";
    const driver = kvDrivers.get(manifest.kvDriver.driver);
    if (!driver) return httpHostServices;
    return {
      kv: {
        command: (cmd, ...args) => driver.command(connectionString, cmd, args),
      },
      ...httpHostServices,
    };
  }

  return httpHostServices;
}
