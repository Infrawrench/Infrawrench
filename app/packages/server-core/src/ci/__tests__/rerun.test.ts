import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CiCheckRerequest } from "../events";

/**
 * Re-runs asked for from GitHub. The rules that keep a re-run from being a
 * way around approval, or from starting two runs, are pinned on the pure
 * pieces; `acceptCheckRerequest` is run against a stubbed commit's runs.
 */

let commitRuns: unknown[] = [];
vi.mock("../../db/client.js", () => {
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async () => commitRuns,
  };
  return { db: { select: () => chain } };
});

const mockOrg = vi.fn();
const mockInsertRetry = vi.fn();
const mockDispatch = vi.fn();
const mockAnnounce = vi.fn();
vi.mock("../runs.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runs.js")>()),
  ciOrganization: (...a: unknown[]) => mockOrg(...a),
  insertRetry: (...a: unknown[]) => mockInsertRetry(...a),
  dispatchRun: (...a: unknown[]) => mockDispatch(...a),
  announceAwaitingApproval: (...a: unknown[]) => mockAnnounce(...a),
}));
const mockNote = vi.fn();
vi.mock("../checks.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../checks.js")>()),
  noteOnCheck: (...a: unknown[]) => mockNote(...a),
}));

const { acceptCheckRerequest, followUpCheckRerun, rerunDecision, rerunTargets } =
  await import("../rerun");

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

type Row = Parameters<typeof rerunDecision>[0] & Record<string, unknown>;

function run(id: string, over: Partial<Row> = {}): Row {
  return {
    id,
    event: "push",
    status: "failed",
    branch: "main",
    headRef: "main",
    retryOfRunId: null,
    checkRunId: 100,
    jobChecks: {},
    fromFork: false,
    repoFullName: "acme/web",
    ...over,
  };
}

function checkRun(over: Partial<CiCheckRerequest> = {}): CiCheckRerequest {
  return {
    kind: "check_run",
    installationId: 7,
    repoFullName: "acme/web",
    appId: 42,
    headSha: "a".repeat(40),
    headBranch: "main",
    checkRunId: 100,
    externalId: A,
    senderLogin: "octo",
    ...over,
  };
}

const suite = (over: Partial<CiCheckRerequest> = {}) =>
  checkRun({ kind: "check_suite", checkRunId: null, externalId: null, ...over });

describe("rerunTargets", () => {
  it("finds a check's run by its external id, a job's check included", () => {
    const rows = [run(A, { checkRunId: 100 }), run(B, { checkRunId: 200 })];
    expect(rerunTargets(rows, checkRun({ externalId: B, checkRunId: 999 }))).toEqual([rows[1]]);
    expect(
      rerunTargets(rows, checkRun({ externalId: `${B}:Test:build`, checkRunId: 999 })),
    ).toEqual([rows[1]]);
  });

  it("falls back to the check's id, among runs' own checks and their jobs'", () => {
    const rows = [
      run(A, { checkRunId: 100 }),
      run(B, { checkRunId: 200, jobChecks: { '["Test","build"]': { id: 201, sent: "x" } } }),
    ];
    expect(rerunTargets(rows, checkRun({ externalId: null, checkRunId: 100 }))).toEqual([rows[0]]);
    expect(rerunTargets(rows, checkRun({ externalId: "other", checkRunId: 201 }))).toEqual([
      rows[1],
    ]);
    // A run id not among the commit's runs (another repository's, say) is not taken.
    expect(rerunTargets(rows, checkRun({ externalId: C, checkRunId: 999 }))).toEqual([]);
  });

  it("re-runs a suite as the newest run of each line of retries, of pushes and pull requests", () => {
    const rows = [
      run(A, { event: "push" }),
      run(B, { event: "push", retryOfRunId: A }),
      run(C, { event: "pull-request", branch: "pull/4", headRef: "main" }),
      run("44444444-4444-4444-8444-444444444444", { event: "schedule" }),
    ];
    expect(rerunTargets(rows, suite()).map((r) => r.id)).toEqual([B, C]);
  });

  it("narrows a suite to the branch GitHub names, or takes every branch without one", () => {
    const rows = [run(A, { headRef: "main" }), run(B, { headRef: "feature" })];
    expect(rerunTargets(rows, suite({ headBranch: "feature" })).map((r) => r.id)).toEqual([B]);
    expect(rerunTargets(rows, suite({ headBranch: null })).map((r) => r.id)).toEqual([A, B]);
  });
});

describe("rerunDecision", () => {
  it("retries a finished push or pull request run once", () => {
    for (const status of ["passed", "failed", "error", "cancelled"] as const) {
      expect(rerunDecision(run(A, { status }), false)).toEqual({ kind: "retry" });
    }
    // Already retried: the newer run's checks stand in for this one's.
    expect(rerunDecision(run(A), true)).toEqual({ kind: "ignore" });
  });

  it("leaves a run that has not finished alone, and says so", () => {
    for (const status of ["queued", "pending", "running"] as const) {
      expect(rerunDecision(run(A, { status }), false)).toMatchObject({ kind: "refuse" });
    }
  });

  it("is never a way around approval", () => {
    expect(rerunDecision(run(A, { status: "awaiting_approval" }), false)).toMatchObject({
      kind: "refuse",
      note: expect.stringContaining("approve"),
    });
    expect(rerunDecision(run(A, { status: "rejected" }), false)).toMatchObject({
      kind: "refuse",
    });
  });

  it("starts scheduled and manual runs only from Infrawrench", () => {
    expect(rerunDecision(run(A, { event: "schedule" }), false)).toMatchObject({
      kind: "refuse",
      note: expect.stringContaining("scheduled"),
    });
    expect(rerunDecision(run(A, { event: "manual" }), false)).toMatchObject({
      kind: "refuse",
      note: expect.stringContaining("manual"),
    });
  });

  it("has nothing to re-run for a skipped run", () => {
    expect(rerunDecision(run(A, { status: "skipped" }), false)).toMatchObject({ kind: "refuse" });
  });
});

describe("acceptCheckRerequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env["GITHUB_APP_ID"] = "42";
    mockOrg.mockResolvedValue("org-1");
    mockInsertRetry.mockImplementation(async (original: Row) => ({
      ...original,
      id: "new-run",
      status: original["fromFork"] ? "awaiting_approval" : "queued",
      retryOfRunId: original.id,
    }));
  });

  it("ignores another app's checks, and a commit no organization runs CI for", async () => {
    commitRuns = [run(A)];
    expect(await acceptCheckRerequest(checkRun({ appId: 99 }))).toBeNull();
    mockOrg.mockResolvedValue(null);
    expect(await acceptCheckRerequest(checkRun())).toBeNull();
    expect(mockInsertRetry).not.toHaveBeenCalled();
  });

  it("retries as nobody, first retry only, so a fork's re-run waits for approval", async () => {
    commitRuns = [run(A, { fromFork: true, event: "pull-request" })];
    const rerun = await acceptCheckRerequest(checkRun());
    expect(mockInsertRetry).toHaveBeenCalledWith(commitRuns[0], {
      approvedByUserId: null,
      noTaskCache: false,
      firstOnly: true,
    });
    expect(rerun?.retried.map((r) => r.status)).toEqual(["awaiting_approval"]);
    expect(rerun?.notes).toEqual([]);

    await followUpCheckRerun(rerun!);
    expect(mockAnnounce).toHaveBeenCalledWith("new-run");
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("dispatches a same-repository retry", async () => {
    commitRuns = [run(A)];
    const rerun = await acceptCheckRerequest(checkRun());
    await followUpCheckRerun(rerun!);
    expect(mockDispatch).toHaveBeenCalledWith("new-run");
  });

  it("starts nothing for a redelivery, or a second check of a run already re-run", async () => {
    commitRuns = [run(A), run(B, { retryOfRunId: A, status: "running" })];
    const rerun = await acceptCheckRerequest(checkRun({ externalId: `${A}:Test:lint` }));
    expect(mockInsertRetry).not.toHaveBeenCalled();
    expect(rerun?.retried).toEqual([]);
    expect(rerun?.notes).toEqual([]);
  });

  it("starts one run when two deliveries race", async () => {
    commitRuns = [run(A)];
    mockInsertRetry.mockResolvedValue(null);
    const rerun = await acceptCheckRerequest(checkRun());
    expect(rerun?.retried).toEqual([]);
  });

  it("answers the check it was asked about when it starts nothing", async () => {
    commitRuns = [run(A, { status: "running" })];
    const rerun = await acceptCheckRerequest(checkRun({ checkRunId: 555 }));
    expect(rerun?.notes).toEqual([{ checkRunId: 555, note: expect.any(String) }]);
    await followUpCheckRerun(rerun!);
    expect(mockNote).toHaveBeenCalledWith(7, "acme/web", 555, expect.any(String));
  });

  it("answers a suite's refused runs on their own checks, except one still going", async () => {
    commitRuns = [
      run(A, { status: "rejected", checkRunId: 100 }),
      run(B, { status: "running", checkRunId: 200 }),
      run(C, { status: "failed", checkRunId: 300 }),
    ];
    const rerun = await acceptCheckRerequest(suite());
    expect(rerun?.retried.map((r) => r.retryOfRunId)).toEqual([C]);
    expect(rerun?.notes).toEqual([{ checkRunId: 100, note: expect.any(String) }]);
  });
});
