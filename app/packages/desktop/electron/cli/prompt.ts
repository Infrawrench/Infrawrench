/**
 * Interactive terminal prompts for the CLI.
 *
 * The TUI (`tui.ts`) already hand-rolls raw-mode key handling, but its helpers
 * are closures inside `runTui` and it takes over the whole screen — no use for
 * a single question mid-deploy. This is the small, inline equivalent: no
 * alternate screen, no dependencies (`ink`/`inquirer` would violate the CLI's
 * zero-runtime-dep rule), just enough to answer one prompt and move on.
 *
 * Every function refuses when stdin is not a TTY. A deploy that would otherwise
 * hang forever in CI should fail loudly instead — which is what
 * `--set key=value` exists to prevent in the first place.
 */
import { CliError } from "./context";
import { c, println } from "./output";

const ESC = "\u001b";
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const CLEAR_LINE = `${ESC}[2K`;

const KEY_CTRL_C = "\u0003";
const KEY_ESC = ESC;
const KEY_UP = `${ESC}[A`;
const KEY_DOWN = `${ESC}[B`;
const KEY_BACKSPACE = "\u007f";

function requireTty(): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new CliError(
      "This deploy needs an answer but the terminal is not interactive. " +
        "Pass --set <key>=<value> to answer without prompting.",
      2,
    );
  }
}

/**
 * Read keypresses until `handle` says it is done. Restores raw mode and the
 * cursor on every path, including Ctrl-C — which must still abort rather than
 * silently resolve the prompt with whatever was selected.
 */
function readKeys(handle: (key: string) => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode?.(true);
    stdin.resume();
    process.stdout.write(HIDE_CURSOR);

    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode?.(wasRaw ?? false);
      stdin.pause();
      process.stdout.write(SHOW_CURSOR);
    };

    function onData(data: Buffer) {
      const key = data.toString("utf8");
      if (key === KEY_CTRL_C) {
        cleanup();
        reject(new CliError("Canceled.", 130));
        return;
      }
      let done = false;
      try {
        done = handle(key);
      } catch (err) {
        cleanup();
        reject(err);
        return;
      }
      if (done) {
        cleanup();
        resolve();
      }
    }

    stdin.on("data", onData);
  });
}

export interface SelectOption {
  label: string;
  value: string;
}

/**
 * Arrow-key (or j/k) list picker. Returns the chosen option's value, or throws
 * if the user escapes — a deploy should stop rather than proceed on a guess.
 */
export async function selectOne(message: string, options: SelectOption[]): Promise<string> {
  if (options.length === 0) throw new CliError(`${message}: nothing to choose from.`, 2);
  if (options.length === 1) {
    println(`${c.bold(message)} ${c.dim("→")} ${options[0]!.label} ${c.dim("(only option)")}`);
    return options[0]!.value;
  }
  requireTty();

  let index = 0;
  let painted = 0;

  const paint = () => {
    // Redraw in place: jump back over the previous render, then rewrite.
    if (painted > 0) process.stdout.write(`${ESC}[${painted}A`);
    const lines = options.map((o, i) =>
      i === index ? `${c.cyan("❯")} ${c.bold(o.label)}` : `  ${c.dim(o.label)}`,
    );
    for (const line of lines) process.stdout.write(`${CLEAR_LINE}${line}\n`);
    painted = lines.length;
  };

  println(c.bold(message));
  println(c.dim("  ↑/↓ to move, ↵ to choose"));
  paint();

  await readKeys((key) => {
    if (key === KEY_UP || key === "k") {
      index = (index - 1 + options.length) % options.length;
      paint();
      return false;
    }
    if (key === KEY_DOWN || key === "j") {
      index = (index + 1) % options.length;
      paint();
      return false;
    }
    if (key === "\r" || key === "\n") return true;
    if (key === KEY_ESC) throw new CliError("Canceled.", 130);
    return false;
  });

  println(`${c.dim("→")} ${options[index]!.label}`);
  return options[index]!.value;
}

/** Single-line text input. Supports backspace; Enter submits. */
export async function askText(message: string, defaultValue = ""): Promise<string> {
  requireTty();
  let value = defaultValue;

  const paint = () => {
    process.stdout.write(`\r${CLEAR_LINE}${c.bold(message)} ${value}`);
  };
  paint();

  await readKeys((key) => {
    if (key === "\r" || key === "\n") return true;
    if (key === KEY_BACKSPACE || key === "\b") {
      value = value.slice(0, -1);
      paint();
      return false;
    }
    // Ignore escape sequences (arrows, function keys) and control characters.
    if (key.startsWith(ESC) || key < " ") return false;
    value += key;
    paint();
    return false;
  });

  process.stdout.write("\n");
  return value;
}

/** Yes/no confirmation. Defaults to no — a stray Enter must not deploy. */
export async function confirm(message: string): Promise<boolean> {
  requireTty();
  process.stdout.write(`${c.bold(message)} ${c.dim("[y/N]")} `);
  let answer = false;
  await readKeys((key) => {
    if (key === "y" || key === "Y") {
      answer = true;
      return true;
    }
    if (key === "n" || key === "N" || key === "\r" || key === "\n" || key === KEY_ESC) {
      answer = false;
      return true;
    }
    return false;
  });
  process.stdout.write(`${answer ? "yes" : "no"}\n`);
  return answer;
}
