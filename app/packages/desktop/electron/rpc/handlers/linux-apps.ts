import { Effect, Layer } from "effect";
import { LinuxAppsRpcs } from "../../../shared/rpc/groups/linux-apps";
import { LinuxApps } from "../../iwappd-host";

export const LinuxAppsHandlers = LinuxAppsRpcs.toLayer(
  Effect.gen(function* () {
    const apps = yield* LinuxApps;
    return LinuxAppsRpcs.of({
      // The stream's scope owns the app server and the connection.
      AppsSessionOpen: (config, { client }) => apps.open(config, client.id),
      AppsSessionWrite: ({ sessionId, data }, { client }) => apps.write(sessionId, client.id, data),
      AppsList: ({ config, iconSize }) => apps.list(config, iconSize),
      AppsPreflight: ({ config }) => apps.preflight(config),
      AppsInstall: ({ config, include }) => apps.install(config, include),
    });
  }),
).pipe(Layer.provide(LinuxApps.layer));
