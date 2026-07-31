import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Claim mock: the loop's only source of work ---
const claimDueAccounts = vi.fn();
const claimDueWorkflows = vi.fn();
vi.mock("./claim", () => ({
  claimDueAccounts: (...a: unknown[]) => claimDueAccounts(...a),
  claimDueWorkflows: (...a: unknown[]) => claimDueWorkflows(...a),
}));

// --- DB mock: only the workflow-reschedule update path remains in the loop ---
const updateWhere = vi.fn();
const updateSet = vi.fn((_values: unknown) => ({ where: updateWhere }));
const update = vi.fn((_table: unknown) => ({ set: updateSet }));
vi.mock("@infrawrench/server-core/db/client", () => ({
  db: { update: (t: unknown) => update(t) },
}));

// The loop itself only touches `workflows`, but running a workflow can page,
// and paging reaches Slack and Microsoft Teams — so the schema mock has to
// cover what that import chain reads, not just what the loop reads.
vi.mock("@infrawrench/server-core/db/schema", () => ({
  workflows: { id: "id" },
  slackChannels: { id: "id" },
  slackInstallations: { id: "id" },
  msteamsWebhooks: { id: "id" },
  // The digest's claim columns are read at module scope (`DUE_COLUMNS` in
  // `digest/weekly.ts`), so they have to exist on the mock even though this
  // suite only asserts that the digest pass is called.
  orgDigestSettings: {
    organizationId: "organizationId",
    timezone: "timezone",
    sendDay: "sendDay",
    sendHour: "sendHour",
    narrativeEnabled: "narrativeEnabled",
    attemptCount: "attemptCount",
    lastSentWeekStart: "lastSentWeekStart",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
}));

const pollAccount = vi.fn();
vi.mock("./poll-account", () => ({
  pollAccount: (...a: unknown[]) => pollAccount(...a),
}));

const runOrgWorkflow = vi.fn();
vi.mock("@infrawrench/server-core/workflows/runner", () => ({
  runOrgWorkflow: (...a: unknown[]) => runOrgWorkflow(...a),
}));

const pruneResourceChanges = vi.fn();
vi.mock("@infrawrench/server-core/resource-changes", () => ({
  pruneResourceChanges: (...a: unknown[]) => pruneResourceChanges(...a),
  CHANGE_RETENTION_INTERVAL_MS: 60 * 60 * 1000,
}));

import { PollerLoop } from "./loop";

function row(id: string) {
  return {
    id,
    organizationId: "org",
    pluginId: "aws",
    displayName: id,
    pollFailureCount: 0,
  };
}

function workflowRow(id: string, trigger: unknown) {
  return { id, organizationId: "org", trigger };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  claimDueAccounts.mockResolvedValue([]);
  claimDueWorkflows.mockResolvedValue([]);
  pollAccount.mockResolvedValue(undefined);
  runOrgWorkflow.mockResolvedValue(undefined);
  updateWhere.mockResolvedValue(undefined);
  pruneResourceChanges.mockResolvedValue({
    cutoff: new Date(0),
    organizationsScanned: 0,
    deleted: 0,
    failed: 0,
    truncated: false,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("PollerLoop", () => {
  it("does nothing on a tick when no rows are due", async () => {
    const loop = new PollerLoop();
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(pollAccount).not.toHaveBeenCalled();
    expect(runOrgWorkflow).not.toHaveBeenCalled();
    await loop.stop();
  });

  it("polls each claimed account on the first immediate tick", async () => {
    claimDueAccounts.mockResolvedValue([row("a"), row("b")]);
    const loop = new PollerLoop({ concurrency: 8 });
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(pollAccount).toHaveBeenCalledTimes(2);
    await loop.stop();
  });

  it("passes the shared bucket registry to pollAccount", async () => {
    claimDueAccounts.mockResolvedValue([row("a")]);
    const loop = new PollerLoop();
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(pollAccount).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a" }),
      expect.anything(),
    );
    // same registry reused across ticks
    const firstReg = pollAccount.mock.calls[0]![1];
    await vi.advanceTimersByTimeAsync(15_000);
    const secondReg = pollAccount.mock.calls[pollAccount.mock.calls.length - 1]![1];
    expect(secondReg).toBe(firstReg);
    await loop.stop();
  });

  it("claims with the configured concurrency", async () => {
    const loop = new PollerLoop({ concurrency: 3 });
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(claimDueAccounts).toHaveBeenCalledWith(3);
    await loop.stop();
  });

  it("schedules subsequent ticks on the configured interval", async () => {
    claimDueAccounts.mockResolvedValue([row("a")]);
    const loop = new PollerLoop({ tickMs: 5_000 });
    loop.start();
    await vi.advanceTimersByTimeAsync(0); // first immediate tick
    expect(pollAccount).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000); // second tick
    expect(pollAccount).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_000); // third tick
    expect(pollAccount).toHaveBeenCalledTimes(3);
    await loop.stop();
  });

  it("swallows a failing pollAccount so other accounts still run", async () => {
    claimDueAccounts.mockResolvedValue([row("a"), row("b")]);
    pollAccount.mockRejectedValueOnce(new Error("nope"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const loop = new PollerLoop();
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(pollAccount).toHaveBeenCalledTimes(2);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
    await loop.stop();
  });

  it("logs and recovers when the account claim throws during a tick", async () => {
    claimDueAccounts.mockRejectedValueOnce(new Error("db down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const loop = new PollerLoop();
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(errSpy).toHaveBeenCalledWith("[poller] tick failed:", expect.any(Error));
    // next tick still works
    claimDueAccounts.mockResolvedValue([row("a")]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(pollAccount).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
    await loop.stop();
  });

  it("start() is idempotent (does not double-schedule)", async () => {
    claimDueAccounts.mockResolvedValue([row("a")]);
    const loop = new PollerLoop();
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(15_000);
    const callsAfterTwoTicks = pollAccount.mock.calls.length;
    loop.start(); // timer already set -> no-op
    await vi.advanceTimersByTimeAsync(15_000);
    // only one additional tick worth of polls
    expect(pollAccount.mock.calls.length).toBe(callsAfterTwoTicks + 1);
    await loop.stop();
  });

  it("stop() clears the timer and prevents further ticks", async () => {
    claimDueAccounts.mockResolvedValue([row("a")]);
    const loop = new PollerLoop();
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(pollAccount).toHaveBeenCalledTimes(1);
    await loop.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pollAccount).toHaveBeenCalledTimes(1);
  });

  it("stop() waits for an in-flight tick to drain", async () => {
    let resolvePoll: () => void = () => {};
    claimDueAccounts.mockResolvedValue([row("a")]);
    pollAccount.mockImplementation(
      () =>
        new Promise<void>((r) => {
          resolvePoll = r;
        }),
    );
    const loop = new PollerLoop();
    loop.start();
    await vi.advanceTimersByTimeAsync(0); // tick begins, pollAccount pending
    const stopPromise = loop.stop();
    // drain loop polls every 100ms; resolve the in-flight poll then let it settle
    resolvePoll();
    await vi.advanceTimersByTimeAsync(200);
    await stopPromise;
    expect(pollAccount).toHaveBeenCalledTimes(1);
  });

  it("skips overlapping ticks when one is still running", async () => {
    let resolvePoll: () => void = () => {};
    claimDueAccounts.mockResolvedValue([row("a")]);
    pollAccount.mockImplementationOnce(
      () =>
        new Promise<void>((r) => {
          resolvePoll = r;
        }),
    );
    const loop = new PollerLoop({ tickMs: 1_000 });
    loop.start();
    await vi.advanceTimersByTimeAsync(0); // first tick running, blocked on pollAccount
    // even though we advance, the running guard prevents a second concurrent tick
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pollAccount).toHaveBeenCalledTimes(1);
    resolvePoll();
    await vi.advanceTimersByTimeAsync(0); // let the in-flight tick settle
    const stopPromise = loop.stop();
    await vi.advanceTimersByTimeAsync(200); // drain loop
    await stopPromise;
  });
});

describe("PollerLoop change-timeline retention", () => {
  it("prunes on the first tick", async () => {
    const loop = new PollerLoop();
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(pruneResourceChanges).toHaveBeenCalledTimes(1);
    await loop.stop();
  });

  it("does not prune again on every tick", async () => {
    const loop = new PollerLoop({ tickMs: 1_000 });
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10_000); // ten more ticks
    expect(pruneResourceChanges).toHaveBeenCalledTimes(1);
    await loop.stop();
  });

  it("prunes again once the hourly interval has elapsed", async () => {
    const loop = new PollerLoop({ tickMs: 60_000 });
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(pruneResourceChanges).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(pruneResourceChanges).toHaveBeenCalledTimes(2);
    await loop.stop();
  });

  it("swallows a failing prune so account polling still runs", async () => {
    claimDueAccounts.mockResolvedValue([row("a")]);
    pruneResourceChanges.mockRejectedValueOnce(new Error("db down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const loop = new PollerLoop();
    loop.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(pollAccount).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith("[poller] retention tick failed:", expect.any(Error));
    errSpy.mockRestore();
    await loop.stop();
  });

  it("does not retry a failed prune before the next interval", async () => {
    pruneResourceChanges.mockRejectedValueOnce(new Error("db down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const loop = new PollerLoop({ tickMs: 1_000 });
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(pruneResourceChanges).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
    await loop.stop();
  });
});

describe("PollerLoop workflows", () => {
  it("runs a claimed cron workflow and reschedules it to its true next fire", async () => {
    claimDueWorkflows.mockResolvedValue([
      workflowRow("w1", { kind: "cron", expression: "*/5 * * * *" }),
    ]);
    const loop = new PollerLoop();
    loop.start();
    await vi.advanceTimersByTimeAsync(0);

    // The 10-minute claim lease gets replaced with the real cron next-fire.
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ nextRunAt: expect.any(Date) }),
    );
    expect(runOrgWorkflow).toHaveBeenCalledWith({
      organizationId: "org",
      workflowId: "w1",
      triggerSource: "cron",
    });
    await loop.stop();
  });

  it("de-schedules a workflow whose trigger is no longer parseable cron", async () => {
    claimDueWorkflows.mockResolvedValue([
      workflowRow("w1", { kind: "cron", expression: "not a cron" }),
    ]);
    const loop = new PollerLoop();
    loop.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ nextRunAt: null }));
    // It still runs this one time — de-scheduling only stops future fires.
    expect(runOrgWorkflow).toHaveBeenCalledTimes(1);
    await loop.stop();
  });

  it("swallows a failing workflow run so other workflows and accounts continue", async () => {
    claimDueAccounts.mockResolvedValue([row("a")]);
    claimDueWorkflows.mockResolvedValue([
      workflowRow("w1", { kind: "cron", expression: "*/5 * * * *" }),
      workflowRow("w2", { kind: "cron", expression: "*/5 * * * *" }),
    ]);
    runOrgWorkflow.mockRejectedValueOnce(new Error("boom"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const loop = new PollerLoop();
    loop.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(runOrgWorkflow).toHaveBeenCalledTimes(2);
    expect(pollAccount).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith("[poller] workflow w1 run failed:", expect.any(Error));
    errSpy.mockRestore();
    await loop.stop();
  });

  it("still runs the workflow when the reschedule write fails (lease bounds the retry)", async () => {
    claimDueWorkflows.mockResolvedValue([
      workflowRow("w1", { kind: "cron", expression: "*/5 * * * *" }),
    ]);
    updateWhere.mockRejectedValueOnce(new Error("db down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const loop = new PollerLoop();
    loop.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(runOrgWorkflow).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith(
      "[poller] workflow w1 reschedule failed:",
      expect.any(Error),
    );
    errSpy.mockRestore();
    await loop.stop();
  });

  it("logs and recovers when the workflow claim throws", async () => {
    claimDueAccounts.mockResolvedValue([row("a")]);
    claimDueWorkflows.mockRejectedValueOnce(new Error("db down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const loop = new PollerLoop();
    loop.start();
    await vi.advanceTimersByTimeAsync(0);

    // Account polling in the same tick is unaffected.
    expect(pollAccount).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith("[poller] workflow tick failed:", expect.any(Error));
    errSpy.mockRestore();
    await loop.stop();
  });
});
