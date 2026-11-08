/**
 * Plugin node drivers (`nodeDrivers.desktop`): SQL, key-value, Docker and
 * Kubernetes commands, and storage downloads, run in the main process because
 * they need raw sockets, a kubeconfig's exec plugins, or the filesystem.
 *
 * The host knows no plugin: every call names its driver by id and the main
 * process dispatches through the driver maps in `electron/drivers.ts`. What a
 * driver answers is the driver's own business, so it travels as a
 * {@link StructuredValue}: a `Date` column, a `bytea` Buffer or a `bigint`
 * arrives as it did over `ipcRenderer.invoke`.
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { StructuredArgs, StructuredValue } from "../structured";

/**
 * The driver failed (or no driver has that id, or the local-exec guard
 * refused the Docker host or kubeconfig); the message is the driver's own.
 */
export class PluginDriverError extends Schema.TaggedError<PluginDriverError>()(
  "PluginDriverError",
  { message: Schema.String },
) {}

const Row = Schema.Record(Schema.String, StructuredValue);

export class PluginDriverRpcs extends RpcGroup.make(
  Rpc.make("PluginSqlQuery", {
    payload: {
      driverId: Schema.String,
      connectionString: Schema.String,
      sql: Schema.String,
      caCert: Schema.optionalKey(Schema.String),
    },
    success: Schema.mutable(Schema.Array(Row)),
    error: PluginDriverError,
  }),
  Rpc.make("PluginSqlExecute", {
    payload: {
      driverId: Schema.String,
      connectionString: Schema.String,
      sql: Schema.String,
      params: Schema.optionalKey(StructuredArgs),
      caCert: Schema.optionalKey(Schema.String),
    },
    /** Rows affected. */
    success: Schema.Finite,
    error: PluginDriverError,
  }),
  Rpc.make("PluginKvCommand", {
    payload: {
      driverId: Schema.String,
      connectionString: Schema.String,
      command: Schema.String,
      args: Schema.optionalKey(Schema.Array(Schema.Union([Schema.String, Schema.Finite]))),
    },
    success: StructuredValue,
    error: PluginDriverError,
  }),
  Rpc.make("PluginDockerCommand", {
    payload: {
      driverId: Schema.String,
      dockerHost: Schema.String,
      op: Schema.String,
      params: Schema.optionalKey(Schema.Record(Schema.String, StructuredValue)),
    },
    success: StructuredValue,
    error: PluginDriverError,
  }),
  Rpc.make("PluginK8sCommand", {
    payload: {
      driverId: Schema.String,
      kubeconfig: Schema.String,
      op: Schema.String,
      params: Schema.optionalKey(Schema.Record(Schema.String, StructuredValue)),
    },
    success: StructuredValue,
    error: PluginDriverError,
  }),
  /**
   * Download objects into a folder the user picked in a native dialog this
   * session. A key that would escape the folder is refused, and a key that
   * fails is reported in `errors` while the rest carry on.
   */
  Rpc.make("StorageDownloadBatch", {
    payload: {
      pluginId: Schema.String,
      bucket: Schema.String,
      keys: Schema.Array(Schema.String),
      destFolder: Schema.String,
      accessToken: Schema.String,
    },
    success: Schema.Struct({ errors: Schema.Array(Schema.String) }),
    error: PluginDriverError,
  }),
) {}
