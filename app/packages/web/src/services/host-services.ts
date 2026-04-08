/**
 * Builds HostServices for plugin clients on the web server.
 * Mirrors app/packages/desktop/src/lib/sql-drivers.ts but calls node drivers
 * directly instead of going through Electron IPC.
 */
import type { HostServices, PluginManifest } from "@infrawrench/plugin-base";
import { sqlDrivers, kvDrivers, dockerDrivers } from "./drivers";

export function buildHostServices(driverId: string, connectionString: string): HostServices {
  const driver = sqlDrivers.get(driverId);
  if (!driver) throw new Error(`Unknown SQL driver: ${driverId}`);
  return {
    sql: {
      query: (sql) => driver.query(connectionString, sql),
      execute: (sql, params) => driver.execute(connectionString, sql, params),
    },
  };
}

export function buildKvHostServices(driverId: string, connectionString: string): HostServices {
  const driver = kvDrivers.get(driverId);
  if (!driver) throw new Error(`Unknown KV driver: ${driverId}`);
  return {
    kv: {
      command: (cmd, ...args) => driver.command(connectionString, cmd, args),
    },
  };
}

export function buildDockerHostServices(driverId: string, dockerHost: string): HostServices {
  const driver = dockerDrivers.get(driverId);
  if (!driver) throw new Error(`Unknown Docker driver: ${driverId}`);
  return {
    docker: {
      command: (op, params) => driver.command(dockerHost, op, params),
    },
  };
}

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

/** Inspects the plugin manifest and builds the appropriate HostServices for use with createClient(). */
export function buildPluginHostServices(
  manifest: PluginManifest,
  credentials: Record<string, string>,
): HostServices | undefined {
  if (manifest.dockerDriver) {
    const dockerHost = credentials[manifest.dockerDriver.credentialKey] ?? "";
    return { ...buildDockerHostServices(manifest.dockerDriver.driver, dockerHost), ...httpHostServices };
  }
  if (manifest.sqlDriver) {
    const connectionString = credentials[manifest.sqlDriver.credentialKey] ?? "";
    return { ...buildHostServices(manifest.sqlDriver.driver, connectionString), ...httpHostServices };
  }
  if (manifest.kvDriver) {
    const connectionString = credentials[manifest.kvDriver.credentialKey] ?? "";
    return { ...buildKvHostServices(manifest.kvDriver.driver, connectionString), ...httpHostServices };
  }
  // Even without a specific driver, provide HTTP proxy for plugins like K8s
  return httpHostServices;
}
