// Temporary: runs the same command line through a legacy copy of a command
// module and asserts the output, requests and exit code match what the
// effect/cli version just produced. Deleted with the `.legacy.ts` copies.
import { expect } from "vitest";
import { parseCliArgs, type ParsedCli } from "../cli/args";
import { CliError, type CliContext } from "../cli/context";
import { c, printErr } from "../cli/output";
import { run, type Captured } from "./cli-harness";

export type LegacyInvoke = (ctx: CliContext, parsed: ParsedCli, rest: string[]) => Promise<void>;

let last: { argv: string[]; code: number; from: number } | null = null;
let captured: Captured | null = null;

/** Tell {@link cli} which capture to read request counts from. */
export const compareWith = (out: Captured): void => {
  captured = out;
};

/** {@link run}, remembering the line and its exit code for {@link agrees}. */
export const cli = async (...argv: string[]): Promise<number> => {
  const from = captured?.requests.length ?? 0;
  const code = await run(...argv);
  last = { argv, code, from };
  return code;
};

/**
 * Replays the last {@link cli} line through `invoke` the way the legacy
 * switch did (parse, call, catch `CliError` into one red line) and expects
 * the same stdout, stderr, requests and exit code. Restores the capture.
 */
export async function agrees(
  out: Captured,
  invoke: LegacyInvoke,
  opts: { stderr?: boolean } = {},
): Promise<void> {
  if (!last) throw new Error("no cli() run to compare");
  const next = { stdout: out.stdout, stderr: out.stderr, requests: [...out.requests] };
  const own = next.requests.slice(last.from);
  out.stdout = "";
  out.stderr = "";
  out.requests = [];
  let code = 0;
  const parsed = parseCliArgs(last.argv);
  const ctx: CliContext = {
    flags: parsed.flags,
    positionals: parsed.positionals,
    guiRunning: false,
  };
  const before = process.exitCode;
  try {
    await invoke(ctx, parsed, parsed.positionals.slice(1));
    code = typeof process.exitCode === "number" ? process.exitCode : 0;
  } catch (e) {
    if (!(e instanceof CliError)) throw e;
    printErr(c.red(e.message));
    code = e.exitCode;
  }
  process.exitCode = before;
  const old = { stdout: out.stdout, stderr: out.stderr, requests: [...out.requests] };
  expect(next.stdout).toBe(old.stdout);
  if (opts.stderr !== false) expect(next.stderr).toBe(old.stderr);
  expect(own).toEqual(old.requests);
  expect(last.code).toBe(code);
  out.stdout = next.stdout;
  out.stderr = next.stderr;
  out.requests = next.requests;
}
