/**
 * Plugin node-driver host: the `PluginDrivers` service behind the plugin
 * driver RPCs (`shared/rpc/groups/plugin-drivers.ts`).
 *
 * It has no knowledge of specific plugins; it dispatches generically through
 * the driver maps in drivers.ts. Those are host-facing drivers
 * (`collectNodeDrivers` runs each method on call and returns a Promise), and
 * each call here is one `Effect.tryPromise` around the whole driver call, so
 * the driver starts inside whatever egress scope the call sets up.
 */
import path from "node:path";
import { Context, Effect, Layer } from "effect";
import { errorMessage } from "../shared/rpc/errors";
import { PluginDriverError } from "../shared/rpc/groups/plugin-drivers";
import { sqlDrivers, kvDrivers, dockerDrivers, k8sDrivers, storageDrivers } from "./drivers";
import { isDialogBlessedPath, resolveBeneathFolder } from "./main-utils";
import { getDesktopHttpHostServices } from "./plugin-runtime";
import { localExecGuard } from "./local-exec-consent";

const driverCall = <A>(run: () => Promise<A>): Effect.Effect<A, PluginDriverError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new PluginDriverError({ message: errorMessage(cause) }),
  });

function lookup<D>(drivers: ReadonlyMap<string, D>, id: string, kind: string): D {
  const driver = drivers.get(id);
  if (!driver) throw new Error(`No ${kind} driver registered for "${id}"`);
  return driver;
}

export interface StorageDownloadRequest {
  readonly pluginId: string;
  readonly bucket: string;
  readonly keys: readonly string[];
  readonly destFolder: string;
  readonly accessToken: string;
}

async function downloadBatch(request: StorageDownloadRequest): Promise<{ errors: string[] }> {
  const { pluginId, bucket, keys, destFolder, accessToken } = request;
  const driver = storageDrivers.get(pluginId);
  if (!driver) throw new Error(`No storage driver registered for plugin "${pluginId}"`);

  // The destination folder MUST have come from a recent showOpenDialog call.
  // Without this, a compromised renderer could pick any path on disk.
  if (!isDialogBlessedPath(destFolder)) {
    throw new Error("The download folder was not chosen in a system dialog");
  }
  const resolvedDest = path.resolve(destFolder);

  const errors: string[] = [];
  for (const key of keys) {
    // Reject keys with parent-directory segments outright: they can never
    // be a legitimate object key and only exist to escape destFolder.
    const segments = key.split("/");
    if (segments.some((s) => s === ".." || s === "")) {
      errors.push(`${key}: rejected path-traversal key`);
      continue;
    }
    // Defense in depth: resolved destination must stay beneath destFolder.
    const destPath = resolveBeneathFolder(resolvedDest, segments);
    if (!destPath) {
      errors.push(`${key}: rejected path escape`);
      continue;
    }
    try {
      await driver.downloadFile(bucket, key, accessToken, destPath, {
        http: getDesktopHttpHostServices(),
      });
    } catch (e) {
      errors.push(`${key}: ${String(e)}`);
    }
  }
  return { errors };
}

export class PluginDrivers extends Context.Service<
  PluginDrivers,
  {
    readonly sqlQuery: (input: {
      readonly driverId: string;
      readonly connectionString: string;
      readonly sql: string;
      readonly caCert?: string;
    }) => Effect.Effect<Record<string, unknown>[], PluginDriverError>;
    readonly sqlExecute: (input: {
      readonly driverId: string;
      readonly connectionString: string;
      readonly sql: string;
      readonly params?: readonly unknown[];
      readonly caCert?: string;
    }) => Effect.Effect<number, PluginDriverError>;
    readonly kvCommand: (input: {
      readonly driverId: string;
      readonly connectionString: string;
      readonly command: string;
      readonly args?: readonly (string | number)[];
    }) => Effect.Effect<unknown, PluginDriverError>;
    readonly dockerCommand: (input: {
      readonly driverId: string;
      readonly dockerHost: string;
      readonly op: string;
      readonly params?: { readonly [key: string]: unknown };
    }) => Effect.Effect<unknown, PluginDriverError>;
    readonly k8sCommand: (input: {
      readonly driverId: string;
      readonly kubeconfig: string;
      readonly op: string;
      readonly params?: { readonly [key: string]: unknown };
    }) => Effect.Effect<unknown, PluginDriverError>;
    readonly storageDownload: (
      request: StorageDownloadRequest,
    ) => Effect.Effect<{ errors: string[] }, PluginDriverError>;
  }
>()("infrawrench/desktop/PluginDrivers") {
  static readonly layer = Layer.succeed(PluginDrivers)(
    PluginDrivers.of({
      sqlQuery: ({ driverId, connectionString, sql, caCert }) =>
        driverCall(() =>
          lookup(sqlDrivers, driverId, "SQL").query(
            connectionString,
            sql,
            caCert ? { caCert } : undefined,
          ),
        ),
      sqlExecute: ({ driverId, connectionString, sql, params, caCert }) =>
        driverCall(() =>
          lookup(sqlDrivers, driverId, "SQL").execute(
            connectionString,
            sql,
            [...(params ?? [])],
            caCert ? { caCert } : undefined,
          ),
        ),
      kvCommand: ({ driverId, connectionString, command, args }) =>
        driverCall(() =>
          lookup(kvDrivers, driverId, "KV").command(connectionString, command, [...(args ?? [])]),
        ),
      dockerCommand: ({ driverId, dockerHost, op, params }) =>
        driverCall(async () => {
          const driver = lookup(dockerDrivers, driverId, "Docker");
          // The host comes from the renderer, and the default is this machine's
          // socket: only a stored account's host, an SSH tunnel main opened, or one
          // the user approved in a native dialog gets a client.
          await localExecGuard.assertDockerHost(dockerHost);
          return driver.command(dockerHost, op, { ...params });
        }),
      k8sCommand: ({ driverId, kubeconfig, op, params }) =>
        driverCall(async () => {
          const driver = lookup(k8sDrivers, driverId, "Kubernetes");
          // @kubernetes/client-node runs a kubeconfig's exec/auth-provider commands
          // just as kubectl does.
          await localExecGuard.assertKubeconfig(kubeconfig);
          return driver.command(kubeconfig, op, { ...params });
        }),
      storageDownload: (request) => driverCall(() => downloadBatch(request)),
    }),
  );
}
