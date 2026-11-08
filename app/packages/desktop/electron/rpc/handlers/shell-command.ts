import { Effect, Layer } from "effect";
import { ShellCommandRpcs } from "../../../shared/rpc/groups/shell-command";
import { ShellCommand } from "../../shell-command";

export const ShellCommandHandlers = ShellCommandRpcs.toLayer(
  Effect.gen(function* () {
    const shell = yield* ShellCommand;
    return ShellCommandRpcs.of({
      ShellCommandStatus: () => shell.status,
      ShellCommandInstall: () => shell.install,
      ShellCommandUninstall: () => shell.uninstall,
    });
  }),
).pipe(Layer.provide(ShellCommand.layer));
