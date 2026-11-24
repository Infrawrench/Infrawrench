import { describe, expect, it } from "vitest";
import { handle, type Deps } from "../app";
import {
  byPlacement,
  coreShare,
  expectedSeconds,
  placementShare,
  Pool,
  runCores,
  type Capacity,
} from "../pool";
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
    cpus: null,
    memoryTotal: null,
    memoryUsed: null,
    memoryWaiting: null,
    v8LostIsolates: null,
    v8LostHeap: null,
    split: false,
    runsHelping: 0,
    notify: false,
    platforms: ["wasm"],
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

  it("places by job memory alone, whatever a runner says of its V8 heaps (#1158)", () => {
    // Every V8 heap counts against its own job's memory and nothing is
    // shared between jobs' heaps, so what a runner has lost to V8 running
    // out of memory does not move it: it restarts itself when that is too
    // much, and is draining then.
    const same = { runsActive: 1, memoryTotal: 24 * GiB, memoryUsed: 6 * GiB, memoryWaiting: 0 };
    const clean = capacity({ name: "clean", ...same, slotsFree: 20 });
    const lossy = capacity({
      name: "lossy",
      ...same,
      slotsTotal: 64,
      slotsFree: 63,
      v8LostIsolates: 3,
      v8LostHeap: 1 * GiB,
    });
    // Equal shares and room: the free slots decide, not the losses.
    expect(placementShare(lossy)).toBe(placementShare(clean));
    expect(order([clean, lossy])).toEqual(["lossy", "clean"]);
    // (24 + 18) / 2 / 2 = 10.5 GiB a run, with no V8 factor.
    expect(placementShare(clean)).toBe(10.5 * GiB);
  });

  it("ignores the V8 heap space an older runner still reports", async () => {
    // Runners from before #1158 report `v8_heap_space_*`, an account of one
    // cage every job's heaps shared. A full one took up to half of a
    // runner's share; it no longer counts.
    const older = new Runner(
      "http://older.test",
      32,
      { total: 24 * GiB, used: 6 * GiB, waiting: 0 },
      { used: 0, waiting: 0 },
    );
    older.v8 = { lost: 0, lostHeap: 0 };
    older.legacyHeapSpace = { total: 3.5 * GiB, used: 3.5 * GiB };
    const newer = new Runner(
      "http://newer.test",
      32,
      { total: 24 * GiB, used: 7 * GiB, waiting: 0 },
      { used: 0, waiting: 0 },
    );
    // older: (24 + 18) / 2 = 21 GiB for its first run; newer: 20.5.
    const { run } = proxy({ older, newer });
    expect(await run()).toBe("older");
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

// The two production runners as `/v1/capacity` reports them idle: ci-1 is
// x86 with 8 cores and 24 GiB for jobs, ci-2 a Graviton with 16 and 25.7.
const ci1 = (c: Partial<Capacity> = {}) =>
  capacity({ name: "ci-1", cpus: 8, memoryTotal: 24 * GiB, memoryUsed: 0, memoryWaiting: 0, ...c });
const ci2 = (c: Partial<Capacity> = {}) =>
  capacity({
    name: "ci-2",
    cpus: 16,
    slotsTotal: 64,
    slotsFree: 64,
    memoryTotal: 25.7 * GiB,
    memoryUsed: 0,
    memoryWaiting: 0,
    ...c,
  });

describe("placement by expected time to finish", () => {
  const TYPICAL = 2400;
  const COLD = 4900;
  const seconds = (c: Capacity, work: number) => Math.round(expectedSeconds(c, work) ?? NaN);

  it("puts a typical pull request on the runner with twice the cores", () => {
    // ci-1 has 3 GiB of job memory a core, so its 8 cores are the limit:
    // 2,400 core-seconds take 300 s. ci-2 has 1.6 GiB a core, so memory
    // holds a run to 25.7 / 2 = 12.85 of its 16 cores: 187 s.
    expect(runCores(ci1())).toBe(8);
    expect(runCores(ci2())).toBeCloseTo(12.85);
    expect(seconds(ci1(), TYPICAL)).toBe(300);
    expect(seconds(ci2(), TYPICAL)).toBe(187);
    expect(order([ci1(), ci2()])).toEqual(["ci-2", "ci-1"]);
  });

  it("estimates a cold run at twice a typical one, in the same order", () => {
    // 4,900 core-seconds: over ten minutes on ci-1 alone, over six on ci-2.
    // The order of runners is the same for any amount of work.
    expect(seconds(ci1(), COLD)).toBe(613);
    expect(seconds(ci2(), COLD)).toBe(381);
    expect(order([ci1(), ci2()])).toEqual(["ci-2", "ci-1"]);
  });

  it("weighs cores where job memory per run says the opposite", () => {
    // Both have one run. ci-1's is in its tail (two jobs, 6 GiB held);
    // ci-2's is in full flow (four jobs, 18 GiB). By memory ci-1 offers a
    // new run more: (24 + 18) / 2 / 2 = 10.5 GiB against (25.7 + 7.7) / 2
    // / 2 = 8.35, and that was the whole ranking.
    const tail = ci1({ runsActive: 1, slotsFree: 30, memoryUsed: 6 * GiB });
    const flow = ci2({ runsActive: 1, slotsFree: 60, memoryUsed: 18 * GiB });
    expect(placementShare(tail)).toBeGreaterThan(placementShare(flow) ?? 0);
    // By cores: ci-1 (8 + 6) / 2 / 2 = 3.5; ci-2 (16 + 12) / 2 / 2 = 7,
    // held by memory to 8.35 / 2 = 4.2. The run ends two minutes sooner
    // on ci-2.
    expect(coreShare(tail)).toBe(3.5);
    expect(coreShare(flow)).toBe(7);
    expect(runCores(flow)).toBeCloseTo(4.175);
    expect(seconds(tail, TYPICAL)).toBe(686);
    expect(seconds(flow, TYPICAL)).toBe(575);
    expect(order([tail, flow])).toEqual(["ci-2", "ci-1"]);
  });

  it("keeps a run off a runner in full flow while the other is idle", () => {
    // ci-2 has more cores, but its one run holds 18 GiB in four jobs. A
    // second run there gets 4.2 cores' worth of memory; idle ci-1 gives 8.
    const flow = ci2({ runsActive: 1, slotsFree: 60, memoryUsed: 18 * GiB });
    expect(order([flow, ci1()])).toEqual(["ci-1", "ci-2"]);
    expect(seconds(ci1(), TYPICAL)).toBeLessThan(seconds(flow, TYPICAL));
  });

  it("splits by cores for each run when both runners are busy", () => {
    // ci-1 has one run, ci-2 two; every job that fits is running and none
    // waits. ci-1: (8 + 5) / 2 / 2 = 3.25 cores. ci-2: (16 + 12) / 2 / 3 =
    // 4.67, held by memory to (25.7 + 13.7) / 2 / 3 / 2 = 3.28. A third
    // run on ci-2 still gets more than a second on ci-1.
    const one = ci1({ runsActive: 1, slotsFree: 29, memoryUsed: 12 * GiB });
    const two = ci2({ runsActive: 2, slotsFree: 60, memoryUsed: 12 * GiB });
    expect(runCores(one)).toBe(3.25);
    expect(runCores(two)).toBeCloseTo(3.283);
    expect(order([one, two])).toEqual(["ci-2", "ci-1"]);
    // With ci-2's memory full and more queued, ci-1 is the sooner one:
    // (25.7 - 4.3) / 2 / 3 / 2 = 1.78 cores.
    const queued = { ...two, memoryUsed: 24 * GiB, memoryWaiting: 6 * GiB };
    expect(runCores(queued)).toBeCloseTo(1.783);
    expect(order([one, queued])).toEqual(["ci-1", "ci-2"]);
  });

  it("counts a running job as a busy core, and never more than there are", () => {
    // 40 jobs on 16 cores leave none idle: 16 / 2 / 2 = 4.
    expect(coreShare(ci2({ runsActive: 1, slotsFree: 24 }))).toBe(4);
    expect(coreShare(ci2({ runsActive: 1, slotsFree: 64 }))).toBe(8);
  });

  it("ranks a runner that reports no cores by its memory, as before", () => {
    // A runner that leaves `cpus` out: 24 GiB for one run is 12 cores'
    // worth, ahead of ci-1's 8 and behind ci-2's 12.85.
    const older = capacity({ name: "older", memoryTotal: 24 * GiB, memoryUsed: 0 });
    expect(coreShare(older)).toBeNull();
    expect(runCores(older)).toBe(12);
    expect(order([ci1(), older, ci2()])).toEqual(["ci-2", "older", "ci-1"]);
  });

  it("says a runner owed more than its budget never finishes, and one with no budget nothing", () => {
    const owed = ci1({ runsActive: 2, memoryUsed: 24 * GiB, memoryWaiting: 30 * GiB });
    expect(expectedSeconds(owed)).toBe(Infinity);
    expect(expectedSeconds(capacity({ name: "unknown", cpus: 8 }))).toBeNull();
  });
});

/** Just enough of `iwci serve` for placement: capacity and taking a run. */
class Runner {
  runs = 0;
  draining = false;
  v8: { lost: number; lostHeap: number } | null = null;
  /** What a runner from before #1158 also reports. */
  legacyHeapSpace: { total: number; used: number } | null = null;
  /** The cores it reports; a runner in the older tests reports none. */
  cpus: number | null = null;
  /** The platforms it reports; a runner in the older tests reports none. */
  platforms: string[] | null = null;
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
        ...(this.cpus === null ? {} : { cpus: this.cpus }),
        ...(this.platforms === null ? {} : { platforms: this.platforms }),
        memory_total: this.memory.total,
        memory_used: this.memory.used,
        ...(this.memory.waiting === undefined ? {} : { memory_waiting: this.memory.waiting }),
        ...(this.v8 === null
          ? {}
          : { v8_lost_isolates: this.v8.lost, v8_lost_heap: this.v8.lostHeap }),
        ...(this.legacyHeapSpace === null
          ? {}
          : {
              v8_heap_space_total: this.legacyHeapSpace.total,
              v8_heap_space_used: this.legacyHeapSpace.used,
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
  const run = async (platforms?: string[]) => {
    const res = await call("POST", "/v1/runs", {
      repo: "https://github.com/acme/web",
      branch: "main",
      ...(platforms === undefined ? {} : { platforms }),
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

  it("spreads a burst over idle runners in proportion to their cores", async () => {
    // Six pushes inside a few seconds, before any of them has started a
    // job: only `runs_active` moves. The first goes to ci-2 (12.85 cores
    // against 8), the second to ci-1 (8 against ci-2's 6.4 for a second
    // run), and so on: four to the 16 cores, two to the 8.
    const idle = { used: 0, waiting: 0 };
    const ci1 = new Runner("http://ci-1.test", 32, { total: 24 * GiB, used: 0, waiting: 0 }, idle);
    ci1.cpus = 8;
    const ci2 = new Runner(
      "http://ci-2.test",
      64,
      { total: 25.7 * GiB, used: 0, waiting: 0 },
      idle,
    );
    ci2.cpus = 16;
    const { run } = proxy({ "ci-1": ci1, "ci-2": ci2 });
    const placed: Array<string | number | undefined> = [];
    for (let i = 0; i < 6; i++) placed.push(await run());
    expect(placed).toEqual(["ci-2", "ci-1", "ci-2", "ci-2", "ci-1", "ci-2"]);
  });

  it("still splits the burst of #1132 when the runners report their cores", async () => {
    // The 16:33 state again, with `cpus`. Memory is what both are short
    // of, so it still decides most of it: ci-2's sixteen cores do not draw
    // the nine runs back onto the runner with four runs and 2 GiB free.
    // ci-1's eight cores among its growing runs cost it one of the five it
    // got by memory alone.
    const ci1 = new Runner(
      "http://ci-1.test",
      32,
      { total: 24 * GiB, used: 24 * GiB, waiting: 0 },
      { used: 0, waiting: 0 },
    );
    ci1.runs = 2;
    ci1.cpus = 8;
    const ci2 = new Runner(
      "http://ci-2.test",
      64,
      { total: 26 * GiB, used: 24 * GiB, waiting: 0 },
      { used: 0, waiting: 0 },
    );
    ci2.runs = 4;
    ci2.cpus = 16;
    const { run } = proxy({ "ci-1": ci1, "ci-2": ci2 });
    const placed: Array<string | number | undefined> = [];
    for (let i = 0; i < 9; i++) placed.push(await run());
    expect(placed.filter((r) => r === "ci-1")).toHaveLength(4);
    expect(placed.filter((r) => r === "ci-2")).toHaveLength(5);
  });

  it("shows what it ranks by in /v1/capacity", async () => {
    const ci1 = new Runner(
      "http://ci-1.test",
      32,
      { total: 24 * GiB, used: 0, waiting: 0 },
      { used: 0, waiting: 0 },
    );
    ci1.cpus = 8;
    const older = new Runner(
      "http://older.test",
      32,
      { total: 24 * GiB, used: 24 * GiB, waiting: 30 * GiB },
      { used: 0, waiting: 0 },
    );
    const { call } = proxy({ "ci-1": ci1, older });
    const body = (await (await call("GET", "/v1/capacity")).json()) as {
      runners: Array<Record<string, unknown>>;
    };
    expect(body.runners).toEqual([
      expect.objectContaining({ name: "ci-1", cpus: 8, run_cores: 8, expected_seconds: 300 }),
      // Owed more than its budget: no cores to expect, and no estimate.
      expect.objectContaining({ name: "older", cpus: null, run_cores: 0, expected_seconds: null }),
    ]);
  });

  it("shows each runner's job memory and V8 losses in /v1/capacity", async () => {
    const ci2 = new Runner(
      "http://ci-2.test",
      64,
      { total: 26 * GiB, used: 24 * GiB, waiting: 12 * GiB },
      { used: 0, waiting: 0 },
    );
    ci2.v8 = { lost: 3, lostHeap: 1.5 * GiB };
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
        v8_lost_isolates: null,
        v8_lost_heap: null,
      }),
      expect.objectContaining({
        name: "ci-2",
        memory_total: 26 * GiB,
        memory_used: 24 * GiB,
        memory_waiting: 12 * GiB,
        v8_lost_isolates: 3,
        v8_lost_heap: 1.5 * GiB,
      }),
    ]);
  });
});

describe("placement by platform", () => {
  const idle = (url: string, cpus: number) => {
    const r = new Runner(
      url,
      32,
      { total: 24 * GiB, used: 0, waiting: 0 },
      { used: 0, waiting: 0 },
    );
    r.cpus = cpus;
    return r;
  };

  it("reads a runner's platforms, and `wasm` alone from one that does not say", async () => {
    const bodies: Record<string, unknown> = {
      new: { slots_total: 4, slots_free: 4, runs_active: 0, platforms: ["wasm", "linux", null] },
      old: { slots_total: 4, slots_free: 4, runs_active: 0 },
      odd: { slots_total: 4, slots_free: 4, runs_active: 0, platforms: "linux" },
    };
    const pool = Pool.fromList(
      "new=http://new.test,old=http://old.test,odd=http://odd.test,gone=http://gone.test",
      RUNNER_KEY,
      async (input) => {
        const host = new URL(input).hostname.split(".")[0] ?? "";
        const body = bodies[host];
        if (body === undefined) throw new Error("connection refused");
        return new Response(JSON.stringify(body), {
          headers: { "Content-Type": "application/json" },
        });
      },
    );
    expect((await pool.capacity()).map((c) => [c.name, c.platforms])).toEqual([
      ["new", ["wasm", "linux"]],
      ["old", ["wasm"]],
      ["odd", ["wasm"]],
      // A runner that did not answer runs nothing.
      ["gone", []],
    ]);
  });

  it("puts a run that needs a VM on the runner with it, though another would finish sooner", async () => {
    const ci1 = idle("http://ci-1.test", 8);
    const ci2 = idle("http://ci-2.test", 16);
    ci1.platforms = ["wasm", "linux"];
    const { run } = proxy({ "ci-1": ci1, "ci-2": ci2 });
    expect(await run()).toBe("ci-2");
    expect(await run(["linux"])).toBe("ci-1");
    // Among the runners that have it, the usual order holds.
    ci2.platforms = ["wasm", "linux"];
    expect(await run(["linux"])).toBe("ci-2");
  });

  it("places it as usual when no runner has the platform", async () => {
    const { run } = proxy({
      "ci-1": idle("http://ci-1.test", 8),
      "ci-2": idle("http://ci-2.test", 16),
    });
    expect(await run(["windows"])).toBe("ci-2");
  });
});
