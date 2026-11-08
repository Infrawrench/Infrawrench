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
// deploy that would otherwise hang forever in CI should fail loudly, which is
// what `--set key=value` and `-y` exist to prevent in the first place.
// Ctrl-C (and Esc in a picker) is `Canceled`, exit 130.
import { Effect, Option, Queue, Stdio, Terminal } from "effect";
import { c, colorIsEnabled } from "../output";
import { Canceled, CliUsageError } from "./errors";

const ESC = "\u001b";
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const CLEAR_LINE = `${ESC}[2K`;

/** Text to the terminal. The platform layer's `display` cannot fail; a broken stdout is a defect. */
const show = (text: string) =>
  Terminal.Terminal.use((terminal) => Effect.orDie(terminal.display(text)));

const requireTty = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  if (!(yield* stdio.stdinIsTerminal) || !(yield* stdio.stdoutIsTerminal)) {
    return yield* new CliUsageError({
      message:
        "This deploy needs an answer but the terminal is not interactive. " +
        "Pass --set <key>=<value> to answer without prompting.",
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

export interface SelectOption {
  readonly label: string;
  readonly value: string;
  /** Display-only decoration beside the label (a region's "🇺🇸 Iowa, USA"). */
  readonly hint?: string;
}

/**
 * Arrow-key (or j/k) list picker, answering the chosen option's value. Esc
 * cancels: a deploy should stop rather than proceed on a guess.
 *
 * Long lists (every GCP region) are WINDOWED to the terminal height: the
 * in-place repaint walks the cursor back up over the previous render, which
 * cannot cross the top of the screen; painting more rows than the viewport
 * holds smears the list and scrolls the question away. The title and help
 * line live inside the repainted block, so they stay pinned at the top, with
 * "↑/↓ n more" markers standing in for what is off-window.
 */
export const selectOne = Effect.fnUntraced(function* (
  message: string,
  options: ReadonlyArray<SelectOption>,
) {
  if (options.length === 0) {
    return yield* new CliUsageError({ message: `${message}: nothing to choose from.` });
  }
  if (options.length === 1) {
    yield* show(
      `${c.bold(message)} ${c.dim("→")} ${options[0]!.label} ${c.dim("(only option)")}\n`,
    );
    return options[0]!.value;
  }
  yield* requireTty;
  const terminal = yield* Terminal.Terminal;

  let index = 0;
  let offset = 0;
  let painted = 0;

  const paint = Effect.gen(function* () {
    // Title + help + two scroll markers = 4 rows of chrome; one spare row keeps
    // the block strictly inside the viewport so the cursor-up repaint holds.
    const size = Math.max(3, Math.min(options.length, ((yield* terminal.rows) || 24) - 5));
    let text = painted > 0 ? `${ESC}[${painted}A` : "";
    if (index < offset) offset = index;
    if (index >= offset + size) offset = index - size + 1;
    if (offset > options.length - size) offset = Math.max(0, options.length - size);

    const lines: string[] = [c.bold(message), c.dim("  ↑/↓ to move, ↵ to choose")];
    // Marker rows render even when empty so the block height never shifts
    // between repaints: a varying height would desync the cursor-up walk.
    lines.push(offset > 0 ? c.dim(`  ↑ ${offset} more`) : "");
    for (let i = offset; i < Math.min(offset + size, options.length); i++) {
      const o = options[i]!;
      const hint = o.hint ? `  ${c.dim(o.hint)}` : "";
      lines.push(
        i === index ? `${c.cyan("❯")} ${c.bold(o.label)}${hint}` : `  ${c.dim(o.label)}${hint}`,
      );
    }
    const below = options.length - (offset + size);
    lines.push(below > 0 ? c.dim(`  ↓ ${below} more`) : "");

    for (const line of lines) text += `${CLEAR_LINE}${line}\n`;
    painted = lines.length;
    yield* show(text);
  });

  yield* paint;
  yield* readKeys((input) => {
    const name = input.key.name;
    if (name === "up" || name === "k") {
      index = (index - 1 + options.length) % options.length;
      return paint.pipe(Effect.as<KeyStep>("continue"));
    }
    if (name === "down" || name === "j") {
      index = (index + 1) % options.length;
      return paint.pipe(Effect.as<KeyStep>("continue"));
    }
    if (isEnter(input)) return Effect.succeed<KeyStep>("done");
    if (name === "escape") return Effect.fail(new Canceled());
    return Effect.succeed<KeyStep>("continue");
  });

  // Collapse the whole picker to its one-line answer, like a form field.
  if (painted > 0) {
    yield* show(`${ESC}[${painted}A${`${CLEAR_LINE}\n`.repeat(painted)}${ESC}[${painted}A`);
  }
  yield* show(`${c.bold(message)} ${c.dim("→")} ${options[index]!.label}\n`);
  return options[index]!.value;
});

/**
 * Single-line text input, drawn like a form field: a dim `›` separator, the
 * editable value, and an inverse-video caret standing in for the terminal
 * cursor (`readKeys` hides the real one). Enter submits; the line then
 * collapses to the same `label → value` form an answered select leaves behind.
 */
export const askText = Effect.fnUntraced(function* (message: string, defaultValue = "") {
  yield* requireTty;
  let value = defaultValue;

  const caret = colorIsEnabled() ? `${ESC}[7m ${ESC}[27m` : "_";
  const paint = Effect.suspend(() =>
    show(`\r${CLEAR_LINE}${c.bold(message)} ${c.dim("›")} ${value}${caret}`),
  );
  yield* paint;

  yield* readKeys((input) => {
    if (isEnter(input)) return Effect.succeed<KeyStep>("done");
    if (input.key.name === "backspace") {
      value = value.slice(0, -1);
      return paint.pipe(Effect.as<KeyStep>("continue"));
    }
    // Ignore escape sequences (arrows, function keys) and control characters.
    const typed = Option.getOrElse(input.input, () => "");
    if (input.key.ctrl || input.key.meta || typed.startsWith(ESC) || typed < " ") {
      return Effect.succeed<KeyStep>("continue");
    }
    value += typed;
    return paint.pipe(Effect.as<KeyStep>("continue"));
  });

  yield* show(`\r${CLEAR_LINE}${c.bold(message)} ${c.dim("→")} ${value}\n`);
  return value;
});

/** Yes/no confirmation. Defaults to no: a stray Enter must not deploy. */
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
