import { beforeEach, describe, expect, it, vi } from "vitest";

// The status pass's own clocks: what it does every time it comes round
// (every second), and what it spaces out. Its steps are stubs.
const calls: string[] = [];
const state = {
  live: true,
  running: [] as Array<{ id: string }>,
  synced: [] as Array<{ id: string; jobChecks: boolean | undefined }>,
};
const note = (name: string) => async () => {
  calls.push(name);
};

vi.mock("../proxy.js", () => ({ ciProxyConfigured: () => true }));
vi.mock("../billing.js", () => ({
  reportRunUsage: vi.fn(),
  reportStorage: vi.fn(),
  sampleStorage: vi.fn(),
}));
vi.mock("../schedules.js", () => ({
  fireDueSchedules: note("fire"),
  refreshSchedules: note("refresh"),
}));
vi.mock("../concurrency.js", () => ({
  admitRun: vi.fn(),
  pendingRuns: async () => {
    calls.push("pending");
    return [];
  },
}));
vi.mock("../runs.js", () => ({
  anyLiveRun: async () => {
    calls.push("live");
    return state.live;
  },
  dispatchRun: vi.fn(),
  dueQueuedRunIds: async () => {
    calls.push("queued");
    return [];
  },
  expireApprovals: vi.fn(),
  runningRuns: async () => {
    calls.push("running");
    return state.running;
  },
  syncRun: async (row: { id: string }, opts?: { jobChecks?: boolean }) => {
    state.synced.push({ id: row.id, jobChecks: opts?.jobChecks });
  },
}));

const { JOB_CHECKS_EVERY_MS, SCHEDULES_EVERY_MS, resetCiStatusClocks, runCiStatusPass } =
  await import("../pass");

let clock = 0;
const now = () => clock;

beforeEach(() => {
  resetCiStatusClocks();
  calls.length = 0;
  state.live = true;
  state.running = [];
  state.synced = [];
  clock = 1_000_000;
});

describe("the CI status pass", () => {
  it("is one read when no run is waiting or going", async () => {
    state.live = false;
    await runCiStatusPass(now);
    expect(calls).toEqual(["fire", "refresh", "live"]);
    calls.length = 0;
    clock += 1_000;
    await runCiStatusPass(now);
    expect(calls).toEqual(["live"]);
  });

  it("fires and re-reads schedules on their own clock, not every second", async () => {
    for (let i = 0; i < 6; i++) {
      await runCiStatusPass(now);
      clock += 1_000;
    }
    expect(SCHEDULES_EVERY_MS).toBe(5_000);
    // At 0s and at 5s.
    expect(calls.filter((c) => c === "fire")).toHaveLength(2);
    // Runs are looked for every time.
    expect(calls.filter((c) => c === "running")).toHaveLength(6);
  });

  it("follows a running run every pass, and writes its job checks less often", async () => {
    state.running = [{ id: "a" }];
    for (let i = 0; i < 6; i++) {
      await runCiStatusPass(now);
      clock += 1_000;
    }
    expect(JOB_CHECKS_EVERY_MS).toBe(5_000);
    expect(state.synced.map((s) => s.jobChecks)).toEqual([true, false, false, false, false, true]);
  });

  it("writes a run's job checks the first time it sees it, whenever that is", async () => {
    state.running = [{ id: "a" }];
    await runCiStatusPass(now);
    clock += 1_000;
    state.running = [{ id: "a" }, { id: "b" }];
    await runCiStatusPass(now);
    expect(state.synced).toEqual([
      { id: "a", jobChecks: true },
      { id: "a", jobChecks: false },
      { id: "b", jobChecks: true },
    ]);
  });

  it("forgets a run that is no longer running", async () => {
    state.running = [{ id: "a" }];
    await runCiStatusPass(now);
    state.running = [];
    clock += 1_000;
    await runCiStatusPass(now);
    // The same id again (never in practice) starts from nothing.
    state.running = [{ id: "a" }];
    clock += 1_000;
    await runCiStatusPass(now);
    expect(state.synced.map((s) => s.jobChecks)).toEqual([true, true]);
  });
});
