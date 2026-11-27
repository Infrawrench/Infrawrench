import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkWatcherBranch,
  forgeCredentials,
  forgeSettings,
  type ForgeSettings,
} from "../watch/forge.js";
import { createGitPort } from "../watch/git.js";

/** The `git` a shell finds on PATH, or null where there is none. */
function gitOnPath(): string | null {
  const found = spawnSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" });
  const where = found.status === 0 ? found.stdout.trim() : "";
  return where === "" ? null : where;
}

// Each test runs dozens of real git processes, and `pnpm test` runs next to everything else.
vi.setConfig({ testTimeout: 60_000 });

const hasGit = spawnSync("git", ["--version"]).status === 0;
if (!hasGit) console.warn("plugingen: no git binary on PATH, the forge push tests are skipped");

// Not shaped like a real token of anyone's, so no scanner minds it.
const TOKEN = "plugingen-test-credential-0123456789";
const GEN = "plugin/src/api-types.gen.ts";

let base: string;
let work: string;
let remote: string;
let settings: ForgeSettings;

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

const refs = (): string => git(remote, "for-each-ref", "--format=%(refname) %(objectname)");

/** The port the forge target builds, pointed at a bare repository instead of the forge. */
const forgePort = (root = work) =>
  createGitPort(root, `file://${remote}`, {
    credentials: forgeCredentials(settings),
    checkBranch: checkWatcherBranch,
    secrets: [TOKEN],
  });

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "plugingen-forge-git-"));
  vi.stubEnv("PLUGINGEN_FORGE_TOKEN", TOKEN);
  settings = forgeSettings({
    PLUGINGEN_FORGE_URL: "https://forge.test",
    PLUGINGEN_FORGE_REPOSITORY: "Acme/Mono",
    PLUGINGEN_FORGE_TOKEN: TOKEN,
  });
  if (!hasGit) return;
  remote = path.join(base, "remote.git");
  work = path.join(base, "work");
  const mirror = path.join(base, "mirror.git");
  git(base, "init", "-q", "--bare", remote);
  git(base, "init", "-q", "--bare", mirror);
  git(base, "init", "-q", work);
  // `origin` is where the checkout came from: on a runner, the mirror. Never the forge.
  git(work, "remote", "add", "origin", `file://${mirror}`);
  fs.mkdirSync(path.dirname(path.join(work, GEN)), { recursive: true });
  fs.writeFileSync(path.join(work, GEN), "old\n");
  git(work, "add", GEN);
  git(work, "commit", "-qm", "first");
  git(work, "push", "-q", "origin", "main");
  git(work, "push", "-q", `file://${remote}`, "main", "main:refs/heads/plugingen/other");
  git(work, "push", "-q", `file://${remote}`, "main:refs/heads/feature/x", "main:refs/tags/v1");
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(base, { recursive: true, force: true });
});

describe.skipIf(!hasGit)("the forge's git port against a real repository", () => {
  it("creates the one branch and leaves every other ref, the checkout and origin alone", async () => {
    const before = refs();
    const head = git(work, "rev-parse", "HEAD");
    const config = fs.readFileSync(path.join(work, ".git/config"), "utf8");
    const mirrorBefore = git(path.join(base, "mirror.git"), "for-each-ref");

    await forgePort().pushBranch("plugingen/acme", new Map([[GEN, "new\n"]]), "subject");

    const added = refs()
      .split("\n")
      .filter((line) => !before.split("\n").includes(line));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatch(/^refs\/heads\/plugingen\/acme [0-9a-f]{40}$/);
    expect(refs().split("\n")).toEqual(expect.arrayContaining(before.split("\n")));
    expect(git(remote, "show", `plugingen/acme:${GEN}`)).toBe("new");
    expect(git(remote, "rev-parse", "plugingen/acme^")).toBe(head);

    expect(git(work, "rev-parse", "HEAD")).toBe(head);
    expect(git(work, "status", "--porcelain")).toBe("");
    expect(fs.readFileSync(path.join(work, ".git/config"), "utf8")).toBe(config);
    expect(git(path.join(base, "mirror.git"), "for-each-ref")).toBe(mirrorBefore);
  });

  it("force-pushes over what was there, reads it back, and moves nothing else", async () => {
    const port = forgePort();
    await port.pushBranch("plugingen/acme", new Map([[GEN, "one\n"]]), "m");
    const others = refs()
      .split("\n")
      .filter((line) => !line.startsWith("refs/heads/plugingen/acme "));
    const first = git(remote, "rev-parse", "plugingen/acme");

    await port.pushBranch("plugingen/acme", new Map([[GEN, "two\n"]]), "m");

    expect(git(remote, "rev-parse", "plugingen/acme")).not.toBe(first);
    expect(git(remote, "rev-list", "--count", "main..plugingen/acme")).toBe("1");
    await expect(port.readBranchFiles("plugingen/acme", [GEN])).resolves.toEqual(
      new Map([[GEN, "two\n"]]),
    );
    expect(refs().split("\n")).toEqual(expect.arrayContaining(others));
    expect(refs().split("\n")).toHaveLength(others.length + 1);
  });

  it("deletes the one branch and nothing else, and does not mind one that is gone", async () => {
    const port = forgePort();
    const before = refs();
    await port.pushBranch("plugingen/acme", new Map([[GEN, "one\n"]]), "m");
    expect(refs()).not.toBe(before);

    await port.deleteBranch("plugingen/acme");
    expect(refs()).toBe(before);

    await expect(port.deleteBranch("plugingen/acme")).resolves.toBeUndefined();
    await expect(port.readBranchFiles("plugingen/acme", [GEN])).resolves.toBeUndefined();
    expect(refs()).toBe(before);
  });

  it("touches no branch that is not the watcher's, whatever it is asked", async () => {
    const port = forgePort();
    const before = refs();
    for (const branch of ["main", "feature/x", "plugingen/../main", "plugingen/a b", "v1"]) {
      await expect(port.deleteBranch(branch)).rejects.toThrow(/not a branch plugingen watch owns/);
      await expect(port.pushBranch(branch, new Map([[GEN, "x\n"]]), "m")).rejects.toThrow(
        /not a branch plugingen watch owns/,
      );
      await expect(port.readBranchFiles(branch, [GEN])).rejects.toThrow(/not a branch/);
    }
    expect(refs()).toBe(before);
  });

  // Watches every argument git is given through a wrapper on PATH, so it needs
  // a git that is a file on PATH. A CI sandbox's git is not (its shell cannot
  // find one), and there the test beside it, that git is handed the token
  // from the environment, is what holds.
  it.skipIf(gitOnPath() === null)("never puts the token on a command line", async () => {
    const real = gitOnPath()!;
    const bin = path.join(base, "bin");
    const log = path.join(base, "argv.log");
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, "git"),
      `#!/bin/sh\nfor arg in "$@"; do printf '%s\\n' "$arg" >> "${log}"; done\nexec "${real}" "$@"\n`,
      { mode: 0o755 },
    );
    vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env["PATH"]}`);

    const port = forgePort();
    await port.pushBranch("plugingen/acme", new Map([[GEN, "one\n"]]), "m");
    await port.readBranchFiles("plugingen/acme", [GEN]);
    await port.deleteBranch("plugingen/acme");

    const argv = fs.readFileSync(log, "utf8");
    expect(argv).not.toContain(TOKEN);
    expect(argv).toContain("credential.https://forge.test.helper=!f()");
    expect(argv).toContain(`file://${remote}\n:refs/heads/plugingen/acme\n`);
    expect(argv).toMatch(/push\n--force\nfile:\/\/.*\n[0-9a-f]{40}:refs\/heads\/plugingen\/acme\n/);
    // One refspec to a push, and it is always the watcher's branch.
    const refspecs = argv.split("\n").filter((arg) => /^[0-9a-f]*:refs\//.test(arg));
    expect(new Set(refspecs.map((spec) => spec.slice(spec.indexOf(":"))))).toEqual(
      new Set([":refs/heads/plugingen/acme"]),
    );
  });

  it("keeps the token out of an error, even if the remote prints it", async () => {
    fs.writeFileSync(
      path.join(remote, "hooks/pre-receive"),
      `#!/bin/sh\necho "remote: no thanks, ${TOKEN}" >&2\nexit 1\n`,
      { mode: 0o755 },
    );
    const failure = await forgePort()
      .pushBranch("plugingen/acme", new Map([[GEN, "x\n"]]), "m")
      .catch((error: unknown) => String(error));
    expect(failure).toMatch(/git push failed: .*no thanks, \*\*\*/);
    expect(failure).not.toContain(TOKEN);
  });

  describe("the credential helper", () => {
    const fill = (host: string) =>
      spawnSync("git", [...forgeCredentials(settings), "credential", "fill"], {
        cwd: work,
        input: `protocol=https\nhost=${host}\n\n`,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_ASKPASS: "false",
          SSH_ASKPASS: "false",
        },
      });

    it("hands git the token from the environment, for the forge", () => {
      const filled = fill("forge.test");
      expect(filled.status).toBe(0);
      expect(filled.stdout).toContain("username=x-access-token\n");
      expect(filled.stdout).toContain(`password=${TOKEN}\n`);
    });

    it("hands it to no other host", () => {
      for (const host of ["elsewhere.test", "forge.test.elsewhere.test", "github.com"]) {
        const filled = fill(host);
        expect(filled.status).not.toBe(0);
        expect(`${filled.stdout}${filled.stderr}`).not.toContain(TOKEN);
      }
    });
  });
});
