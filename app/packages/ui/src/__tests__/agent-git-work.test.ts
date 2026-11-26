import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "node:process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  GIT_WORK_PROMPT_FILE,
  GIT_WORK_PROMPT_SENT_FILE,
  GIT_WORK_TOKEN_ENV,
  GIT_WORK_TOKEN_FILE,
  buildAgentBootstrapCommand,
  buildAgentLaunchCommand,
  buildGitWorkCredentialCommand,
  buildGitWorkPrompt,
  buildGitWorkPromptWriteCommand,
} from "../agents/launch-command.js";

const ORIGIN = "https://git.example.test";
// Not a real token: the format's prefix and two base64url halves.
const TOKEN = "iwj_eyJ2IjoxfQ.c2lnbmF0dXJlLW5vdC1yZWFs";

const input = {
  owner: "acme",
  repo: "infra",
  pull: 7,
  branch: "work/fix-login",
  title: "Fix the login redirect",
  body: "Users land on `/` after signing in.\n\nKeep $HOME and `$(rm -rf /)` as text: 'quotes' \"too\".",
  pullUrl: `${ORIGIN}/acme/infra/pull/7`,
  forgeOrigin: `${ORIGIN}/`,
  sessionId: "6f9619ff-8b86-d011-b42d-00c04fc964ff",
};

function unwrap(command: string): string {
  const first = command.indexOf("'");
  const last = command.lastIndexOf("'");
  return command.slice(first + 1, last).replace(/'\\''/g, "'");
}

describe("the first prompt of a session working on a pull request", () => {
  const prompt = buildGitWorkPrompt(input);

  it("carries the ask as written, the branch and where reviewers read it", () => {
    expect(prompt).toContain("### Fix the login redirect");
    expect(prompt).toContain(input.body);
    expect(prompt).toContain("`git push origin work/fix-login`");
    expect(prompt).toContain(input.pullUrl);
    // A tool's CLI would read a leading dash as a flag.
    expect(prompt.startsWith("-")).toBe(false);
  });

  it("says how to record traces and read and answer instructions with the token", () => {
    const api = `${ORIGIN}/api/repos/acme/infra`;
    expect(prompt).toContain(`'${api}/traces'`);
    expect(prompt).toContain(`'${api}/pulls/7/instructions?status=queued'`);
    expect(prompt).toContain(
      `'${api}/pulls/7/instructions/<id>/delivered' --data '{"via":"infrawrench"}'`,
    );
    expect(prompt).toContain(`'${api}/pulls/7/instructions/<id>/answered' --data '{}'`);
    expect(prompt).toContain(`-H "Authorization: Bearer $${GIT_WORK_TOKEN_ENV}"`);
    expect(prompt).toMatch(/before you push/);
    expect(prompt).toMatch(/at most 6 hours/);
    // The trace body is JSON the forge's `TraceRecord` takes.
    const body = /--data '(\{"branch".*\})'/.exec(prompt)?.[1];
    expect(JSON.parse(body ?? "null")).toEqual({
      branch: "work/fix-login",
      agent: { kind: "infrawrench", name: "Infrawrench agent", sessionRef: input.sessionId },
      entries: [{ kind: "step", body: "What you did and why" }],
    });
  });

  it("still has an ask when the pull request has no description", () => {
    expect(buildGitWorkPrompt({ ...input, body: "  " })).toMatch(/the title is the ask/);
  });
});

describe("what a session working on a pull request starts with", () => {
  it("starts the tool once with the prompt file as one argument, and exports the token", () => {
    for (const tool of ["claude-code", "codex"] as const) {
      const script = unwrap(
        buildAgentLaunchCommand({ sessionId: input.sessionId, tool, workspaceName: "infra" }),
      );
      expect(script).toContain(
        `mv -f \\"\\$HOME/${GIT_WORK_PROMPT_FILE}\\" \\"\\$HOME/${GIT_WORK_PROMPT_SENT_FILE}\\"`,
      );
      expect(script).toContain(`\\"\\$(cat \\"\\$HOME/${GIT_WORK_PROMPT_SENT_FILE}\\")\\"`);
      expect(script).toContain(
        `export ${GIT_WORK_TOKEN_ENV}=\\"\\$(cat \\"\\$HOME/${GIT_WORK_TOKEN_FILE}\\")\\"`,
      );
    }
  });

  it("checks out an existing branch as it is instead of resetting it", () => {
    const script = unwrap(
      buildAgentBootstrapCommand({
        tool: "claude-code",
        workspaceName: "infra",
        branchName: "work/fix-login",
        repo: `${ORIGIN}/acme/infra.git`,
        setupPlan: {
          source: "git-url",
          workspaceName: "infra",
          initialCloneUrl: `${ORIGIN}/acme/infra.git`,
          runtimes: [],
          packageManagers: [],
          configSources: [],
          warnings: [],
        },
      }),
    );
    expect(script).toContain(`git checkout -b "$BRANCH_NAME" --track "origin/$BRANCH_NAME"`);
    // No credential in the clone URL: git asks the helper.
    expect(script).toContain(`CLONE_URL='${ORIGIN}/acme/infra.git'`);
  });
});

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("handing the VM its credential and prompt", () => {
  let home: string;
  const run = (command: string, stdin: string) =>
    execFileSync("sh", ["-c", command], {
      input: stdin,
      env: { PATH: env["PATH"] ?? "/usr/bin:/bin", HOME: home },
      encoding: "utf8",
    });

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "iw-git-work-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("keeps the token out of the command and in a private file", () => {
    const command = buildGitWorkCredentialCommand(ORIGIN);
    expect(command).not.toContain(TOKEN);
    expect(run(command, TOKEN)).toBe("");
    const file = join(home, GIT_WORK_TOKEN_FILE);
    expect(readFileSync(file, "utf8")).toBe(TOKEN);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const config = readFileSync(join(home, ".gitconfig"), "utf8");
    expect(config).not.toContain(TOKEN);
    expect(config).toContain(`[credential "${ORIGIN}"]`);
    // A renewal rewrites the file and adds nothing to the config.
    run(command, `${TOKEN}x`);
    expect(readFileSync(file, "utf8")).toBe(`${TOKEN}x`);
    expect(readFileSync(join(home, ".gitconfig"), "utf8")).toBe(config);
  });

  it.skipIf(!hasGit)("answers git for the forge, and only for the forge", () => {
    run(buildGitWorkCredentialCommand(ORIGIN), TOKEN);
    const fill = (host: string) =>
      execFileSync("git", ["credential", "fill"], {
        input: `protocol=https\nhost=${host}\n\n`,
        env: {
          PATH: env["PATH"] ?? "/usr/bin:/bin",
          HOME: home,
          GIT_TERMINAL_PROMPT: "0",
          GIT_CONFIG_NOSYSTEM: "1",
        },
        encoding: "utf8",
        stdio: ["pipe", "pipe", "ignore"],
      });
    expect(fill("git.example.test")).toContain(`password=${TOKEN}`);
    expect(() => fill("github.com")).toThrow();
  });

  it("writes the prompt as it is, once", () => {
    const prompt = buildGitWorkPrompt(input);
    run(buildGitWorkPromptWriteCommand(), prompt);
    const file = join(home, GIT_WORK_PROMPT_FILE);
    expect(readFileSync(file, "utf8")).toBe(prompt);
    // Once the tool has started with it, a later setup run does not send it again.
    rmSync(file);
    writeFileSync(join(home, GIT_WORK_PROMPT_SENT_FILE), prompt);
    run(buildGitWorkPromptWriteCommand(), "another prompt");
    expect(existsSync(file)).toBe(false);
  });
});
