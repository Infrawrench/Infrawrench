import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitHubCli } from "../watch/github.js";

let dir: string;

/** A stand-in `gh` that records its argv and stdin, then answers as told. */
function fakeGh(script = "exit 0"): void {
  fs.writeFileSync(
    path.join(dir, "gh"),
    `#!/bin/sh
for arg in "$@"; do printf '%s\\n' "$arg" >> "${dir}/argv"; done
cat > "${dir}/stdin"
${script}
`,
    { mode: 0o755 },
  );
}

const argv = () => fs.readFileSync(path.join(dir, "argv"), "utf8").trimEnd().split("\n");
const stdin = () => fs.readFileSync(path.join(dir, "stdin"), "utf8");

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "plugingen-gh-"));
  vi.stubEnv("PATH", `${dir}${path.delimiter}${process.env["PATH"]}`);
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

const HOSTILE = "$(touch /tmp/pwned) `id` ; rm -rf / \"' \n::error::x";

describe("gitHubCli", () => {
  it("passes a pull request body over stdin, as data", async () => {
    fakeGh(`echo https://github.test/pr/1`);
    await expect(gitHubCli.createPullRequest("plugingen/acme", "t", HOSTILE)).resolves.toBe(
      "https://github.test/pr/1",
    );
    expect(argv()).toEqual(
      expect.arrayContaining(["--head", "plugingen/acme", "--base", "main", "--body-file", "-"]),
    );
    expect(argv().join("\n")).not.toContain("pwned");
    expect(stdin()).toBe(HOSTILE);
  });

  it("labels a new issue bug, with its body over stdin", async () => {
    fakeGh(`echo https://github.test/issue/1`);
    await gitHubCli.createIssue("title", HOSTILE);
    expect(argv()).toEqual(expect.arrayContaining(["issue", "create", "--label", "bug"]));
    expect(stdin()).toBe(HOSTILE);
  });

  it("edits through REST with a JSON body", async () => {
    fakeGh();
    await gitHubCli.editPullRequest(7, HOSTILE);
    expect(argv()).toEqual(expect.arrayContaining(["PATCH", "repos/{owner}/{repo}/pulls/7"]));
    expect(JSON.parse(stdin())).toEqual({ body: HOSTILE });
  });

  it("deletes the branch when it closes a pull request", async () => {
    fakeGh();
    await gitHubCli.closePullRequest(7, "done");
    expect(argv()).toEqual(expect.arrayContaining(["pr", "close", "7", "--delete-branch"]));
  });

  it("explains a refused token in terms of the App", async () => {
    fakeGh(`echo "HTTP 403: Resource not accessible by integration" >&2; exit 1`);
    await expect(gitHubCli.listPullRequests()).rejects.toThrow(/GitHub App is installed/);
  });

  it("reports any other failure without the hint", async () => {
    fakeGh(`echo "something else" >&2; exit 1`);
    const failure = gitHubCli.listIssues();
    await expect(failure).rejects.toThrow(/something else/);
    await expect(failure).rejects.not.toThrow(/GitHub App/);
  });
});
