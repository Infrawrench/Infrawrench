import { describe, expect, it, vi } from "vitest";
import type { CheckOutcome, CheckReport } from "../check.js";
import type { OpenIssue, OpenPullRequest } from "../watch/decide.js";
import type { GitPort } from "../watch/git.js";
import type { GitHubPort } from "../watch/github.js";
import { renderSummary, runWatch, type WatchPorts } from "../watch/index.js";
import { issueTitle, renderIssueBody, renderPullRequestBody } from "../watch/render.js";

const FILE = "plugin-architecture/packages/acme/src/api-types.gen.ts";

const outcome = (fields: Partial<CheckReport> = {}, text?: string): CheckOutcome => ({
  report: {
    plugin: "acme",
    status: "up-to-date",
    reason: "fine",
    specUrls: ["https://vendor.test/doc"],
    documents: [],
    ...fields,
  },
  changedFiles:
    text === undefined
      ? []
      : [{ fileName: "api-types.gen.ts", specUrl: "https://vendor.test/doc", text, operations: 1 }],
});

const changed = () => outcome({ status: "changed", operations: ["GET /a"] }, "fresh");

function ports(
  open: {
    pullRequests?: OpenPullRequest[];
    issues?: OpenIssue[];
    branch?: Map<string, string>;
  } = {},
) {
  const github = {
    listPullRequests: vi.fn<GitHubPort["listPullRequests"]>(async () => open.pullRequests ?? []),
    listIssues: vi.fn<GitHubPort["listIssues"]>(async () => open.issues ?? []),
    createPullRequest: vi.fn<GitHubPort["createPullRequest"]>(async () => "https://pr"),
    editPullRequest: vi.fn<GitHubPort["editPullRequest"]>(async () => {}),
    closePullRequest: vi.fn<GitHubPort["closePullRequest"]>(async () => {}),
    createIssue: vi.fn<GitHubPort["createIssue"]>(async () => "https://issue"),
    editIssue: vi.fn<GitHubPort["editIssue"]>(async () => {}),
    closeIssue: vi.fn<GitHubPort["closeIssue"]>(async () => {}),
  };
  const git = {
    readBranchFiles: vi.fn<GitPort["readBranchFiles"]>(async () => open.branch),
    pushBranch: vi.fn<GitPort["pushBranch"]>(async () => {}),
  };
  const typecheck = vi.fn<WatchPorts["typecheck"]>(async () => ({ state: "passed" }));
  return { github, git, typecheck };
}

function writes(p: ReturnType<typeof ports>): number {
  return (
    p.github.createPullRequest.mock.calls.length +
    p.github.editPullRequest.mock.calls.length +
    p.github.closePullRequest.mock.calls.length +
    p.github.createIssue.mock.calls.length +
    p.github.editIssue.mock.calls.length +
    p.github.closeIssue.mock.calls.length +
    p.git.pushBranch.mock.calls.length
  );
}

const apply = { apply: true };

describe("runWatch with --apply", () => {
  it("opens a branch and a pull request for a change, stating the typecheck", async () => {
    const p = ports();
    p.typecheck.mockResolvedValue({ state: "failed", output: "error TS2322" });
    const [entry] = await runWatch([changed()], p, apply);
    expect(p.git.pushBranch).toHaveBeenCalledWith(
      "plugingen/acme",
      new Map([[FILE, "fresh"]]),
      expect.stringContaining("chore(acme)"),
    );
    const [branch, title, body] = p.github.createPullRequest.mock.calls[0] ?? [];
    expect(branch).toBe("plugingen/acme");
    expect(title).toBe("chore(acme): update generated API types");
    expect(body).toContain("does not compile");
    expect(body).toContain("`GET /a`");
    expect(entry?.actions[0]).toContain("typecheck failed");
  });

  const open: OpenPullRequest = { number: 7, url: "https://pr/7", plugin: "acme", body: "old" };

  it("force-pushes fresh output onto an open pull request rather than opening another", async () => {
    const p = ports({ pullRequests: [open], branch: new Map([[FILE, "stale"]]) });
    await runWatch([changed()], p, apply);
    expect(p.github.createPullRequest).not.toHaveBeenCalled();
    expect(p.git.pushBranch).toHaveBeenCalledTimes(1);
    expect(p.github.editPullRequest).toHaveBeenCalledWith(7, expect.stringContaining("GET /a"));
  });

  it("leaves a current pull request completely alone", async () => {
    const body = renderPullRequestBody(changed().report, { state: "passed" });
    const p = ports({
      pullRequests: [{ ...open, body }],
      branch: new Map([[FILE, "fresh"]]),
    });
    const [entry] = await runWatch([changed()], p, apply);
    expect(writes(p)).toBe(0);
    expect(entry?.actions[0]).toContain("already current");
  });

  it("closes a pull request once the output matches main again", async () => {
    const p = ports({ pullRequests: [open] });
    await runWatch([outcome()], p, apply);
    expect(p.github.closePullRequest).toHaveBeenCalledWith(7, expect.stringContaining("main"));
    expect(p.git.pushBranch).not.toHaveBeenCalled();
  });

  const lasting = (reason: string) =>
    outcome({ status: "could-not-check", failure: "operation-removed", transient: false, reason });

  it("opens one bug-labelled issue with a stable title for a lasting failure", async () => {
    const p = ports();
    await runWatch([lasting("GET /a is not in the document")], p, apply);
    expect(p.github.createIssue).toHaveBeenCalledWith(
      issueTitle("acme"),
      expect.stringContaining("GET /a is not in the document"),
    );
    expect(p.typecheck).not.toHaveBeenCalled();
  });

  it("does not touch an issue already saying the same, and updates one that is not", async () => {
    const report = lasting("same");
    const current: OpenIssue = { number: 3, plugin: "acme", body: renderIssueBody(report.report) };
    const unchanged = ports({ issues: [current] });
    await runWatch([report], unchanged, apply);
    expect(writes(unchanged)).toBe(0);

    const moved = ports({ issues: [current] });
    await runWatch([lasting("different")], moved, apply);
    expect(moved.github.editIssue).toHaveBeenCalledTimes(1);
    expect(moved.github.createIssue).not.toHaveBeenCalled();
  });

  it("closes the issue once the check passes, whether or not the types changed", async () => {
    const issue: OpenIssue = { number: 3, plugin: "acme", body: "b" };
    const quiet = ports({ issues: [issue] });
    await runWatch([outcome()], quiet, apply);
    expect(quiet.github.closeIssue).toHaveBeenCalledWith(3, expect.any(String));
    const moved = ports({ issues: [issue] });
    await runWatch([changed()], moved, apply);
    expect(moved.github.closeIssue).toHaveBeenCalledTimes(1);
    expect(moved.github.createPullRequest).toHaveBeenCalledTimes(1);
  });

  it("only warns about a network failure, and closes nothing because of it", async () => {
    const transient = outcome({
      status: "could-not-check",
      failure: "network",
      transient: true,
      reason: "down",
    });
    const p = ports({
      pullRequests: [open],
      issues: [{ number: 3, plugin: "acme", body: "b" }],
    });
    const [entry] = await runWatch([transient], p, apply);
    expect(writes(p)).toBe(0);
    expect(entry?.warning).toBe("down");
    expect(entry?.error).toBeUndefined();
  });

  it("keeps going when acting on one plugin fails, and reports it", async () => {
    const p = ports();
    p.git.pushBranch.mockRejectedValueOnce(new Error("denied"));
    const other: CheckOutcome = {
      ...changed(),
      report: { ...changed().report, plugin: "other" },
    };
    const entries = await runWatch([changed(), other], p, apply);
    expect(entries[0]?.error).toBe("denied");
    expect(entries[1]?.error).toBeUndefined();
    expect(p.github.createPullRequest).toHaveBeenCalledTimes(1);
  });
});

describe("runWatch as a dry run", () => {
  it("reads, describes, and writes nothing", async () => {
    const open: OpenPullRequest = { number: 7, url: "u", plugin: "acme", body: "b" };
    const p = ports({ pullRequests: [open] });
    const [entry] = await runWatch([changed()], p, { apply: false });
    expect(writes(p)).toBe(0);
    expect(p.typecheck).not.toHaveBeenCalled();
    expect(p.git.readBranchFiles).not.toHaveBeenCalled();
    expect(entry?.actions[0]).toContain("update pull request #7");
    expect(entry?.actions[0]).toContain("GET /a");
  });
});

describe("renderSummary", () => {
  it("keeps one row per plugin, whatever a reason contains", () => {
    const summary = renderSummary(
      [{ plugin: "acme", status: "could-not-check", actions: [], warning: "a|b\n# c" }],
      true,
    );
    expect(summary).toContain("a\\|b # c");
    expect(summary.split("\n").filter((line) => line.startsWith("| acme"))).toHaveLength(1);
  });
});
