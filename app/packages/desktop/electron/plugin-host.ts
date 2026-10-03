/**
 * Plugin node-driver host: registers all plugin IPC channels.
 *
 * main.ts imports this module for its side effects only.
 * It has no knowledge of specific plugins; it dispatches generically
 * through the driver maps in drivers.ts.
 */
import { ipcMain } from "electron";
import path from "node:path";
import { sqlDrivers, kvDrivers, dockerDrivers, k8sDrivers, storageDrivers } from "./drivers";
import { isDialogBlessedPath, resolveBeneathFolder } from "./main-utils";
import { getDesktopHttpHostServices } from "./plugin-runtime";
import { localExecGuard } from "./local-exec-consent";

ipcMain.handle(
  "plugin_sql_query",
  (
    _e,
    {
      driverId,
      connectionString,
      sql,
      caCert,
    }: {
      driverId: string;
      connectionString: string;
      sql: string;
      caCert?: string;
    },
  ) => {
    const driver = sqlDrivers.get(driverId);
    if (!driver) throw new Error(`No SQL driver registered for "${driverId}"`);
    return driver.query(connectionString, sql, caCert ? { caCert } : undefined);
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
      caCert,
    }: {
      driverId: string;
      connectionString: string;
      sql: string;
      params?: unknown[];
      caCert?: string;
    },
  ) => {
    const driver = sqlDrivers.get(driverId);
    if (!driver) throw new Error(`No SQL driver registered for "${driverId}"`);
    return driver.execute(connectionString, sql, params ?? [], caCert ? { caCert } : undefined);
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
  async (
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
    // The host comes from the renderer, and the default is this machine's
    // socket: only a stored account's host, an SSH tunnel main opened, or one
    // the user approved in a native dialog gets a client.
    await localExecGuard.assertDockerHost(typeof dockerHost === "string" ? dockerHost : "");
    return driver.command(dockerHost, op, params ?? {});
  },
);

ipcMain.handle(
  "plugin_k8s_command",
  async (
    _e,
    {
      driverId,
      kubeconfig,
      op,
      params,
    }: { driverId: string; kubeconfig: string; op: string; params?: Record<string, unknown> },
  ) => {
    const driver = k8sDrivers.get(driverId);
    if (!driver) throw new Error(`No Kubernetes driver registered for "${driverId}"`);
    // @kubernetes/client-node runs a kubeconfig's exec/auth-provider commands
    // just as kubectl does.
    if (typeof kubeconfig !== "string") throw new Error("plugin_k8s_command: missing kubeconfig");
    await localExecGuard.assertKubeconfig(kubeconfig);
    return driver.command(kubeconfig, op, params ?? {});
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
      // Reject keys with parent-directory segments outright: they can never
      // be a legitimate object key and only exist to escape destFolder.
      const segments = key.split("/");
      if (segments.some((s) => s === ".." || s === "")) {
        errors.push(`${key}: rejected path-traversal key`);
        done++;
        event.sender.send("storage_download_progress", { done, total: keys.length });
        continue;
      }
      // Defense in depth: resolved destination must stay beneath destFolder.
      const destPath = resolveBeneathFolder(resolvedDest, segments);
      if (!destPath) {
        errors.push(`${key}: rejected path escape`);
        done++;
        event.sender.send("storage_download_progress", { done, total: keys.length });
        continue;
      }
      try {
        await driver.downloadFile(bucket, key, accessToken, destPath, {
          http: getDesktopHttpHostServices(),
        });
      } catch (e) {
        errors.push(`${key}: ${String(e)}`);
      }
      done++;
      event.sender.send("storage_download_progress", { done, total: keys.length });
    }
    return { errors };
  },
);
