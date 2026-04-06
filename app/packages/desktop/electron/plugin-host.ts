/**
 * Plugin node-driver host — registers all plugin IPC channels.
 *
 * main.ts imports this module for its side effects only.
 * It has no knowledge of specific plugins; it dispatches generically
 * through the driver maps in drivers.ts.
 */
import { ipcMain } from "electron";
import path from "node:path";
import { sqlDrivers, kvDrivers, dockerDrivers, storageDrivers } from "./drivers";

ipcMain.handle("plugin_sql_query", (_e, {
  driverId, connectionString, sql,
}: { driverId: string; connectionString: string; sql: string }) => {
  const driver = sqlDrivers.get(driverId);
  if (!driver) throw new Error(`No SQL driver registered for "${driverId}"`);
  return driver.query(connectionString, sql);
});

ipcMain.handle("plugin_sql_execute", (_e, {
  driverId, connectionString, sql, params,
}: { driverId: string; connectionString: string; sql: string; params?: unknown[] }) => {
  const driver = sqlDrivers.get(driverId);
  if (!driver) throw new Error(`No SQL driver registered for "${driverId}"`);
  return driver.execute(connectionString, sql, params ?? []);
});

ipcMain.handle("plugin_kv_command", (_e, {
  driverId, connectionString, command, args,
}: { driverId: string; connectionString: string; command: string; args?: (string | number)[] }) => {
  const driver = kvDrivers.get(driverId);
  if (!driver) throw new Error(`No KV driver registered for "${driverId}"`);
  return driver.command(connectionString, command, args ?? []);
});

ipcMain.handle("plugin_docker_command", (_e, {
  driverId, dockerHost, op, params,
}: { driverId: string; dockerHost: string; op: string; params?: Record<string, unknown> }) => {
  const driver = dockerDrivers.get(driverId);
  if (!driver) throw new Error(`No Docker driver registered for "${driverId}"`);
  return driver.command(dockerHost, op, params ?? {});
});

ipcMain.handle("storage_download_batch", async (
  event,
  { pluginId, bucket, keys, destFolder, accessToken }: {
    pluginId: string;
    bucket: string;
    keys: string[];
    destFolder: string;
    accessToken: string;
  },
) => {
  const driver = storageDrivers.get(pluginId);
  if (!driver) throw new Error(`No storage driver registered for plugin "${pluginId}"`);
  const errors: string[] = [];
  let done = 0;
  for (const key of keys) {
    const destPath = path.join(destFolder, ...key.split("/"));
    try {
      await driver.downloadFile(bucket, key, accessToken, destPath);
    } catch (e) {
      errors.push(`${key}: ${String(e)}`);
    }
    done++;
    event.sender.send("storage_download_progress", { done, total: keys.length });
  }
  return { errors };
});
