// The shared hook block (client-core infraenv-hooks.ts) run by a real sh in a
// real repository: client-core typechecks without Node, so this lives here.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { INFRAENV_HOOKS, infraenvHookBlock, withInfraenvHook } from "@infrawrench/client-core";

const opts = { file: ".infraenv", output: ".env" };

describe("hook block syntax", () => {
  it("is valid sh for every hook", () => {
    for (const hook of INFRAENV_HOOKS) {
      execFileSync("sh", ["-n", "-c", infraenvHookBlock(hook, opts)]);
    }
  });
});

describe("hook behaviour in a real repository", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
      },
    }).toString();

  it("pulls only when the commit changes .infraenv or the output is missing", () => {
    dir = mkdtempSync(join(tmpdir(), "infraenv-hooks-"));
    git("init", "-q", "-b", "main");
    // A fake `infraenv` that records each call; the block prefers node_modules/.bin.
    execFileSync("mkdir", ["-p", join(dir, "node_modules/.bin")]);
    const fake = join(dir, "node_modules/.bin/infraenv");
    writeFileSync(
      fake,
      `#!/bin/sh\necho "$@" >> "${join(dir, "calls")}"\ntouch "${join(dir, ".env")}"\n`,
    );
    chmodSync(fake, 0o755);
    writeFileSync(join(dir, ".gitignore"), "node_modules\n.env\ncalls\n");
    const hook = join(dir, ".git/hooks/post-commit");
    writeFileSync(hook, withInfraenvHook(null, infraenvHookBlock("post-commit", opts)).text);
    chmodSync(hook, 0o755);
    const calls = () =>
      existsSync(join(dir, "calls"))
        ? readFileSync(join(dir, "calls"), "utf8").trim().split("\n")
        : [];
    const env = { ...process.env, INFRAENV_HOOK_FOREGROUND: "1" };
    const commit = (msg: string) =>
      execFileSync("git", ["commit", "-q", "-m", msg], {
        cwd: dir,
        env: {
          ...env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@example.com",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@example.com",
        },
      });

    writeFileSync(join(dir, ".infraenv"), "[env]\nA = 1\n");
    git("add", ".");
    commit("first");
    expect(calls()).toEqual(["pull --quiet -f .infraenv"]);

    writeFileSync(join(dir, "README"), "x");
    git("add", "README");
    commit("unrelated");
    expect(calls()).toHaveLength(1);

    writeFileSync(join(dir, ".infraenv"), "[env]\nA = 2\n");
    git("add", ".infraenv");
    commit("changed");
    expect(calls()).toHaveLength(2);

    rmSync(join(dir, ".env"));
    writeFileSync(join(dir, "README"), "y");
    git("add", "README");
    commit("output missing");
    expect(calls()).toHaveLength(3);
  });
});
