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
import { isDialogBlessedPath } from "./main-utils";

ipcMain.handle(
  "plugin_sql_query",
  (
    _e,
    {
      driverId,
      connectionString,
      sql,
    }: { driverId: string; connectionString: string; sql: string },
  ) => {
    const driver = sqlDrivers.get(driverId);
    if (!driver) throw new Error(`No SQL driver registered for "${driverId}"`);
    return driver.query(connectionString, sql);
  },
);

ipcMain.handle(
  "plugin_sql_execute",
  (
    _e,
    {
      driverId,
      connectionString,
      sql,
      params,
    }: { driverId: string; connectionString: string; sql: string; params?: unknown[] },
  ) => {
    const driver = sqlDrivers.get(driverId);
    if (!driver) throw new Error(`No SQL driver registered for "${driverId}"`);
    return driver.execute(connectionString, sql, params ?? []);
  },
);

ipcMain.handle(
  "plugin_kv_command",
  (
    _e,
    {
      driverId,
      connectionString,
      command,
      args,
    }: { driverId: string; connectionString: string; command: string; args?: (string | number)[] },
  ) => {
    const driver = kvDrivers.get(driverId);
    if (!driver) throw new Error(`No KV driver registered for "${driverId}"`);
    return driver.command(connectionString, command, args ?? []);
  },
);

ipcMain.handle(
  "plugin_docker_command",
  (
    _e,
    {
      driverId,
      dockerHost,
      op,
      params,
    }: { driverId: string; dockerHost: string; op: string; params?: Record<string, unknown> },
  ) => {
    const driver = dockerDrivers.get(driverId);
    if (!driver) throw new Error(`No Docker driver registered for "${driverId}"`);
    return driver.command(dockerHost, op, params ?? {});
  },
);

ipcMain.handle(
  "storage_download_batch",
  async (
    event,
    {
      pluginId,
      bucket,
      keys,
      destFolder,
      accessToken,
    }: {
      pluginId: string;
      bucket: string;
      keys: string[];
      destFolder: string;
      accessToken: string;
    },
  ) => {
    const driver = storageDrivers.get(pluginId);
    if (!driver) throw new Error(`No storage driver registered for plugin "${pluginId}"`);

    // The destination folder MUST have come from a recent showOpenDialog call.
    // Without this, a compromised renderer could pick any path on disk.
    if (!isDialogBlessedPath(destFolder)) {
      throw new Error("storage_download_batch: destFolder was not chosen via a system dialog");
    }
    const resolvedDest = path.resolve(destFolder);

    const errors: string[] = [];
    let done = 0;
    for (const key of keys) {
      // Reject keys with parent-directory segments outright — they can never
      // be a legitimate object key and only exist to escape destFolder.
      const segments = key.split("/");
      if (segments.some((s) => s === ".." || s === "")) {
        errors.push(`${key}: rejected path-traversal key`);
        done++;
        event.sender.send("storage_download_progress", { done, total: keys.length });
        continue;
      }
      const destPath = path.resolve(resolvedDest, ...segments);
      // Defense in depth: resolved destination must stay beneath destFolder.
      const destPrefix = resolvedDest.endsWith(path.sep) ? resolvedDest : resolvedDest + path.sep;
      if (destPath !== resolvedDest && !destPath.startsWith(destPrefix)) {
        errors.push(`${key}: rejected path escape`);
        done++;
        event.sender.send("storage_download_progress", { done, total: keys.length });
        continue;
      }
      try {
        await driver.downloadFile(bucket, key, accessToken, destPath);
      } catch (e) {
        errors.push(`${key}: ${String(e)}`);
      }
      done++;
      event.sender.send("storage_download_progress", { done, total: keys.length });
    }
    return { errors };
  },
);
