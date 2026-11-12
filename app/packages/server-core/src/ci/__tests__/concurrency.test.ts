import { describe, expect, it, vi } from "vitest";

import type { CiConcurrencyEntry } from "../../db/ci-schema";

// `concurrency.ts` imports the database client at load; the decision is pure.
vi.mock("../../db/client.js", () => ({ db: {} }));

const { activeGroups, decideAdmission, entriesFrom, groupScope } = await import("../concurrency");
type AdmissionRun = Parameters<typeof decideAdmission>[0];

const entry = (
  file: string,
  group: string | null,
  cancelInProgress = false,
  cancelled = false,
): CiConcurrencyEntry => ({
  file,
  pipeline: file,
  group,
  cancelInProgress,
  ...(cancelled ? { cancelled: true } : {}),
});

let clock = 0;
const run = (
  id: string,
  status: string,
  concurrency: CiConcurrencyEntry[],
  createdAtMicros = 1_794_000_000_000_000 + clock++,
  scope = "",
): AdmissionRun => ({ id, status, concurrency, createdAtMicros, scope });

describe("decideAdmission", () => {
  it("cancels an older running run's pipelines in a cancel-in-progress group, and goes", () => {
    const older = run("old", "running", [entry("test.yml", "ci-main"), entry("deploy.yml", null)]);
    const self = run("new", "queued", [entry("test.yml", "CI-main", true)]);
    expect(decideAdmission(self, [older])).toEqual({
      outcome: "admit",
      blocker: null,
      cancelPending: [],
      // Only the group's pipeline: the deploy in no group carries on.
      cancelPipelines: [{ runId: "old", files: ["test.yml"] }],
    });
  });

  it("waits behind an older run without cancel-in-progress, and keeps only the newest waiting", () => {
    const holder = run("a", "running", [entry("deploy.yml", "deploy")]);
    const waiting = run("b", "pending", [entry("deploy.yml", "deploy")]);
    const self = run("c", "queued", [entry("deploy.yml", "deploy")]);
    const decision = decideAdmission(self, [holder, waiting]);
    expect(decision.outcome).toBe("wait");
    expect(decision.blocker).toEqual({ group: "deploy", runId: "a" });
    // The older waiting run is cancelled: one run waits per group.
    expect(decision.cancelPending).toEqual(["b"]);
    expect(decision.cancelPipelines).toEqual([]);
  });

  it("lets runs of different groups, and runs without one, go side by side", () => {
    const main = run("a", "running", [entry("ci.yml", "ci-main", true)]);
    const ungrouped = run("b", "running", [entry("ci.yml", null)]);
    const self = run("c", "queued", [entry("ci.yml", "ci-feature", true)]);
    expect(decideAdmission(self, [main, ungrouped]).outcome).toBe("admit");
    expect(decideAdmission(self, [main, ungrouped]).cancelPipelines).toEqual([]);
    expect(decideAdmission(run("d", "queued", [entry("ci.yml", null)]), [main]).outcome).toBe(
      "admit",
    );
  });

  it("is superseded by a newer run of its group, rather than cancelling it", () => {
    const self = run("old", "queued", [entry("ci.yml", "g", true)]);
    const newer = run("new", "running", [entry("ci.yml", "g", true)]);
    const decision = decideAdmission(self, [newer]);
    expect(decision.outcome).toBe("superseded");
    expect(decision.blocker).toEqual({ group: "g", runId: "new" });
    expect(decision.cancelPipelines).toEqual([]);
  });

  it("goes once the holder's pipelines in the group were cancelled", () => {
    const holder = run("a", "running", [entry("ci.yml", "g", false, true)]);
    const self = run("b", "pending", [entry("ci.yml", "g")]);
    expect(decideAdmission(self, [holder]).outcome).toBe("admit");
  });

  it("treats an admitted run that has not started as holding its group", () => {
    const admitted = run("a", "queued", [entry("ci.yml", "g")]);
    const self = run("b", "queued", [entry("ci.yml", "g")]);
    expect(decideAdmission(self, [admitted]).outcome).toBe("wait");
  });

  it("ignores finished runs", () => {
    const done = run("a", "passed", [entry("ci.yml", "g")]);
    expect(decideAdmission(run("b", "queued", [entry("ci.yml", "g")]), [done]).outcome).toBe(
      "admit",
    );
  });

  it("cancels in one group and waits in another", () => {
    const tests = run("a", "running", [entry("test.yml", "test")]);
    const deploy = run("b", "running", [entry("deploy.yml", "deploy")]);
    const self = run("c", "queued", [
      entry("test.yml", "test", true),
      entry("deploy.yml", "deploy"),
    ]);
    const decision = decideAdmission(self, [tests, deploy]);
    expect(decision.outcome).toBe("wait");
    expect(decision.blocker).toEqual({ group: "deploy", runId: "b" });
    expect(decision.cancelPipelines).toEqual([{ runId: "a", files: ["test.yml"] }]);
  });
});

describe("a fork's groups", () => {
  it("are its pull request's own: it cannot cancel, hold up or supersede the repository's runs", () => {
    const fork = groupScope({ fromFork: true, pullNumber: 12 });
    expect(fork).toBe("fork:pull/12:");
    expect(groupScope({ fromFork: false, pullNumber: 12 })).toBe("");

    const deploy = run("deploy", "running", [entry("deploy.yml", "deploy")]);
    const waitingDeploy = run("deploy-2", "pending", [entry("deploy.yml", "deploy")]);
    // An approved fork naming the deploy group, newer than both.
    const forkRun = run("fork", "queued", [entry("deploy.yml", "deploy", true)], undefined, fork);
    expect(decideAdmission(forkRun, [deploy, waitingDeploy])).toEqual({
      outcome: "admit",
      blocker: null,
      cancelPending: [],
      cancelPipelines: [],
    });
    // And the repository's own runs do not see it either.
    const later = run("deploy-3", "queued", [entry("deploy.yml", "deploy", true)]);
    const runningFork = { ...forkRun, status: "running" };
    expect(decideAdmission(later, [runningFork]).cancelPipelines).toEqual([]);

    // Two commits of the same fork's pull request share its groups.
    const next = run("fork-2", "queued", [entry("deploy.yml", "Deploy", true)], undefined, fork);
    expect(decideAdmission(next, [runningFork])).toMatchObject({
      outcome: "admit",
      cancelPipelines: [{ runId: "fork", files: ["deploy.yml"] }],
    });
  });
});

describe("activeGroups", () => {
  it("lowercases groups and leaves out cancelled pipelines", () => {
    const groups = activeGroups([
      entry("a.yml", "Deploy", false),
      entry("b.yml", "deploy", true),
      entry("c.yml", "gone", true, true),
      entry("d.yml", null),
    ]);
    expect([...groups]).toEqual([["deploy", true]]);
  });
});

describe("entriesFrom", () => {
  it("reads the runners' answer and drops what it cannot use", () => {
    expect(
      entriesFrom({
        pipelines: [
          {
            file: ".infrawrench/ci/test.yml",
            name: "Test",
            concurrency: { group: "test-main", "cancel-in-progress": true },
          },
          { file: ".infrawrench/ci/lint.yml", name: "Lint", concurrency: null },
          { file: 3, name: "bad" },
          { file: "x.yml", concurrency: { group: "" } },
        ],
      }),
    ).toEqual([
      {
        file: ".infrawrench/ci/test.yml",
        pipeline: "Test",
        group: "test-main",
        cancelInProgress: true,
      },
      { file: ".infrawrench/ci/lint.yml", pipeline: "Lint", group: null, cancelInProgress: false },
      { file: "x.yml", pipeline: "x.yml", group: null, cancelInProgress: false },
    ]);
    expect(entriesFrom({})).toEqual([]);
  });
});
