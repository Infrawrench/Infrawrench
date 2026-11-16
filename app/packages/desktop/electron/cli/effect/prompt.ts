// Interactive prompts for the CLI, as Effects over the platform layer's
// `Terminal` (keys from `readInput`, drawing with `display`) and `Stdio`
// (whether there is a terminal to ask at all).
//
// The TUI (`../tui.ts`) takes over the whole screen; this is the small inline
// equivalent for one question mid-command: no alternate screen and no
// dependency (`ink`/`inquirer` would break the CLI's zero-runtime-dependency
// rule), just enough to answer a prompt and move on. `effect/cli`'s own
// `Prompt` module draws differently; these keep the look the CLI has always
// had.
//
// Every prompt refuses when stdin or stdout is not a terminal (exit 2): a
// command that would otherwise hang forever in CI should fail loudly, which is
// what `-y` exists to prevent in the first place. Ctrl-C is `Canceled`, exit
// 130.
import { Effect, Queue, Stdio, Terminal } from "effect";
import { c } from "../output";
import { Canceled, CliUsageError } from "./errors";

const ESC = "\u001b";
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;

/** Text to the terminal. The platform layer's `display` cannot fail; a broken stdout is a defect. */
const show = (text: string) =>
  Terminal.Terminal.use((terminal) => Effect.orDie(terminal.display(text)));

const requireTty = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  if (!(yield* stdio.stdinIsTerminal) || !(yield* stdio.stdoutIsTerminal)) {
    return yield* new CliUsageError({
      message:
        "This command needs an answer but the terminal is not interactive. " +
        "Pass -y to answer without prompting.",
    });
  }
});

/** One key: what `handle` answers decides whether the prompt is done. */
type KeyStep = "continue" | "done";

const isCtrlC = (input: Terminal.UserInput) => input.key.ctrl && input.key.name === "c";
const isEnter = (input: Terminal.UserInput) =>
  input.key.name === "return" || input.key.name === "enter";

/**
 * Read keys until `handle` says the prompt is done. The cursor is hidden
 * meanwhile and raw mode is on (both restored on every path, interruption
 * included); Ctrl-C always cancels rather than resolving the prompt with
 * whatever was selected.
 */
const readKeys = <E, R>(handle: (input: Terminal.UserInput) => Effect.Effect<KeyStep, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const terminal = yield* Terminal.Terminal;
      yield* Effect.acquireRelease(show(HIDE_CURSOR), () => show(SHOW_CURSOR));
      const keys = yield* terminal.readInput;
      for (;;) {
        // The queue only ends when the scope closes, which is after this loop.
        const input = yield* Queue.take(keys).pipe(Effect.orDie);
        if (isCtrlC(input)) return yield* new Canceled();
        if ((yield* handle(input)) === "done") return;
      }
    }),
  );

/** Yes/no confirmation. Defaults to no: a stray Enter must not say yes. */
export const confirm = Effect.fnUntraced(function* (message: string) {
  yield* requireTty;
  yield* show(`${c.bold(message)} ${c.dim("[y/N]")} `);
  let answer = false;
  yield* readKeys((input) => {
    const name = input.key.name;
    if (name === "y") {
      answer = true;
      return Effect.succeed<KeyStep>("done");
    }
    if (name === "n" || isEnter(input) || name === "escape") {
      answer = false;
      return Effect.succeed<KeyStep>("done");
    }
    return Effect.succeed<KeyStep>("continue");
  });
  yield* show(`${answer ? "yes" : "no"}\n`);
  return answer;
});
