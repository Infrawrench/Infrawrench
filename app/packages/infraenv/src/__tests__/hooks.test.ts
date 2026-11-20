import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { INFRAENV_HOOKS, INFRAENV_HOOK_BEGIN, infraenvHookBlock } from "@infrawrench/client-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installSkipReason } from "../commands/hooks";
import { cleanupTempDirs, gitInit, isolateGit, runCli, tempDir } from "./harness";

beforeAll(isolateGit);
afterAll(cleanupTempDirs);

const hook = (root: string, name: string) => join(root, ".git", "hooks", name);
const executable = (path: string) => (statSync(path).mode & 0o111) === 0o111;

describe("infraenv install", () => {
  it("installs every hook, executable, with client-core's block, before .infraenv exists", async () => {
    const root = gitInit();
    const result = await runCli(["install"], { cwd: root });
    expect(result.code).toBe(0);
    for (const name of INFRAENV_HOOKS) {
      const path = hook(root, name);
      expect(executable(path)).toBe(true);
      expect(readFileSync(path, "utf8")).toBe(
        `#!/bin/sh\n${infraenvHookBlock(name, { file: ".infraenv", output: ".env" })}\n`,
      );
    }
    expect(result.out).toContain("post-checkout  installed");

    const again = await runCli(["install"], { cwd: root });
    expect(again.out).toContain("post-checkout  already installed");
  });

  it("watches the nearest file and its output setting, relative to the repository root", async () => {
    const root = gitInit();
    mkdirSync(join(root, "apps", "web", "src"), { recursive: true });
    writeFileSync(
      join(root, "apps", "web", ".infraenv"),
      "[infrawrench]\noutput = .env.local\n\n[env]\nA = 1\n",
    );
    const result = await runCli(["install", "--json"], { cwd: join(root, "apps", "web", "src") });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({
      infraenv: "apps/web/.infraenv",
      output: "apps/web/.env.local",
    });
    expect(readFileSync(hook(root, "post-merge"), "utf8")).toContain(
      infraenvHookBlock("post-merge", {
        file: "apps/web/.infraenv",
        output: "apps/web/.env.local",
      }),
    );
  });

  it("appends to a shell hook someone else wrote and skips one in another language", async () => {
    const root = gitInit();
    mkdirSync(join(root, ".git", "hooks"), { recursive: true });
    const theirs = "#!/bin/bash\necho theirs\n";
    writeFileSync(hook(root, "post-merge"), theirs, { mode: 0o755 });
    const python = "#!/usr/bin/env python3\nprint('x')\n";
    writeFileSync(hook(root, "post-commit"), python, { mode: 0o755 });

    const result = await runCli(["install"], { cwd: root });
    expect(result.code).toBe(0);
    expect(result.out).toContain("post-merge     added to the existing hook");
    expect(result.out).toMatch(/post-commit {4}skipped: it runs under \/usr\/bin\/env python3/);
    expect(readFileSync(hook(root, "post-merge"), "utf8").startsWith(theirs)).toBe(true);
    expect(readFileSync(hook(root, "post-commit"), "utf8")).toBe(python);

    const status = await runCli(["status"], { cwd: root });
    expect(status.out).toContain("post-merge     installed (inside an existing hook)");
    expect(status.out).toContain("post-commit    not installed (another hook is there)");
    expect(status.out).toContain("post-checkout  installed");

    const removed = await runCli(["uninstall"], { cwd: root });
    expect(removed.code).toBe(0);
    expect(readFileSync(hook(root, "post-merge"), "utf8")).toBe(theirs);
    expect(readFileSync(hook(root, "post-commit"), "utf8")).toBe(python);
    expect(existsSync(hook(root, "post-checkout"))).toBe(false);
    expect(removed.out).toContain("post-merge     removed from the existing hook");
  });

  it("honours core.hooksPath", async () => {
    const root = gitInit();
    execFileSync("git", ["config", "core.hooksPath", ".githooks"], { cwd: root });
    const result = await runCli(["install"], { cwd: root });
    expect(result.code).toBe(0);
    expect(readFileSync(join(root, ".githooks", "post-checkout"), "utf8")).toContain(
      INFRAENV_HOOK_BEGIN,
    );
    expect(existsSync(hook(root, "post-checkout"))).toBe(false);
  });

  it("does nothing, successfully, in CI, when asked to skip, or outside a repository", async () => {
    const root = gitInit();
    for (const env of [{ CI: "true" }, { INFRAENV_SKIP_INSTALL: "1" }]) {
      const result = await runCli(["install"], { cwd: root, env });
      expect(result.code).toBe(0);
      expect(result.out).toMatch(/git hooks not installed/);
    }
    expect(existsSync(hook(root, "post-checkout"))).toBe(false);

    const outside = await runCli(["install"], { cwd: tempDir() });
    expect(outside.code).toBe(0);
    expect(outside.out).toContain("not inside a Git repository");
  });

  it("reads CI and INFRAENV_SKIP_INSTALL as off when 0 or false", () => {
    expect(installSkipReason({ CI: "false" })).toBeNull();
    expect(installSkipReason({ CI: "0", INFRAENV_SKIP_INSTALL: "false" })).toBeNull();
    expect(installSkipReason({ CI: "1" })).toBe("CI is set");
  });

  it("refuses a file outside the repository", async () => {
    const root = gitInit();
    const elsewhere = join(tempDir(), ".infraenv");
    writeFileSync(elsewhere, "[env]\n");
    const result = await runCli(["install", "-f", elsewhere], { cwd: root });
    expect(result.code).toBe(1);
    expect(result.err).toContain("is outside this repository");
  });
});

describe("infraenv uninstall and status", () => {
  it("fail outside a repository", async () => {
    const dir = tempDir();
    expect((await runCli(["status"], { cwd: dir })).code).toBe(1);
    expect((await runCli(["uninstall"], { cwd: dir })).code).toBe(1);
  });
});
