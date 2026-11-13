import { describe, expect, it } from "vitest";
import { handle, type Deps } from "../app";
import { byPlacement, Pool, type Capacity } from "../pool";
import { MemoryRunnerList } from "../runners";
import { MemoryStore } from "../store";
import { MemoryValues } from "../values";

const GiB = 1024 ** 3;
const PROXY_KEY = "proxy-test-key-not-a-real-secret";
const RUNNER_KEY = "runner-test-key-not-a-real-secret";

function capacity(c: Partial<Capacity> & { name: string }): Capacity {
  return {
    url: `http://${c.name}.test`,
    up: true,
    draining: false,
    version: "0.3.13",
    slotsTotal: 32,
    slotsFree: 32,
    runsActive: 0,
    memoryTotal: null,
    memoryUsed: null,
    memoryWaiting: null,
    v8HeapSpaceTotal: null,
    v8HeapSpaceUsed: null,
    v8LostIsolates: null,
    ...c,
  };
}

const order = (runners: Capacity[]) => [...runners].sort(byPlacement).map((r) => r.name);

// ci-2 as `/v1/capacity` reported it at 01:33 on 2026-11-13 (#1089): 60 of
// 64 slots free, three runs, 24 of 26 GiB reserved by the oldest run's four
// Test jobs (6 GiB each). ci-1 back from its update, idle. Its budget is a
// stand-in; the issue does not give it.
const ci2AtIncident = capacity({
  name: "ci-2",
  slotsTotal: 64,
  slotsFree: 60,
  runsActive: 3,
  memoryTotal: 26 * GiB,
  memoryUsed: 24 * GiB,
});
const ci1Idle = capacity({ name: "ci-1", memoryTotal: 24 * GiB, memoryUsed: 0 });

describe("byPlacement", () => {
  it("puts the idle runner ahead of the one with its memory reserved (#1089)", () => {
    // By slots alone ci-2 (60 free) beat ci-1 (32 free).
    expect(order([ci2AtIncident, ci1Idle])).toEqual(["ci-1", "ci-2"]);
    // The same once ci-2 says what its two other runs' jobs wait for.
    const reporting = { ...ci2AtIncident, memoryWaiting: 12 * GiB };
    expect(order([reporting, ci1Idle])).toEqual(["ci-1", "ci-2"]);
  });

  it("shares a runner's job memory among its runs, the new one included", () => {
    // a: (24 + 12) / 2 / 2 = 9 GiB a run; b: (26 + 20) / 2 / 3 = 7.7 GiB.
    const a = capacity({ name: "a", runsActive: 1, memoryTotal: 24 * GiB, memoryUsed: 12 * GiB });
    const b = capacity({
      name: "b",
      slotsTotal: 64,
      slotsFree: 50,
      runsActive: 2,
      memoryTotal: 26 * GiB,
      memoryUsed: 6 * GiB,
    });
    expect(order([b, a])).toEqual(["a", "b"]);
    // With as many runs, what is free now decides: a's whole budget held
    // gives (24 + 0) / 2 / 2 = 6 GiB a run against b's 7.7.
    expect(order([{ ...a, runsActive: 2, memoryUsed: 24 * GiB }, b])).toEqual(["b", "a"]);
    // A queued job's ask counts against room like a held reservation:
    // 24 GiB waiting takes b to (26 - 4) / 2 / 3 = 3.7 GiB.
    expect(
      order([
        { ...a, runsActive: 2, memoryUsed: 24 * GiB },
        { ...b, memoryWaiting: 24 * GiB },
      ]),
    ).toEqual(["a", "b"]);
  });

  it("ranks a sliver of free memory by the runs that share it (#1132)", () => {
    // ci-1 and ci-2 at 16:33 UTC on 2026-11-13: ci-1 (2 runs) had none of
    // its job memory free, ci-2 (4 runs) 2 GiB. ci-1: (24 + 0) / 2 / 3 = 4
    // GiB a run; ci-2: (26 + 2) / 2 / 5 = 2.8.
    const ci1 = capacity({
      name: "ci-1",
      runsActive: 2,
      slotsFree: 30,
      memoryTotal: 24 * GiB,
      memoryUsed: 24 * GiB,
      memoryWaiting: 0,
    });
    const ci2 = capacity({
      name: "ci-2",
      runsActive: 4,
      slotsTotal: 64,
      slotsFree: 60,
      memoryTotal: 26 * GiB,
      memoryUsed: 24 * GiB,
      memoryWaiting: 0,
    });
    expect(order([ci2, ci1])).toEqual(["ci-1", "ci-2"]);
  });

  it("ranks runners that report no budget last, and a full pool by its backlog", () => {
    const full = capacity({
      name: "full",
      slotsTotal: 64,
      slotsFree: 60,
      runsActive: 1,
      memoryTotal: 26 * GiB,
      memoryUsed: 24 * GiB,
      memoryWaiting: 6 * GiB,
    });
    const busier = capacity({
      name: "busier",
      runsActive: 2,
      memoryTotal: 24 * GiB,
      memoryUsed: 24 * GiB,
      memoryWaiting: 30 * GiB,
    });
    const busiest = { ...busier, name: "busiest", runsActive: 1, memoryWaiting: 40 * GiB };
    const unknown = capacity({ name: "unknown", slotsFree: 1, runsActive: 7 });
    const tight = capacity({
      name: "tight",
      slotsFree: 2,
      runsActive: 5,
      memoryTotal: 24 * GiB,
      memoryUsed: 23 * GiB,
    });
    // full: (26 - 4) / 2 / 2 = 5.5 GiB a run; tight: (24 + 1) / 2 / 6 = 2.1;
    // busier and busiest are owed more than their whole budget, so nothing,
    // and the one with less waiting goes first.
    expect(order([busiest, busier, full, unknown, tight])).toEqual([
      "full",
      "tight",
      "busier",
      "busiest",
      "unknown",
    ]);
  });

  it("weighs a runner by the V8 heap space its Node jobs share", () => {
    const same = { runsActive: 1, memoryTotal: 24 * GiB, memoryUsed: 6 * GiB, memoryWaiting: 0 };
    const roomy = capacity({
      name: "roomy",
      ...same,
      v8HeapSpaceTotal: 3.5 * GiB,
      v8HeapSpaceUsed: 0.5 * GiB,
    });
    const heapFull = capacity({
      name: "heap-full",
      ...same,
      slotsTotal: 64,
      slotsFree: 63,
      v8HeapSpaceTotal: 3.5 * GiB,
      v8HeapSpaceUsed: 3.5 * GiB,
    });
    expect(order([heapFull, roomy])).toEqual(["roomy", "heap-full"]);
    // At worst it halves a runner's share: with one run instead of three,
    // the full heap still wins.
    expect(order([heapFull, { ...roomy, runsActive: 3 }])).toEqual(["heap-full", "roomy"]);
    // Not reported counts as free.
    expect(order([heapFull, { ...roomy, v8HeapSpaceTotal: null, v8HeapSpaceUsed: null }])).toEqual([
      "roomy",
      "heap-full",
    ]);
  });

  it("falls back to slots, then active runs, then the name", () => {
    const same = { memoryTotal: 24 * GiB, memoryUsed: 6 * GiB, memoryWaiting: 0 };
    expect(
      order([
        capacity({ name: "c", slotsFree: 10, runsActive: 1, ...same }),
        capacity({ name: "b", slotsFree: 20, runsActive: 1, ...same }),
        capacity({ name: "a", slotsFree: 10, runsActive: 1, ...same }),
      ]),
    ).toEqual(["b", "a", "c"]);
    expect(
      order([
        capacity({ name: "x", slotsFree: 4, runsActive: 2 }),
        capacity({ name: "y", slotsFree: 4, runsActive: 1 }),
      ]),
    ).toEqual(["y", "x"]);
  });
});

/** Just enough of `iwci serve` for placement: capacity and taking a run. */
class Runner {
  runs = 0;
  draining = false;
  v8: { total: number; used: number; lost: number } | null = null;
  constructor(
    readonly url: string,
    readonly slotsTotal: number,
    public memory: { total: number; used: number; waiting?: number },
    /** What each run it takes holds and queues; a Test job is 6 GiB. */
    readonly perRun: { used: number; waiting: number },
    public refuse = false,
  ) {}

  handle(path: string, init: RequestInit): Response {
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    if (new Headers(init.headers).get("Authorization") !== `Bearer ${RUNNER_KEY}`)
      return json(401, {});
    if (path === "/v1/capacity")
      return json(200, {
        draining: this.draining,
        version: "0.3.13",
        slots_total: this.slotsTotal,
        slots_free: this.slotsTotal - this.runs,
        runs_active: this.runs,
        memory_total: this.memory.total,
        memory_used: this.memory.used,
        ...(this.memory.waiting === undefined ? {} : { memory_waiting: this.memory.waiting }),
        ...(this.v8 === null
          ? {}
          : {
              v8_heap_space_total: this.v8.total,
              v8_heap_space_used: this.v8.used,
              v8_lost_isolates: this.v8.lost,
            }),
      });
    if (path === "/v1/runs" && init.method === "POST") {
      if (this.refuse || this.draining) return json(429, { error: "at capacity" });
      this.runs++;
      this.memory.used = Math.min(this.memory.total, this.memory.used + this.perRun.used);
      this.memory.waiting = (this.memory.waiting ?? 0) + this.perRun.waiting;
      return json(202, { id: this.runs.toString(16).padStart(32, "0"), state: "running" });
    }
    return json(404, {});
  }
}

function proxy(runners: Record<string, Runner>) {
  const fetchFn = async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const runner = Object.values(runners).find((r) => r.url === url.origin);
    if (!runner) throw new Error("no such host");
    return runner.handle(url.pathname + url.search, init);
  };
  const list = Object.entries(runners)
    .map(([name, r]) => `${name}=${r.url}`)
    .join(",");
  const deps: Deps = {
    pool: Pool.fromList(list, RUNNER_KEY, fetchFn),
    runnerList: new MemoryRunnerList(),
    store: new MemoryStore(),
    values: new MemoryValues(),
    secretsKey: null,
    proxyKey: PROXY_KEY,
    now: () => 1_800_000_000,
  };
  const call = (method: string, path: string, body?: unknown) =>
    handle(
      new Request(`https://proxy.example${path}`, {
        method,
        headers: { Authorization: `Bearer ${PROXY_KEY}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      deps,
    );
  const run = async () => {
    const res = await call("POST", "/v1/runs", {
      repo: "https://github.com/acme/web",
      branch: "main",
    });
    return res.status === 202
      ? ((await res.json()) as { id: string }).id.split(".")[0]
      : res.status;
  };
  return { call, run };
}

describe("placement", () => {
  it("spreads the incident's three runs over both runners", async () => {
    // Three runs of the main pipeline in quick succession, as between 01:05
    // and 01:20 on 2026-11-13: each one's Test jobs hold what they can and
    // queue the rest. By free slots all three went to ci-2.
    const perRun = { used: 24 * GiB, waiting: 30 * GiB };
    const { run } = proxy({
      "ci-1": new Runner("http://ci-1.test", 32, { total: 24 * GiB, used: 0, waiting: 0 }, perRun),
      "ci-2": new Runner("http://ci-2.test", 64, { total: 26 * GiB, used: 0, waiting: 0 }, perRun),
    });
    expect(await run()).toBe("ci-2");
    expect(await run()).toBe("ci-1");
    // Both are full now; the third goes where less is already waiting
    // (ci-2: 26 - 24 - 30 = -28 GiB; ci-1: 24 - 24 - 30 = -30 GiB) instead
    // of being refused.
    expect(await run()).toBe("ci-2");
  });

  it("spreads a burst over a runner with a sliver free and a full one with fewer runs (#1132)", async () => {
    // 16:33 UTC on 2026-11-13. ci-1 had two runs and all 24 GiB of its job
    // memory reserved; ci-2 had four, 24 of its 26 GiB reserved and nothing
    // ready to start (its runs' other jobs waited on their needs, which
    // memory_waiting does not count). ci-2's 2 GiB put it ahead of ci-1
    // whatever its run count, and nine runs in 14 minutes all went to it.
    // A new run holds nothing until its jobs start.
    const ci1 = new Runner(
      "http://ci-1.test",
      32,
      { total: 24 * GiB, used: 24 * GiB, waiting: 0 },
      { used: 0, waiting: 0 },
    );
    ci1.runs = 2;
    const ci2 = new Runner(
      "http://ci-2.test",
      64,
      { total: 26 * GiB, used: 24 * GiB, waiting: 0 },
      { used: 0, waiting: 0 },
    );
    ci2.runs = 4;
    const { run } = proxy({ "ci-1": ci1, "ci-2": ci2 });
    const placed: Array<string | number | undefined> = [];
    for (let i = 0; i < 9; i++) placed.push(await run());
    expect(placed.filter((r) => r === "ci-1")).toHaveLength(5);
    expect(placed.filter((r) => r === "ci-2")).toHaveLength(4);
    expect(ci1.runs).toBe(7);
    expect(ci2.runs).toBe(8);
  });

  it("sends runs to a runner again as soon as it stops draining", async () => {
    const ci1 = new Runner(
      "http://ci-1.test",
      32,
      { total: 24 * GiB, used: 0, waiting: 0 },
      { used: 0, waiting: 0 },
    );
    ci1.draining = true;
    const ci2 = new Runner(
      "http://ci-2.test",
      64,
      { total: 26 * GiB, used: 0, waiting: 0 },
      { used: 0, waiting: 0 },
    );
    const { run } = proxy({ "ci-1": ci1, "ci-2": ci2 });
    expect(await run()).toBe("ci-2");
    expect(await run()).toBe("ci-2");
    // Restarted as the new release: idle, and the next run is its.
    ci1.draining = false;
    expect(await run()).toBe("ci-1");
    expect(await run()).toBe("ci-1");
    expect(await run()).toBe("ci-2");
  });

  it("weighs held memory for a runner from before memory_waiting", async () => {
    const { run } = proxy({
      "ci-1": new Runner(
        "http://ci-1.test",
        32,
        { total: 24 * GiB, used: 0 },
        { used: 0, waiting: 0 },
      ),
      "ci-2": new Runner(
        "http://ci-2.test",
        64,
        { total: 26 * GiB, used: 24 * GiB },
        { used: 0, waiting: 0 },
      ),
    });
    expect(await run()).toBe("ci-1");
  });

  it("passes over a runner that refuses, and places on a full one rather than refuse", async () => {
    const ci1 = new Runner(
      "http://ci-1.test",
      32,
      { total: 24 * GiB, used: 0, waiting: 0 },
      {
        used: 0,
        waiting: 0,
      },
    );
    ci1.refuse = true;
    const ci2 = new Runner(
      "http://ci-2.test",
      64,
      { total: 26 * GiB, used: 26 * GiB, waiting: 18 * GiB },
      {
        used: 0,
        waiting: 0,
      },
    );
    const { run } = proxy({ "ci-1": ci1, "ci-2": ci2 });
    expect(await run()).toBe("ci-2");
    ci2.refuse = true;
    expect(await run()).toBe(429);
  });

  it("shows each runner's job memory and V8 heap space in /v1/capacity", async () => {
    const ci2 = new Runner(
      "http://ci-2.test",
      64,
      { total: 26 * GiB, used: 24 * GiB, waiting: 12 * GiB },
      { used: 0, waiting: 0 },
    );
    ci2.v8 = { total: 3.5 * GiB, used: 3 * GiB, lost: 3 };
    const { call } = proxy({
      "ci-1": new Runner(
        "http://ci-1.test",
        32,
        { total: 24 * GiB, used: 6 * GiB },
        { used: 0, waiting: 0 },
      ),
      "ci-2": ci2,
    });
    const body = (await (await call("GET", "/v1/capacity")).json()) as {
      runners: Array<Record<string, unknown>>;
    };
    expect(body.runners).toEqual([
      expect.objectContaining({
        name: "ci-1",
        memory_total: 24 * GiB,
        memory_used: 6 * GiB,
        memory_waiting: null,
        v8_heap_space_total: null,
        v8_heap_space_used: null,
        v8_lost_isolates: null,
      }),
      expect.objectContaining({
        name: "ci-2",
        memory_total: 26 * GiB,
        memory_used: 24 * GiB,
        memory_waiting: 12 * GiB,
        v8_heap_space_total: 3.5 * GiB,
        v8_heap_space_used: 3 * GiB,
        v8_lost_isolates: 3,
      }),
    ]);
  });
});
