/**
 * What a command reads of the process, passed in rather than reached for, so
 * the tests run every command in-process against a temporary directory and a
 * mock server without touching the real environment, home or terminal.
 */
import { homedir } from "node:os";

export interface Io {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  readonly platform: NodeJS.Platform;
  /** Standard output and error, written as given (no newline added). */
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  /** Standard input, for `login`. */
  readonly stdin: NodeJS.ReadStream;
  /** ANSI colour on standard output (a TTY, no NO_COLOR, no --no-color). */
  readonly color: boolean;
  /** ANSI colour on standard error. */
  readonly errColor: boolean;
}

export function processIo(noColor: boolean): Io {
  const env = process.env;
  const colorAllowed = !noColor && !env.NO_COLOR && env.TERM !== "dumb";
  return {
    cwd: process.cwd(),
    env,
    home: homedir(),
    platform: process.platform,
    out: (text) => void process.stdout.write(text),
    err: (text) => void process.stderr.write(text),
    stdin: process.stdin,
    color: colorAllowed && process.stdout.isTTY === true,
    errColor: colorAllowed && process.stderr.isTTY === true,
  };
}

/** A failure the person can act on: one sentence, printed after `infraenv: `. */
export class Failure extends Error {
  constructor(
    message: string,
    readonly exitCode: number = 1,
  ) {
    super(message);
    this.name = "Failure";
  }
}

/** A command line that does not parse: exit code 2, with a pointer to `--help`. */
export class UsageError extends Failure {
  constructor(message: string) {
    super(message, 2);
    this.name = "UsageError";
  }
}

/** Ends a command with an exit code after it has printed everything it meant to. */
export class Exit extends Error {
  constructor(readonly exitCode: number) {
    super(`exit ${exitCode}`);
    this.name = "Exit";
  }
}

// Text from the server (names, messages) can hold anything; never let it move
// the cursor or change the terminal's colours.
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

export function safe(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  return value.replace(CONTROL_CHARACTERS, "");
}

export interface Paint {
  bold(s: string): string;
  dim(s: string): string;
  red(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
}

export function paint(enabled: boolean): Paint {
  const wrap = (open: number, close: number) => (s: string) =>
    enabled ? `\u001B[${open}m${s}\u001B[${close}m` : s;
  return {
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    red: wrap(31, 39),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
  };
}

/** Line printers over an `Io`, with the colours each stream allows. */
export function printer(io: Io) {
  return {
    c: paint(io.color),
    ec: paint(io.errColor),
    line: (text = "") => io.out(`${text}\n`),
    errLine: (text = "") => io.err(`${text}\n`),
    json: (value: unknown) => io.out(`${JSON.stringify(value, null, 2)}\n`),
  };
}
export type Printer = ReturnType<typeof printer>;

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
