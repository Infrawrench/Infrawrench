/**
 * The commands a thread is told to run (`markerSetup`), run for real by
 * `sh` with `git`, `curl` and `claude` replaced: the machine's Git
 * credential reaches only `curl`'s configuration, the token only the file
 * and the MCP server's header, and nothing the commands print holds either.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { markerSetup } from "../work";

const PASSWORD = "machine-credential-for-the-forge";
const TOKEN = "the-token-the-forge-answered";

const hasSh = spawnSync("sh", ["-c", "command -v sed && command -v cat"]).status === 0;

describe.skipIf(!hasSh)("the commands a thread runs to reach the forge's tools", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** A directory of stand-ins, and where each one writes what it was given. */
  const stage = (credential: string) => {
    const dir = mkdtempSync(join(tmpdir(), "marker-setup-"));
    dirs.push(dir);
    const bin = join(dir, "bin");
    const gitDir = join(dir, "gitdir");
    mkdirSync(bin);
    mkdirSync(gitDir);
    const script = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    script(
      "git",
      [
        `if [ "$1" = "rev-parse" ]; then echo "${gitDir}"; exit 0; fi`,
        `if [ "$1" = "credential" ]; then`,
        `  cat > "${dir}/credential-asked"`,
        `  echo "prompt=$GIT_TERMINAL_PROMPT" >> "${dir}/credential-asked"`,
        credential === ""
          ? "  exit 128"
          : `  printf 'protocol=https\\nhost=git.example.test\\nusername=someone\\npassword=${credential}\\n'`,
        "fi",
      ].join("\n"),
    );
    script(
      "curl",
      [
        `echo "$@" > "${dir}/curl-args"`,
        `cat > "${dir}/curl-config"`,
        `if ! grep -q 'Bearer ${PASSWORD}' "${dir}/curl-config"; then exit 22; fi`,
        `printf '{"token":"${TOKEN}","expiresAt":"2026-11-27T18:00:00.000Z","branch":"work/a"}'`,
      ].join("\n"),
    );
    script("claude", `echo "$@" >> "${dir}/claude-args"`);
    return { dir, bin, gitDir };
  };

  const commands = markerSetup(
    { repository: { owner: "acme", name: "infra" }, key: "work/a", branch: "work/a" },
    "https://git.example.test",
  )
    .split("\n")
    .filter((line) => !line.startsWith("```"))
    .join("\n");

  const run = (bin: string) =>
    execFileSync("sh", ["-c", commands], {
      env: { PATH: `${bin}:/usr/bin:/bin` },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

  it("asks with the machine's credential and keeps the token in a private file", () => {
    const { dir, bin, gitDir } = stage(PASSWORD);
    const printed = run(bin);

    // Git is asked for this host's credential, and never prompts.
    expect(readFileSync(join(dir, "credential-asked"), "utf8")).toBe(
      "protocol=https\nhost=git.example.test\n\nprompt=0\n",
    );
    // The credential goes to curl as configuration on its input, never as an argument.
    expect(readFileSync(join(dir, "curl-config"), "utf8")).toBe(
      `header = "Authorization: Bearer ${PASSWORD}"\n`,
    );
    const curl = readFileSync(join(dir, "curl-args"), "utf8");
    expect(curl).toContain(
      "-X POST https://git.example.test/api/repos/acme/infra/branches/work%2Fa/agent/token",
    );
    expect(curl).not.toContain(PASSWORD);

    const file = join(gitDir, "infrawrench-git-token");
    expect(readFileSync(file, "utf8").trim()).toBe(TOKEN);
    expect(statSync(file).mode & 0o077).toBe(0);

    expect(readFileSync(join(dir, "claude-args"), "utf8")).toBe(
      [
        "mcp remove infrawrench-git",
        `mcp add --transport http infrawrench-git https://git.example.test/mcp --header Authorization: Bearer ${TOKEN}`,
        "",
      ].join("\n"),
    );
    // Nothing a thread's transcript would show.
    expect(printed).not.toContain(TOKEN);
    expect(printed).not.toContain(PASSWORD);
  });

  it("writes an empty file when the machine has no credential for the forge", () => {
    const { bin, gitDir } = stage("");
    run(bin);
    expect(readFileSync(join(gitDir, "infrawrench-git-token"), "utf8")).toBe("");
  });
});
