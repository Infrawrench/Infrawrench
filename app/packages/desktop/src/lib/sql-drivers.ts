import { invoke } from "../lib/invoke";
import type { HostServices, PluginManifest } from "@infrawrench/plugin-base";

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

export function dockerCommand(
  driverId: string,
  dockerHost: string,
  op: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  return invoke<unknown>("plugin_docker_command", { driverId, dockerHost, op, params });
}

export function buildDockerHostServices(driverId: string, dockerHost: string): HostServices {
  return {
    docker: {
      command: (op, params) => dockerCommand(driverId, dockerHost, op, params),
    },
  };
}

function httpRequest(req: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  caCert?: string;
}): Promise<{ status: number; body: string }> {
  return invoke<{ status: number; body: string }>("k8s_api_request", req);
}

const httpHostServices = { http: { request: httpRequest } };

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
