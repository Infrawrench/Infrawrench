import { Effect, Layer } from "effect";
import { AppShellRpcs } from "../../../shared/rpc/groups/app-shell";
import { AppShell } from "../../app-shell";

export const AppShellHandlers = AppShellRpcs.toLayer(
  Effect.gen(function* () {
    const app = yield* AppShell;
    return AppShellRpcs.of({
      AppSetPingsActive: ({ count }) => app.setPingsActive(count),
      AppSetCronsActive: ({ count }) => app.setCronsActive(count),
      AppInstallUpdateNow: () => app.installUpdateNow,
      AppShowNotification: ({ title, body }) => app.showNotification(title, body),
      AppShowOpenDialog: (options) => app.showOpenDialog(options),
      AppOpenExternalUrl: ({ url }) => app.openExternalUrl(url),
      AppReadClipboardImage: () => app.readClipboardImage,
    });
  }),
).pipe(Layer.provide(AppShell.layer));
