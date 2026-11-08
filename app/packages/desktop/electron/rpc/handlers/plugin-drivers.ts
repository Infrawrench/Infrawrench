import { Effect, Layer } from "effect";
import { PluginDriverRpcs } from "../../../shared/rpc/groups/plugin-drivers";
import { PluginDrivers } from "../../plugin-host";

export const PluginDriverHandlers = PluginDriverRpcs.toLayer(
  Effect.gen(function* () {
    const drivers = yield* PluginDrivers;
    return PluginDriverRpcs.of({
      PluginSqlQuery: (input) => drivers.sqlQuery(input),
      PluginSqlExecute: (input) => drivers.sqlExecute(input),
      PluginKvCommand: (input) => drivers.kvCommand(input),
      PluginDockerCommand: (input) => drivers.dockerCommand(input),
      PluginK8sCommand: (input) => drivers.k8sCommand(input),
      StorageDownloadBatch: (request) => drivers.storageDownload(request),
    });
  }),
).pipe(Layer.provide(PluginDrivers.layer));
