// `infrawrench` with no command, `infrawrench tui` and `infrawrench help`.
//
// Bare `infrawrench` (and `tui`) opens the full-screen dashboard when stdout
// is a terminal and prints the root help otherwise, so `infrawrench | less`
// and a script that runs it by mistake both read something rather than hang.
// The dashboard itself is `../tui.ts`; it needs keys, so with stdout at a
// terminal but stdin piped it refuses instead.
import { Effect, Stdio } from "effect";
import { Argument, Command } from "effect/cli";
import { CloudApi } from "../effect/cloud-api";
import { CliFailure } from "../effect/errors";
import * as Print from "../effect/print";
import { HELP } from "../help";
import { runTui, type TuiRunner } from "../tui";

/** The root help text (`../help.ts`), on stdout. */
export const printHelp = Print.line(HELP);

/** The dashboard at a terminal, the root help anywhere else. */
export const home = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  if (!(yield* stdio.stdoutIsTerminal)) return yield* printHelp;
  if (!(yield* stdio.stdinIsTerminal)) {
    return yield* new CliFailure({
      message:
        "The TUI needs an interactive terminal. Use `infrawrench accounts --json` for scripts.",
    });
  }
  const services = yield* Effect.context<CloudApi>();
  const runner: TuiRunner = (effect) => Effect.runPromiseWith(services)(effect);
  yield* Effect.promise(() => runTui(runner));
});

export const tui = Command.make("tui", {}, () => home).pipe(
  Command.withDescription(
    "Interactive dashboard (cute charts included); the root help off a terminal",
  ),
);

export const help = Command.make(
  "help",
  {
    // `help <command>` has always printed the whole list; `<command> --help`
    // is the one that prints a command's own help.
    topic: Argument.String("command").pipe(
      Argument.withDescription("Ignored: the full list is printed either way"),
      Argument.variadic(),
    ),
  },
  () => printHelp,
).pipe(Command.withDescription("Show this help"));
