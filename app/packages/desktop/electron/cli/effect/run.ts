// Runs one migrated command line through `effect/cli` and answers with the
// exit code, rendering every outcome the way the legacy `runCli` does:
//
// - `--help`: the command's help on stdout, exit 0.
// - `--version` / `-v`: `app.getVersion()` alone on stdout, exit 0.
// - A parse error (unknown flag, bad value, unknown subcommand): the
//   command's help and an `ERROR` line, both on stderr so a `| jq` pipeline
//   sees nothing, exit 2.
// - A typed failure (`errors.ts`): one red line on stderr, its exit code;
//   `CliExit` (the command already printed why) only the exit code.
// - A legacy `CliError` or `UserFacingError` thrown by a helper the command
//   still calls (a defect here): one red line, its exit code.
// - Any other defect: the red stack trace, exit 1.
import { Cause, Effect, Exit, Layer } from "effect";
import { CliConfig, CliError as EffectCliError, CliOutput, Command, GlobalFlag } from "effect/cli";
import { UserFacingError } from "../../main-utils";
import { CliError } from "../context";
import { c, colorIsEnabled, printErr, println } from "../output";
import { CloudApi } from "./cloud-api";
import type { CliCommandError } from "./errors";
import { CliPlatform } from "./platform";
import { root } from "./root";
import { CliHost } from "./session";

export interface EffectCliOptions {
  /** `app.getVersion()`: what `--version` prints. */
  readonly version: string;
  /** The GUI holds the single-instance lock: DB and tokens are read-only. */
  readonly guiRunning: boolean;
}

const presenter: CliOutput.Presenter = {
  present: (event) =>
    Effect.sync(() => {
      const formatter = CliOutput.defaultFormatter({ colors: colorIsEnabled() });
      switch (event._tag) {
        case "Help":
          println(formatter.formatHelpDoc(event.helpDoc));
          return;
        case "InvalidInvocation":
          printErr(formatter.formatHelpDoc(event.helpDoc));
          printErr(formatter.formatErrors(event.errors));
          return;
        case "Version":
          println(event.version);
          return;
      }
    }),
};

/**
 * `--help` and `--version` only. The other built-ins would be half-features
 * here: `--completions` would describe only the migrated commands,
 * `--wizard` prompts through key-by-key input the platform layer does not
 * offer, and `--log-level` has no logs to level.
 */
const config = CliConfig.layer({ builtIns: [GlobalFlag.Help, GlobalFlag.Version] });

const reportFailure = (error: CliCommandError | EffectCliError.CliError): Effect.Effect<number> => {
  if (EffectCliError.isCliError(error)) {
    // Already presented by `runWith`. A `ShowHelp` with no errors is help
    // shown because nothing ran (a group with no handler): not a failure.
    return Effect.succeed(error._tag === "ShowHelp" && error.errors.length === 0 ? 0 : 2);
  }
  if (error._tag === "CliExit") return Effect.succeed(error.exitCode);
  return Effect.sync(() => {
    printErr(c.red(error.message));
    return error.exitCode;
  });
};

const reportDefect = (defect: unknown): Effect.Effect<number> =>
  Effect.sync(() => {
    // A stack trace is for a bug in here, not for a typo'd flag or a locked
    // keychain: those print as a single line.
    if (defect instanceof CliError || defect instanceof UserFacingError) {
      printErr(c.red(defect.message));
      return defect instanceof CliError ? defect.exitCode : 1;
    }
    printErr(c.red(defect instanceof Error ? (defect.stack ?? defect.message) : String(defect)));
    return 1;
  });

/** Run `argv` (everything after `--cli`) against {@link root}; resolves with the exit code. */
export async function runEffectCli(
  argv: ReadonlyArray<string>,
  options: EffectCliOptions,
): Promise<number> {
  const program = Command.runWith(root, { version: options.version })(argv).pipe(
    Effect.as(0),
    Effect.catch(reportFailure),
    Effect.catchDefect(reportDefect),
    Effect.provide(
      Layer.mergeAll(
        CliPlatform,
        CloudApi.layer,
        Layer.succeed(CliHost)({ guiRunning: options.guiRunning }),
        config,
        CliOutput.layerPresenter(presenter),
      ),
    ),
  );
  const exit = await Effect.runPromiseExit(program);
  if (Exit.isSuccess(exit)) return exit.value;
  // Only interruption is left (Ctrl-C at a prompt): the shell's convention.
  return Cause.hasInterruptsOnly(exit.cause) ? 130 : 1;
}
