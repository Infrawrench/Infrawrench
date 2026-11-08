// Runs one command line through `effect/cli` and answers with the exit code,
// rendering every outcome the way the CLI always has:
//
// - `--help`: the command's help on stdout, exit 0. The root's (`infrawrench
//   --help`) is the hand-written list in `../help.ts`, which says more than a
//   generated one can.
// - `--version` / `-v`: `app.getVersion()` alone on stdout, exit 0.
// - A parse error (unknown flag, bad value, unknown subcommand): the
//   command's help and an `ERROR` line, both on stderr so a `| jq` pipeline
//   sees nothing, exit 2. At the root, where that help is the whole list, the
//   error alone and a pointer to `infrawrench help`; an unknown command is
//   the sentence it has always been.
// - A typed failure (`errors.ts`): one red line on stderr, its exit code;
//   `CliExit` (the command already printed why) only the exit code.
// - A `CliError` or `UserFacingError` thrown by Promise code underneath (a
//   defect here), or a typed failure rejected through it: one red line, its
//   exit code.
// - Any other defect: the red stack trace, exit 1.
import { Cause, Effect, Exit, Layer, Predicate } from "effect";
import { CliConfig, CliError as EffectCliError, CliOutput, Command, GlobalFlag } from "effect/cli";
import { UserFacingError } from "../../main-utils";
import { CliError } from "../context";
import { c, colorIsEnabled, printErr, println } from "../output";
import { CloudApi } from "./cloud-api";
import type { CliCommandError } from "./errors";
import { CliPlatform } from "./platform";
import { HELP } from "../help";
import { ROOT_NAME, root } from "./root";
import { CliHost } from "./session";

export interface EffectCliOptions {
  /** `app.getVersion()`: what `--version` prints. */
  readonly version: string;
  /** The GUI holds the single-instance lock: DB and tokens are read-only. */
  readonly guiRunning: boolean;
}

const isRoot = (commandPath: ReadonlyArray<string>) =>
  commandPath.length === 1 && commandPath[0] === ROOT_NAME;

/** `infrawrench <typo>`: the sentence the CLI has always answered with. */
const unknownCommand = (errors: ReadonlyArray<EffectCliError.NonShowHelpErrors>) => {
  const [first] = errors;
  return errors.length === 1 && first?._tag === "UnknownSubcommand" ? first.subcommand : undefined;
};

const presenter: CliOutput.Presenter = {
  present: (event) =>
    Effect.sync(() => {
      const formatter = CliOutput.defaultFormatter({ colors: colorIsEnabled() });
      switch (event._tag) {
        case "Help":
          println(isRoot(event.commandPath) ? HELP : formatter.formatHelpDoc(event.helpDoc));
          return;
        case "InvalidInvocation": {
          if (!isRoot(event.commandPath)) {
            printErr(formatter.formatHelpDoc(event.helpDoc));
            printErr(formatter.formatErrors(event.errors));
            return;
          }
          const typo = unknownCommand(event.errors);
          if (typo !== undefined) {
            printErr(`Unknown command "${typo}". Run \`infrawrench help\`.`);
            return;
          }
          printErr(formatter.formatErrors(event.errors));
          printErr("Run `infrawrench help` for the commands and their flags.");
          return;
        }
        case "Version":
          println(event.version);
          return;
      }
    }),
};

/**
 * `--help` and `--version` only. `--completions` would print a script that
 * `cli install` does not install yet, `--wizard` is `effect/cli`'s own
 * `Prompt` flow (the CLI draws its prompts itself, `prompt.ts`), and
 * `--log-level` has no logs to level.
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

/**
 * A typed failure (`errors.ts`) that reached here as a defect: rejected
 * through Promise code (a workflow runtime callback, the TUI's runner) and
 * awaited by `Effect.promise`. It still says what went wrong in one line.
 */
const isTypedFailure = (
  defect: unknown,
): defect is { readonly message: string; readonly exitCode: number } =>
  defect instanceof Error &&
  Predicate.hasProperty(defect, "_tag") &&
  Predicate.hasProperty(defect, "exitCode") &&
  Predicate.isNumber(defect.exitCode);

const reportDefect = (defect: unknown): Effect.Effect<number> =>
  Effect.sync(() => {
    // A stack trace is for a bug in here, not for a typo'd flag or a locked
    // keychain: those print as a single line.
    if (defect instanceof CliError || defect instanceof UserFacingError) {
      printErr(c.red(defect.message));
      return defect instanceof CliError ? defect.exitCode : 1;
    }
    if (isTypedFailure(defect)) {
      printErr(c.red(defect.message));
      return defect.exitCode;
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
