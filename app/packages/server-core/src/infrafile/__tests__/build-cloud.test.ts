import { describe, expect, it } from "vitest";

import { __parseWrappedOutputForTests as parse } from "../build-cloud";

/**
 * Cloud Build gives one interleaved log and a pass/fail verdict, so `run()`'s
 * real streams and exit code are recovered from markers the wrapper prints.
 * The parsing is where that can go quietly wrong, so it is tested directly.
 */
const N = "abc123";

function log(lines: string[]): string {
  // Cloud Build prefixes every line of step output with its step number.
  return lines.map((l) => `Step #0: ${l}`).join("\n");
}

describe("parseWrappedOutput", () => {
  it("separates stdout from stderr and reads the real exit code", () => {
    const raw = log([
      "starting build",
      `__IW_OUT_${N}__`,
      "hello",
      "world",
      `__IW_ERR_${N}__`,
      "a warning",
      `__IW_EXIT_${N}__7`,
    ]);
    expect(parse(raw, N)).toEqual({ exitCode: 7, stdout: "hello\nworld", stderr: "a warning" });
  });

  it("keeps output that looks like Cloud Build's own chatter", () => {
    // The bug this replaced: a regex filter deleted any line starting with
    // DONE / BUILD / PUSH, silently corrupting the command's own output.
    const raw = log([
      `__IW_OUT_${N}__`,
      "BUILD succeeded",
      "DONE deploying",
      "PUSH complete",
      `__IW_ERR_${N}__`,
      `__IW_EXIT_${N}__0`,
    ]);
    expect(parse(raw, N)?.stdout).toBe("BUILD succeeded\nDONE deploying\nPUSH complete");
  });

  it("reports success as zero", () => {
    const raw = log([`__IW_OUT_${N}__`, "ok", `__IW_ERR_${N}__`, `__IW_EXIT_${N}__0`]);
    expect(parse(raw, N)?.exitCode).toBe(0);
  });

  it("handles empty streams", () => {
    const raw = log([`__IW_OUT_${N}__`, `__IW_ERR_${N}__`, `__IW_EXIT_${N}__0`]);
    expect(parse(raw, N)).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });

  it("returns null when the step died before reporting", () => {
    // No markers — the caller then falls back to the build's own verdict
    // rather than inventing an exit code.
    expect(parse(log(["container failed to start"]), N)).toBeNull();
  });

  it("returns null on a truncated log rather than guessing", () => {
    const raw = log([`__IW_OUT_${N}__`, "partial output"]);
    expect(parse(raw, N)).toBeNull();
  });

  it("is not fooled by the command printing a marker for a different nonce", () => {
    const raw = log([
      `__IW_OUT_${N}__`,
      "__IW_EXIT_deadbeef__0",
      `__IW_ERR_${N}__`,
      `__IW_EXIT_${N}__3`,
    ]);
    const result = parse(raw, N);
    expect(result?.exitCode).toBe(3);
    expect(result?.stdout).toBe("__IW_EXIT_deadbeef__0");
  });

  it("falls back to a failure code when the exit marker is unreadable", () => {
    const raw = log([`__IW_OUT_${N}__`, "x", `__IW_ERR_${N}__`, `__IW_EXIT_${N}__notanumber`]);
    expect(parse(raw, N)?.exitCode).toBe(1);
  });
});
