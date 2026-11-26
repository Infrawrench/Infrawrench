import { describe, expect, it } from "vitest";
import type {
  BranchPageState,
  DiffFile,
  Instruction,
  ReviewFinding,
  TraceEntry,
} from "@infrawrench/git-contract";
import {
  branchNameFor,
  defaultSelection,
  diffFrom,
  diffNotice,
  instructionFor,
  isLive,
  lineKey,
  needsNow,
  openBySeverity,
  placeOnDiff,
  prunedNotice,
  seenOn,
  showsFindings,
  sortFindings,
} from "../branch";

const state = (fields: Partial<BranchPageState>): BranchPageState =>
  ({
    state: "waiting",
    latestVersion: 3,
    workingOnVersion: null,
    viewerReviewedVersion: 2,
    unreviewedVersions: 1,
    agent: null,
    openInstructions: 0,
    pendingTraceEntries: 0,
    findings: { found: 0, open: 0, fixed: 0, dismissed: 0, mustFixOpen: 0, needsPerson: 0 },
    checks: null,
    reviewRun: null,
    canMerge: false,
    settings: { reviewAgentsEnabled: true, mustFixBlocksMerge: true },
    ...fields,
  }) as BranchPageState;

const file = (path: string, lines: Array<["add" | "context" | "delete", number]>): DiffFile =>
  ({
    path,
    hunks: [
      {
        lines: lines.map(([type, n]) => ({
          type,
          oldLine: type === "add" ? null : n,
          newLine: type === "delete" ? null : n,
          content: "",
        })),
      },
    ],
  }) as unknown as DiffFile;

const entry = (id: string, version: number, anchors: TraceEntry["anchors"]): TraceEntry =>
  ({ id, kind: "step", body: id, anchors, evidence: null, version }) as unknown as TraceEntry;

const finding = (fields: Partial<ReviewFinding>): ReviewFinding =>
  ({
    id: "f",
    severity: "should_fix",
    status: "open",
    path: "a.tf",
    side: "RIGHT",
    startLine: 2,
    endLine: 2,
    commitOid: "head",
    version: 1,
    lastSeenVersion: 3,
    ...fields,
  }) as ReviewFinding;

describe("what a branch opens on", () => {
  it("is the newest version, against the one last reviewed when there is something newer", () => {
    expect(defaultSelection({ latest: 3, viewerReviewed: 2 })).toEqual({
      version: 3,
      mode: "since",
    });
    expect(defaultSelection({ latest: 3, viewerReviewed: 3 })).toEqual({
      version: 3,
      mode: "whole",
    });
    expect(defaultSelection({ latest: 3, viewerReviewed: null })).toEqual({
      version: 3,
      mode: "whole",
    });
    expect(defaultSelection({ latest: null, viewerReviewed: null }).version).toBeNull();
  });

  it("asks the API for the diff a mode means", () => {
    expect([diffFrom("whole"), diffFrom("step"), diffFrom("since")]).toEqual([
      "base",
      "previous",
      "reviewed",
    ]);
  });
});

describe("what a branch needs now", () => {
  it("says it in one line", () => {
    expect(needsNow(state({ state: "agent_working", workingOnVersion: 4 })).text).toBe(
      "The agent is working on v4",
    );
    expect(
      needsNow(
        state({
          state: "must_fix_open",
          findings: { found: 3, open: 2, fixed: 1, dismissed: 0, mustFixOpen: 2, needsPerson: 2 },
        }),
      ),
    ).toEqual({ tone: "danger", text: "2 must-fix findings to settle" });
    expect(needsNow(state({ state: "needs_your_review" })).text).toBe(
      "1 version since you last looked",
    );
    expect(needsNow(state({ state: "needs_your_review", viewerReviewedVersion: null })).text).toBe(
      "Needs your review",
    );
    expect(needsNow(state({ state: "ready_to_merge" })).tone).toBe("success");
  });

  it("keeps asking while an agent or a review is at work, and stops otherwise", () => {
    expect(isLive(undefined)).toBe(false);
    expect(isLive(state({}))).toBe(false);
    expect(isLive(state({ state: "agent_working" }))).toBe(true);
    expect(isLive(state({ openInstructions: 1 }))).toBe(true);
    expect(isLive(state({ reviewRun: "running" }))).toBe(true);
    expect(isLive(state({ reviewRun: "done" }))).toBe(false);
  });
});

describe("a diff between versions", () => {
  it("says plainly when it is not exact, and when a rebase was left out", () => {
    const base = { kind: "interdiff" as const, from: 1, to: 3 };
    expect(diffNotice({ ...base, rebased: true, exact: false })).toContain(
      "compares the two as they were pushed",
    );
    expect(diffNotice({ ...base, rebased: true, exact: true })).toContain("rebased between v1");
    expect(diffNotice({ ...base, rebased: false, exact: true })).toBeNull();
    expect(
      diffNotice({ kind: "whole", from: null, to: 3, rebased: false, exact: true }),
    ).toBeNull();
  });
});

describe("placing a trace and findings on a diff", () => {
  const files = [
    file("a.tf", [
      ["context", 1],
      ["add", 2],
      ["add", 3],
      ["context", 4],
    ]),
  ];
  const options = { oldSide: true, version: 2, headOid: "head" };

  it("puts an entry above the first line of its range the diff shows", () => {
    const placed = placeOnDiff(
      files,
      [entry("in", 2, [{ path: "a.tf", startLine: 3, endLine: 9 }])],
      [],
      options,
    );
    expect(placed.traceAt.get(lineKey("a.tf", "RIGHT", 3))?.map((item) => item.id)).toEqual(["in"]);
  });

  it("names an older version's entry above the file unless its lines are added here", () => {
    const placed = placeOnDiff(
      files,
      [
        entry("added", 1, [{ path: "a.tf", startLine: 2 }]),
        entry("moved", 1, [{ path: "a.tf", startLine: 4 }]),
        entry("whole-file", 2, [{ path: "a.tf" }]),
        entry("elsewhere", 2, [{ path: "b.tf", startLine: 1 }]),
        entry("general", 2, []),
      ],
      [],
      options,
    );
    expect([...placed.traceAt.keys()]).toEqual([lineKey("a.tf", "RIGHT", 2)]);
    expect(placed.traceOfFile.get("a.tf")?.map((item) => item.id)).toEqual(["moved", "whole-file"]);
    expect(placed.traces.map((item) => item.id)).toEqual(["elsewhere", "general"]);
  });

  it("puts a finding under its last line, and off the diff when its commit is another", () => {
    const placed = placeOnDiff(
      files,
      [],
      [
        finding({ id: "here", startLine: 1, endLine: 2 }),
        finding({ id: "context-of-older", commitOid: "older", startLine: 4, endLine: 4 }),
        finding({ id: "about-it-all", path: null }),
      ],
      options,
    );
    expect(placed.findingAt.get(lineKey("a.tf", "RIGHT", 2))?.map((item) => item.id)).toEqual([
      "here",
    ]);
    expect(placed.findingOfFile.get("a.tf")?.map((item) => item.id)).toEqual(["context-of-older"]);
    expect(placed.findings.map((item) => item.id)).toEqual(["about-it-all"]);
  });
});

describe("findings", () => {
  it("are seen on the versions between the first and the last that had them", () => {
    const item = finding({ version: 2, lastSeenVersion: 3 });
    expect([1, 2, 3, 4].map((version) => seenOn(item, version))).toEqual([
      false,
      true,
      true,
      false,
    ]);
  });

  it("sort open first and gravest first, and count the open ones by severity", () => {
    const list = [
      finding({ id: "fixed", status: "fixed", severity: "must_fix" }),
      finding({ id: "note", severity: "note" }),
      finding({ id: "must", severity: "must_fix" }),
      finding({ id: "dismissed", status: "dismissed" }),
    ];
    expect(sortFindings(list).map((item) => item.id)).toEqual([
      "must",
      "note",
      "dismissed",
      "fixed",
    ]);
    expect(openBySeverity(list)).toBe("1 must fix, 1 note");
  });
});

describe("instructions", () => {
  const sent = (fields: Partial<Instruction>): Instruction =>
    ({
      id: "i",
      status: "queued",
      findingId: null,
      reviewCommentId: null,
      ...fields,
    }) as Instruction;

  it("finds what a finding or a thread was sent as, leaving out what was withdrawn", () => {
    const list = [
      sent({ id: "old", findingId: "f1", status: "dismissed" }),
      sent({ id: "new", findingId: "f1", status: "answered" }),
      sent({ id: "thread", reviewCommentId: "c2" }),
    ];
    expect(instructionFor(list, { findingId: "f1" })?.id).toBe("new");
    expect(instructionFor(list, { commentIds: ["c1", "c2"] })?.id).toBe("thread");
    expect(instructionFor(list, { findingId: "f2" })).toBeNull();
  });
});

describe("a branch name from an ask", () => {
  it("is the first line's words, cut at a word", () => {
    expect(branchNameFor("Keep two weeks of backups\n\nAurora refuses 0.")).toBe(
      "work/keep-two-weeks-of-backups",
    );
    expect(
      branchNameFor("Peer each environment's VPC with shared services so the cluster reaches it"),
    ).toBe("work/peer-each-environment-s-vpc-with-shared");
    expect(branchNameFor("   ")).toBe("");
  });
});

describe("whether the page lists findings", () => {
  it("does whenever there is a finding or a run, whatever the repository's setting", () => {
    const off = { agentsEnabled: false, findings: 0, run: null };
    expect(showsFindings(off)).toBe(false);
    expect(showsFindings({ ...off, findings: 2 })).toBe(true);
    expect(showsFindings({ ...off, run: "done" })).toBe(true);
    // On, the empty list says nothing was found.
    expect(showsFindings({ ...off, agentsEnabled: true })).toBe(true);
  });
});

describe("a pruned version's diff", () => {
  it("says what cannot be shown and why", () => {
    expect(prunedNotice({ version: 1, mode: "whole", merged: true })).toBe(
      "The change at v1 cannot be shown: its commits were removed 30 days after the branch was merged. What was recorded and found on it is kept.",
    );
    expect(prunedNotice({ version: 3, mode: "step", merged: false })).toBe(
      "What v3 changed since an earlier version cannot be shown: its commits were removed 30 days after the branch was deleted. What was recorded and found on it is kept.",
    );
  });
});
