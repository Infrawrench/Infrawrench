import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseCommandLine } from "../args";
import { configPath, writeStored } from "../config";
import { delegatedArgv, findOnPath, route } from "../delegate";
import { cleanupTempDirs, gitInit, isolateGit, runCli, tempDir } from "./harness";

beforeAll(isolateGit);
afterAll(cleanupTempDirs);

/** A stand-in `infrawrench` that records its arguments and exits 3. */
function fakeDesktopCli(): { bin: string; log: string } {
  const bin = tempDir("infraenv-bin-");
  const log = join(bin, "args.txt");
  const script = join(bin, "infrawrench");
  writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$@" > '${log}'\nexit 3\n`);
  chmodSync(script, 0o755);
  return { bin, log };
}

describe("route", () => {
  it("runs here with a key, hands over without one when the desktop CLI is there, else fails", () => {
    expect(route(true, "/usr/local/bin/infrawrench")).toEqual({ kind: "self" });
    expect(route(false, "/usr/local/bin/infrawrench")).toEqual({
      kind: "delegate",
      executable: "/usr/local/bin/infrawrench",
    });
    expect(route(false, null)).toEqual({ kind: "none" });
  });
});

describe("delegatedArgv", () => {
  it("passes the same flags to `infrawrench env`", () => {
    const args = parseCommandLine([
      "pull",
      "-e",
      "production",
      "-f",
      "apps/web/.infraenv",
      "--var",
      "stage=prod",
      "--force",
      "-q",
      "--org",
      "abcd1234",
    ]);
    expect(delegatedArgv("pull", args)).toEqual([
      "env",
      "pull",
      "--env",
      "production",
      "--file",
      "apps/web/.infraenv",
      "--var",
      "stage=prod",
      "--force",
      "--quiet",
      "--org",
      "abcd1234",
    ]);
    expect(delegatedArgv("check", parseCommandLine(["check", "--json"]))).toEqual([
      "env",
      "check",
      "--json",
    ]);
  });
});

describe("findOnPath", () => {
  it("finds an executable and ignores a file that is not one", () => {
    const { bin } = fakeDesktopCli();
    expect(findOnPath("infrawrench", { env: { PATH: bin }, platform: "linux" })).toBe(
      join(bin, "infrawrench"),
    );
    const plain = tempDir();
    writeFileSync(join(plain, "infrawrench"), "not executable");
    expect(findOnPath("infrawrench", { env: { PATH: plain }, platform: "linux" })).toBeNull();
  });
});

describe("pull without a key", () => {
  it("runs the desktop CLI with the same flags, says so once, and returns its exit code", async () => {
    const { bin, log } = fakeDesktopCli();
    const root = gitInit();
    const result = await runCli(["pull", "-e", "production"], {
      cwd: root,
      env: { PATH: `${bin}:${process.env.PATH ?? ""}` },
    });
    expect(result.code).toBe(3);
    expect(result.err).toBe(
      "infraenv: no API key; running `infrawrench env pull` from the desktop app instead.\n",
    );
    expect(readFileSync(log, "utf8")).toBe("env\npull\n--env\nproduction\n");
  });

  it("stays quiet about it with --quiet, as in a git hook", async () => {
    const { bin } = fakeDesktopCli();
    const result = await runCli(["check", "-f", "x/.infraenv"], {
      cwd: gitInit(),
      env: { PATH: bin },
    });
    expect(result.code).toBe(3);
    const quiet = await runCli(["pull", "-q"], { cwd: gitInit(), env: { PATH: bin } });
    expect(quiet.err).toBe("");
    expect(result.err).toContain("infrawrench env check");
  });

  it("never hands over when a stored key exists", async () => {
    const { bin, log } = fakeDesktopCli();
    const home = tempDir();
    writeStored(configPath({ env: {}, home, platform: process.platform }), {
      apiKey: "iwk_fake_test_key",
      orgId: "abcd1234",
      baseUrl: "http://127.0.0.1:9",
    });
    const result = await runCli(["pull"], { cwd: gitInit(), env: { PATH: bin }, home });
    // No .infraenv: it failed on its own, without running the desktop CLI.
    expect(result.err).toContain("No .infraenv here");
    expect(() => readFileSync(log)).toThrow();
  });
});
