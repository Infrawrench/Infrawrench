import { describe, expect, it } from "vitest";
import type { CheckReport } from "../check.js";
import { decide, decideRefresh, type OpenIssue, type OpenPullRequest } from "../watch/decide.js";

const report = (fields: Partial<CheckReport>): CheckReport => ({
  plugin: "acme",
  status: "up-to-date",
  reason: "",
  specUrls: [],
  documents: [],
  ...fields,
});

const pullRequest: OpenPullRequest = { number: 7, url: "u", plugin: "acme", body: "pr" };
const issue: OpenIssue = { number: 9, plugin: "acme", body: "same" };

const changed = report({ status: "changed", operations: ["GET /a"] });
const lasting = report({ status: "could-not-check", failure: "patch", transient: false });
const transient = report({
  status: "could-not-check",
  failure: "network",
  transient: true,
  reason: "down",
});

describe("decide", () => {
  it.each<
    [string, CheckReport, OpenPullRequest | undefined, OpenIssue | undefined, string, string]
  >([
    ["up to date, nothing open", report({}), undefined, undefined, "none", "none"],
    [
      "up to date, stale PR: back to matching main",
      report({}),
      pullRequest,
      undefined,
      "close",
      "none",
    ],
    ["up to date, old issue: check passes again", report({}), undefined, issue, "none", "close"],
    ["changed, nothing open", changed, undefined, undefined, "open", "none"],
    ["changed, PR open: no duplicate", changed, pullRequest, undefined, "refresh", "none"],
    ["changed, old issue: a check that ran passed", changed, undefined, issue, "open", "close"],
    ["lasting failure, nothing open", lasting, undefined, undefined, "none", "open"],
    ["lasting failure, PR left alone", lasting, pullRequest, undefined, "none", "open"],
    ["lasting failure, same issue: no edit", lasting, undefined, issue, "none", "none"],
    ["transient, nothing open: no issue", transient, undefined, undefined, "none", "none"],
    ["transient, PR left alone", transient, pullRequest, undefined, "none", "none"],
    ["transient, issue left open", transient, undefined, issue, "none", "none"],
  ])("%s", (_name, input, pr, open, wantPr, wantIssue) => {
    const plan = decide(input, pr, open, "same");
    expect(plan.pullRequest.kind).toBe(wantPr);
    expect(plan.issue.kind).toBe(wantIssue);
  });

  it("updates an issue whose reason changed", () => {
    expect(decide(lasting, undefined, issue, "different").issue.kind).toBe("update");
  });

  it("carries a transient failure as a warning, and nothing else does", () => {
    expect(decide(transient, undefined, undefined, "").warning).toBe("down");
    expect(decide(lasting, undefined, undefined, "").warning).toBeUndefined();
  });
});

describe("decideRefresh", () => {
  const fresh = new Map([["a.gen.ts", "new"]]);

  it("pushes when the generated files differ", () => {
    expect(decideRefresh(new Map([["a.gen.ts", "old"]]), fresh, "b", "b")).toEqual({
      push: true,
      editBody: false,
    });
  });

  it("does not push when they match, which keeps a person's fix and CI quiet", () => {
    const branch = new Map([
      ["a.gen.ts", "new"],
      ["other.ts", "a person's fix"],
    ]);
    expect(decideRefresh(branch, fresh, "old body", "new body")).toEqual({
      push: false,
      editBody: true,
    });
  });

  it("pushes when the branch has gone", () => {
    expect(decideRefresh(undefined, fresh, "b", "b").push).toBe(true);
  });

  it("does nothing when all is current", () => {
    expect(decideRefresh(fresh, fresh, "b\n", "b")).toEqual({ push: false, editBody: false });
  });
});
