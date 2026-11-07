import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGitPort } from "../watch/git.js";

// Each test runs dozens of real git processes, and `pnpm test` runs next to everything else.
vi.setConfig({ testTimeout: 60_000 });

let base: string;
let work: string;
let remote: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.test",
      "-c",
      "init.defaultBranch=main",
      ...args,
    ],
    { cwd, encoding: "utf8" },
  ).trim();
}

function commitFile(file: string, text: string): string {
  fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
  fs.writeFileSync(path.join(work, file), text);
  git(work, "add", file);
  git(work, "commit", "-qm", `add ${file}`);
  git(work, "push", "-q", "origin", "main");
  return git(work, "rev-parse", "HEAD");
}

const GEN = "plugin/src/api-types.gen.ts";

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "plugingen-git-"));
  remote = path.join(base, "remote.git");
  work = path.join(base, "work");
  git(base, "init", "-q", "--bare", remote);
  git(base, "init", "-q", work);
  git(work, "remote", "add", "origin", `file://${remote}`);
  commitFile(GEN, "old\n");
});
afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

describe("createGitPort", () => {
  it("says when there is no branch", async () => {
    await expect(
      createGitPort(work).readBranchFiles("plugingen/x", [GEN]),
    ).resolves.toBeUndefined();
  });

  it("pushes one commit on HEAD without moving HEAD or the working tree", async () => {
    const port = createGitPort(work);
    const head = git(work, "rev-parse", "HEAD");
    await port.pushBranch("plugingen/x", new Map([[GEN, "new\n"]]), "subject\n\nbody");

    expect(git(work, "rev-parse", "HEAD")).toBe(head);
    expect(git(work, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(git(work, "status", "--porcelain")).toBe("");
    expect(fs.readFileSync(path.join(work, GEN), "utf8")).toBe("old\n");

    expect(git(remote, "show", `plugingen/x:${GEN}`)).toBe("new");
    expect(git(remote, "rev-parse", "plugingen/x^")).toBe(head);
    expect(git(remote, "log", "-1", "--format=%an%n%s", "plugingen/x")).toBe(
      "infrawrench-sdk-bot\nsubject",
    );
  });

  it("reads back what it pushed, and leaves out a file the branch does not have", async () => {
    const port = createGitPort(work);
    await port.pushBranch("plugingen/x", new Map([[GEN, "new\n"]]), "m");
    const files = await port.readBranchFiles("plugingen/x", [GEN, "plugin/src/absent.gen.ts"]);
    expect(files).toEqual(new Map([[GEN, "new\n"]]));
  });

  it("replaces the branch rather than stacking on it, and moves it to the new HEAD", async () => {
    const port = createGitPort(work);
    await port.pushBranch("plugingen/x", new Map([[GEN, "one\n"]]), "m");
    const head = commitFile("elsewhere.txt", "x");
    await port.pushBranch("plugingen/x", new Map([[GEN, "two\n"]]), "m");
    expect(git(remote, "rev-parse", "plugingen/x^")).toBe(head);
    expect(git(remote, "show", `plugingen/x:${GEN}`)).toBe("two");
    expect(git(remote, "rev-list", "--count", "main..plugingen/x")).toBe("1");
  });

  it("stays on the branch's old base when GitHub refuses the move over a workflow", async () => {
    const port = createGitPort(work);
    const oldBase = git(work, "rev-parse", "HEAD");
    await port.pushBranch("plugingen/x", new Map([[GEN, "one\n"]]), "m");
    commitFile(".github/workflows/ci.yml", "on: push\n");

    const hook = path.join(remote, "hooks/pre-receive");
    fs.writeFileSync(
      hook,
      `#!/bin/sh
read -r _old new _ref
if [ "$(git rev-parse "$new^")" != "${oldBase}" ]; then
  echo "refusing to allow a GitHub App to create or update workflow .github/workflows/ci.yml without workflows permission" >&2
  exit 1
fi
`,
      { mode: 0o755 },
    );

    await port.pushBranch("plugingen/x", new Map([[GEN, "two\n"]]), "m");
    expect(git(remote, "rev-parse", "plugingen/x^")).toBe(oldBase);
    expect(git(remote, "show", `plugingen/x:${GEN}`)).toBe("two");
  });

  it("pushes from a shallow clone, which is what the workflow has", async () => {
    commitFile("second.txt", "x");
    const shallow = path.join(base, "shallow");
    git(base, "clone", "-q", "--depth=1", `file://${remote}`, shallow);
    const port = createGitPort(shallow);
    await port.pushBranch("plugingen/x", new Map([[GEN, "one\n"]]), "m");
    await expect(port.readBranchFiles("plugingen/x", [GEN])).resolves.toEqual(
      new Map([[GEN, "one\n"]]),
    );
    await port.pushBranch("plugingen/x", new Map([[GEN, "two\n"]]), "m");
    expect(git(remote, "show", `plugingen/x:${GEN}`)).toBe("two");
  });

  it("reports any other push failure", async () => {
    const hook = path.join(remote, "hooks/pre-receive");
    fs.writeFileSync(hook, `#!/bin/sh\necho "remote: no thanks" >&2\nexit 1\n`, { mode: 0o755 });
    await expect(
      createGitPort(work).pushBranch("plugingen/x", new Map([[GEN, "x\n"]]), "m"),
    ).rejects.toThrow(/git push failed: .*no thanks/);
  });
});
