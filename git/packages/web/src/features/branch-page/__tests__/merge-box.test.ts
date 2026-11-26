import { describe, expect, it } from "vitest";
import type { CommitStatus, Mergeability, StatusState } from "@infrawrench/git-contract";
import { checkRows, deriveMergeBox } from "../merge-box";

const status = (context: string, state: StatusState): CommitStatus => ({
  id: context,
  context,
  state,
  description: null,
  targetUrl: `/acme/infra/ci/runs/${context}`,
  creator: null,
  createdAt: "2026-11-01T10:00:00.000Z",
  updatedAt: "2026-11-01T10:00:00.000Z",
});

const CLEAN: Mergeability = {
  state: "clean",
  conflictFiles: [],
  behindBy: 0,
  checks: {
    state: "success",
    statuses: [status("ci / fmt", "success"), status("ci / lint", "success")],
    required: [{ context: "ci / fmt", state: "success" }],
  },
  reviews: { decision: "approved", requiredApprovals: 1, approvals: 1, changesRequested: 0 },
  protection: { pattern: "main", enforceAdmins: false },
  blockers: [],
  canMerge: true,
  canBypass: false,
  allowedMethods: ["merge", "squash", "rebase"],
  defaultMethod: "merge",
  canUpdateBranch: false,
};

const blocked = (
  codes: Array<Mergeability["blockers"][number]["code"]>,
  rest: Partial<Mergeability> = {},
): Mergeability => ({
  ...CLEAN,
  canMerge: false,
  blockers: codes.map((code) => ({ code, message: `blocked: ${code}` })),
  ...rest,
});

describe("deriveMergeBox", () => {
  it("offers the merge when nothing blocks it", () => {
    const model = deriveMergeBox(CLEAN, "main");
    expect(model.action).toEqual({ mode: "merge" });
    expect(model.reviews).toMatchObject({ tone: "success", title: "Approved" });
    expect(model.reviews?.detail).toBe("1 of 1 required approval");
    expect(model.checks).toMatchObject({ tone: "success", title: "All checks passed" });
    expect(model.branch).toMatchObject({ tone: "success", title: "No conflicts with main" });
    expect(model.poll).toBe(false);
  });

  it("says how far behind a clean branch is", () => {
    const model = deriveMergeBox({ ...CLEAN, behindBy: 3, canUpdateBranch: true }, "main");
    expect(model.branch.detail).toBe("3 commits behind main");
    expect(model.action.mode).toBe("merge");
  });

  it("blocks on conflicts and lists nothing to bypass", () => {
    const model = deriveMergeBox(
      blocked(["conflicts"], {
        state: "conflicting",
        conflictFiles: ["a.tf", "b.tf"],
        canBypass: true,
      }),
      "main",
    );
    expect(model.branch).toEqual({
      tone: "danger",
      title: "This branch has conflicts",
      detail: "2 files",
    });
    // Conflicts bind administrators too, whatever `canBypass` says about the rule.
    expect(model.action).toEqual({ mode: "blocked", reasons: ["blocked: conflicts"] });
  });

  it("lets an administrator merge past unmet reviews and checks", () => {
    const model = deriveMergeBox(
      blocked(["checks_failed", "approvals_required"], {
        canBypass: true,
        checks: {
          state: "failure",
          statuses: [status("ci / fmt", "failure")],
          required: [{ context: "ci / fmt", state: "failure" }],
        },
        reviews: {
          decision: "review_required",
          requiredApprovals: 2,
          approvals: 0,
          changesRequested: 0,
        },
      }),
      "main",
    );
    expect(model.action).toEqual({
      mode: "bypass",
      reasons: ["blocked: checks_failed", "blocked: approvals_required"],
    });
    expect(model.reviews).toMatchObject({
      tone: "warning",
      title: "Review required",
      detail: "0 of 2 required approvals",
    });
    expect(model.checks).toMatchObject({ tone: "danger", title: "Some checks failed" });
  });

  it("does not offer a bypass when the rule binds administrators", () => {
    const model = deriveMergeBox(blocked(["approvals_required"]), "main");
    expect(model.action.mode).toBe("blocked");
  });

  it("blocks a draft even for someone who could bypass the rule", () => {
    const model = deriveMergeBox(
      blocked(["draft", "approvals_required"], { canBypass: true }),
      "main",
    );
    expect(model.action.mode).toBe("blocked");
  });

  it("shows no action to someone who cannot merge, or once it is merged or closed", () => {
    for (const code of ["no_permission", "merged", "closed"] as const) {
      expect(deriveMergeBox(blocked([code]), "main").action).toEqual({ mode: "none" });
    }
  });

  it("asks again while a check runs or the trial merge is not done", () => {
    const running = deriveMergeBox(
      blocked(["checks_pending"], {
        checks: {
          state: "pending",
          statuses: [status("ci / fmt", "pending")],
          required: [{ context: "ci / fmt", state: "pending" }],
        },
      }),
      "main",
    );
    expect(running.poll).toBe(true);
    expect(running.checks).toMatchObject({ tone: "warning", title: "Checks are running" });
    expect(deriveMergeBox(blocked(["checking"], { state: "checking" }), "main").poll).toBe(true);
  });

  it("names changes requested over everything else about reviews", () => {
    const model = deriveMergeBox(
      blocked(["changes_requested"], {
        reviews: {
          decision: "changes_requested",
          requiredApprovals: 1,
          approvals: 1,
          changesRequested: 2,
        },
      }),
      "main",
    );
    expect(model.reviews).toEqual({
      tone: "danger",
      title: "Changes requested",
      detail: "2 reviewers asked for changes",
    });
  });

  it("has no review or check row when there is nothing to say", () => {
    const model = deriveMergeBox(
      {
        ...CLEAN,
        protection: null,
        checks: { state: null, statuses: [], required: [] },
        reviews: { decision: null, requiredApprovals: 0, approvals: 0, changesRequested: 0 },
      },
      "main",
    );
    expect(model.reviews).toBeNull();
    expect(model.checks).toBeNull();
    expect(model.action.mode).toBe("merge");
  });
});

describe("checkRows", () => {
  it("lists a required check nothing has reported as expected", () => {
    const rows = checkRows({
      state: "success",
      statuses: [status("ci / lint", "success")],
      required: [
        { context: "ci / fmt", state: null },
        { context: "ci / lint", state: "success" },
      ],
    });
    expect(rows).toEqual([
      {
        context: "ci / fmt",
        state: null,
        description: "Expected",
        targetUrl: null,
        required: true,
      },
      {
        context: "ci / lint",
        state: "success",
        description: null,
        targetUrl: "/acme/infra/ci/runs/ci / lint",
        required: true,
      },
    ]);
  });

  it("puts failures first, then what is still running, then what passed", () => {
    const rows = checkRows({
      state: "failure",
      statuses: [
        status("a passed", "success"),
        status("b running", "pending"),
        status("c failed", "failure"),
        status("d errored", "error"),
      ],
      required: [],
    });
    expect(rows.map((row) => row.context)).toEqual([
      "c failed",
      "d errored",
      "b running",
      "a passed",
    ]);
    expect(rows.every((row) => !row.required)).toBe(true);
  });
});
