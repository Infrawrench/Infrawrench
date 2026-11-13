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

  it("shares a runner's room among its runs, the new one included", () => {
    // ci-2 has more room, but split three ways (two runs and the new one)
    // it is less per run than ci-1's for two.
    const a = capacity({ name: "a", runsActive: 1, memoryTotal: 24 * GiB, memoryUsed: 12 * GiB });
    const b = capacity({
      name: "b",
      slotsTotal: 64,
      slotsFree: 50,
      runsActive: 2,
      memoryTotal: 26 * GiB,
      memoryUsed: 6 * GiB,
    });
    // a: 12 / 2 = 6 GiB a run; b: 20 / 3 = 6.7 GiB a run.
    expect(order([a, b])).toEqual(["b", "a"]);
    // A queued job's ask counts against room like a held reservation.
    expect(order([a, { ...b, memoryWaiting: 6 * GiB }])).toEqual(["a", "b"]);
  });

  it("ranks runners with no room below every other, by their backlog", () => {
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
    const unknown = capacity({ name: "unknown", slotsFree: 1, runsActive: 7 });
    const tight = capacity({
      name: "tight",
      slotsFree: 2,
      runsActive: 5,
      memoryTotal: 24 * GiB,
      memoryUsed: 23 * GiB,
    });
    expect(order([busier, full, unknown, tight])).toEqual(["tight", "unknown", "full", "busier"]);
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
        draining: false,
        version: "0.3.13",
        slots_total: this.slotsTotal,
        slots_free: this.slotsTotal - this.runs,
        runs_active: this.runs,
        memory_total: this.memory.total,
        memory_used: this.memory.used,
        ...(this.memory.waiting === undefined ? {} : { memory_waiting: this.memory.waiting }),
      });
    if (path === "/v1/runs" && init.method === "POST") {
      if (this.refuse) return json(429, { error: "at capacity" });
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

  it("shows each runner's job memory in /v1/capacity", async () => {
    const { call } = proxy({
      "ci-1": new Runner(
        "http://ci-1.test",
        32,
        { total: 24 * GiB, used: 6 * GiB },
        { used: 0, waiting: 0 },
      ),
      "ci-2": new Runner(
        "http://ci-2.test",
        64,
        { total: 26 * GiB, used: 24 * GiB, waiting: 12 * GiB },
        {
          used: 0,
          waiting: 0,
        },
      ),
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
      }),
      expect.objectContaining({
        name: "ci-2",
        memory_total: 26 * GiB,
        memory_used: 24 * GiB,
        memory_waiting: 12 * GiB,
      }),
    ]);
  });
});
