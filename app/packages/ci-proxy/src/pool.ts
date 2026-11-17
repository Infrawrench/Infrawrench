// The runners behind the proxy. A run is placed on the runner where it
// is expected to finish soonest: the one with the most cores for each run
// it has, held to what its job memory lets a run use (`byPlacement`, and
// the README's "Placement"); a runner that answers 429,
// or that is draining before an update or a stop, is passed over, and the
// caller only hears 429 when every runner is full, draining or down. Run
// ids carry the runner's name (`<name>.<id>`), so status and log requests
// go straight back to it.
//
// A run can need a platform other than `wasm` (`linux` or `windows`, jobs
// that run in a VM), which not every runner has: the caller names them in
// `platforms`, and `place` then tries only the runners whose capacity lists
// every one, in the same order. When no runner that is up has them all, it
// places the run as usual: its other jobs still run, and the runner fails
// the jobs it has no machines for, saying so.
//
// A run can be shared: a runner that says `split` in its capacity takes a
// run request with `split`, and the other such runners are then offered
// the same request as helpers (`app.ts`, and the README's "Split runs").
//
// The list comes from the `runners` table (`PUT /v1/runners`, which the
// Terraform in `infra/terraform` keeps in step with the hosts it
// provisions), or from the `RUNNERS` variable when the table is empty:
// `name=url` entries, or plain URLs named by their position.

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface RunnerEntry {
  name: string;
  url: string;
}

export interface Capacity {
  name: string;
  url: string;
  up: boolean;
  draining: boolean;
  version: string | null;
  slotsTotal: number;
  slotsFree: number;
  runsActive: number;
  /** The cores the runner gives its jobs; `null` when it does not say. */
  cpus: number | null;
  /** The runner's job memory budget, in bytes; `null` when it has none. */
  memoryTotal: number | null;
  /** What running jobs have reserved of it. */
  memoryUsed: number | null;
  /**
   * What jobs ready to start but not started yet ask for. `null` from a
   * runner older than the field, which then counts as nothing waiting.
   */
  memoryWaiting: number | null;
  /** Isolates V8 abandoned after running out of memory since the runner started. */
  v8LostIsolates: number | null;
  /**
   * The most their heaps hold, in bytes, out of the memory the runner keeps
   * for itself; it restarts before that is used up. `null` when not reported.
   */
  v8LostHeap: number | null;
  /** Whether it takes `split` in a run request, to share a run or help one. */
  split: boolean;
  /** The runs of other runners it is helping now. */
  runsHelping: number;
  /**
   * The platforms it runs jobs on: always `wasm`, and `linux` or `windows`
   * when it has the machines for them. `["wasm"]` from a runner older than
   * the field; empty for a runner that did not answer.
   */
  platforms: string[];
}

/** A run placed on a runner, and the runners it was not placed on. */
export interface Placed {
  runner: string;
  response: Response;
  /** The runner it landed on, as it answered `/v1/capacity`. */
  capacity: Capacity;
  /** The other runners that were up and not draining, best placed first. */
  others: Capacity[];
}

/**
 * The job memory a runner could give a new run: its budget, less what
 * running jobs hold and queued jobs ask for. Below zero when its admitted
 * work already wants more than it has; `null` when it reports no budget.
 */
export function memoryRoom(c: Capacity): number | null {
  if (c.memoryTotal === null || c.memoryUsed === null) return null;
  return c.memoryTotal - c.memoryUsed - (c.memoryWaiting ?? 0);
}

/**
 * What a new run could expect of a runner's job memory, in bytes, or
 * `null` when it reports no budget:
 *
 *     (budget + room) / 2 / (runs_active + 1)
 *
 * That is the budget shared among the runs it would then have, an average
 * of its whole budget (what runs get over their life, as the
 * jobs that hold memory now finish) and its room now (budget less held and
 * queued, floored at minus the budget). A run lasts tens of minutes and a
 * runner's reservations swing from a quarter to all of its budget in ten,
 * so the number of runs it shares the host with counts as much as what is
 * free at the moment it is placed. Job memory is all a runner's Node
 * jobs are held to: each V8 heap counts against its own job's memory, and
 * nothing is shared between the heaps of different jobs (#1158), so
 * placement has no V8 term.
 */
export function placementShare(c: Capacity): number | null {
  const room = memoryRoom(c);
  if (room === null || c.memoryTotal === null) return null;
  const memory = (c.memoryTotal + Math.max(room, -c.memoryTotal)) / 2;
  return memory / (c.runsActive + 1);
}

/**
 * The job memory that keeps one core busy, in bytes. A test job reserves
 * 4 to 6 GiB and keeps 2.3 threads busy at two Vitest workers; four such
 * jobs filled ci-2's 25.7 GiB with 9 of its 16 vCPUs busy. One core for
 * each 2 GiB sits between those, so a runner with less than 2 GiB a core
 * (ci-2) counts as short of memory before it is short of cores, and one
 * with more (ci-1, 3 GiB a core) the other way round.
 */
export const MEMORY_PER_CORE = 2 * 1024 ** 3;

/**
 * The CPU work of a typical pull request's run, in core-seconds: 2,000 to
 * 2,400 measured, one plugin changed against a warm task cache. A cold run
 * (nothing cached) is about 4,900.
 */
export const TYPICAL_RUN_WORK = 2400;

/**
 * The cores a new run could expect of a runner's CPUs, or `null` when it
 * does not report them. The same shape as `placementShare`:
 *
 *     (cpus + idle) / 2 / (runs_active + 1)
 *
 * where `idle` is the cores no job runs on now: `cpus` less the jobs
 * running (the slots in use), floored at none. A job is at least one
 * busy thread, so this never counts a busy core as idle; it can count an
 * idle one as busy only on a runner with more jobs than cores, which has
 * none to spare anyway. Like memory, what is idle at the moment of placing
 * is half the answer: a run admitted a second ago has started nothing yet,
 * and the cores it will take are only visible in `runs_active`.
 */
export function coreShare(c: Capacity): number | null {
  if (c.cpus === null || c.cpus <= 0) return null;
  const idle = Math.max(0, c.cpus - (c.slotsTotal - c.slotsFree));
  return (c.cpus + idle) / 2 / (c.runsActive + 1);
}

/**
 * The cores a new run could expect to keep busy on a runner: its share of
 * the CPUs (`coreShare`), held to what its share of the job memory
 * (`placementShare`) lets it run at once, at `MEMORY_PER_CORE`. A runner
 * that does not report its CPUs is ranked by memory alone, as every runner
 * was before; `null` when it reports no memory budget either.
 */
export function runCores(c: Capacity): number | null {
  const cores = coreShare(c);
  const memory = placementShare(c);
  if (memory === null) return null;
  const byMemory = memory / MEMORY_PER_CORE;
  return cores === null ? byMemory : Math.min(cores, byMemory);
}

/**
 * How long a run of `work` core-seconds is expected to take on a runner,
 * in seconds: the work over `runCores`. `null` when the runner reports no
 * budget, `Infinity` when its admitted work already wants more than all of
 * it. Every runner's estimate is the same `work` over its cores, so the
 * order of runners does not depend on how large the run is, which the
 * proxy cannot see.
 */
export function expectedSeconds(c: Capacity, work: number = TYPICAL_RUN_WORK): number | null {
  const cores = runCores(c);
  if (cores === null) return null;
  return cores <= 0 ? Infinity : work / cores;
}

/**
 * Orders runners for a new run, best first:
 *
 * 1. Runners that report a job memory budget, then those that do not.
 * 2. The most `runCores`, which is the shortest `expectedSeconds`: the
 *    cores a run can expect, the new one included, held to what its share
 *    of the job memory lets it use.
 * 3. The most room (budget less held and queued), so a full pool places a
 *    run where the smallest backlog waits.
 * 4. Then the most free slots, the fewest active runs, and the name, so the
 *    order is stable.
 *
 * Memory alone sent a run to whichever runner had the most of it for each
 * run, and the two runners have nearly the same: 24 GiB on 8 cores and
 * 25.7 GiB on 16. A run's time is its CPU work over the cores it gets, so
 * the same run takes twice as long on the first. Slots alone would send
 * every run to the runner with the most of them while its memory is full
 * (#1089). Free memory alone, ranked ahead of run counts, sent every run
 * to a runner with 2 GiB free and four runs over one with none free and
 * two (#1132): a run's jobs wait for memory, and a run cannot move once it
 * starts. Dividing by the runs a runner would then have is what spreads a
 * burst: each run placed makes that runner worth less to the next.
 */
export function byPlacement(a: Capacity, b: Capacity): number {
  const coresA = runCores(a);
  const coresB = runCores(b);
  if ((coresA === null) !== (coresB === null)) return coresA === null ? 1 : -1;
  if (coresA !== null && coresB !== null) {
    const order = coresB - coresA || (memoryRoom(b) ?? 0) - (memoryRoom(a) ?? 0);
    if (order !== 0) return order;
  }
  return (
    b.slotsFree - a.slotsFree ||
    a.runsActive - b.runsActive ||
    (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  );
}

/** A non-negative count (bytes, isolates) from a capacity body, or `null`. */
function bytes(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** The platforms a capacity body lists: its strings, or `["wasm"]` when it lists none. */
function platformsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return ["wasm"];
  return [...new Set(value.filter((p): p is string => typeof p === "string"))];
}

/** Whether a runner has every platform in `needs`. */
export function hasPlatforms(c: Capacity, needs: readonly string[]): boolean {
  return needs.every((p) => c.platforms.includes(p));
}

/** How long a runner gets to answer a capacity probe before it counts as down. */
const PROBE_TIMEOUT_MS = 2000;

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function isRunnerName(name: string): boolean {
  return NAME.test(name);
}

/** A runner base URL: http or https, no path beyond `/`, no credentials. */
export function isRunnerUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      (u.protocol === "http:" || u.protocol === "https:") &&
      u.username === "" &&
      u.password === "" &&
      (u.pathname === "/" || u.pathname === "") &&
      u.search === ""
    );
  } catch {
    return false;
  }
}

/** Parses the `RUNNERS` variable. */
export function parseRunnerList(list: string): RunnerEntry[] {
  return list
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry, index) => {
      const eq = entry.indexOf("=");
      const [name, url] =
        eq > 0 ? [entry.slice(0, eq), entry.slice(eq + 1)] : [String(index), entry];
      return { name, url: url.replace(/\/+$/, "") };
    });
}

export class Pool {
  constructor(
    readonly runners: RunnerEntry[],
    private readonly key: string,
    private readonly fetchFn: Fetch,
  ) {}

  static fromList(list: string, key: string, fetchFn: Fetch): Pool {
    return new Pool(parseRunnerList(list), key, fetchFn);
  }

  find(name: string): RunnerEntry | undefined {
    return this.runners.find((r) => r.name === name);
  }

  /** A request to runner `name`, with the runners' key. */
  call(name: string, path: string, init: RequestInit = {}): Promise<Response> {
    const runner = this.find(name);
    if (!runner) return Promise.reject(new Error(`no runner named ${name}`));
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.key}`);
    if (init.body !== undefined && !headers.has("Content-Type"))
      headers.set("Content-Type", "application/json");
    return this.fetchFn(`${runner.url}${path}`, { ...init, headers });
  }

  async capacity(): Promise<Capacity[]> {
    return Promise.all(
      this.runners.map(async ({ name, url }): Promise<Capacity> => {
        const down: Capacity = {
          name,
          url,
          up: false,
          draining: false,
          version: null,
          slotsTotal: 0,
          slotsFree: 0,
          runsActive: 0,
          cpus: null,
          memoryTotal: null,
          memoryUsed: null,
          memoryWaiting: null,
          v8LostIsolates: null,
          v8LostHeap: null,
          split: false,
          runsHelping: 0,
          platforms: [],
        };
        try {
          const res = await this.call(name, "/v1/capacity", {
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
          });
          if (!res.ok) return down;
          const body = (await res.json()) as {
            slots_total?: number;
            slots_free?: number;
            runs_active?: number;
            cpus?: unknown;
            memory_total?: unknown;
            memory_used?: unknown;
            memory_waiting?: unknown;
            v8_lost_isolates?: unknown;
            v8_lost_heap?: unknown;
            draining?: boolean;
            version?: string;
            split?: unknown;
            runs_helping?: unknown;
            platforms?: unknown;
          };
          return {
            name,
            url,
            up: true,
            draining: body.draining === true,
            version: typeof body.version === "string" ? body.version : null,
            slotsTotal: body.slots_total ?? 0,
            slotsFree: body.slots_free ?? 0,
            runsActive: body.runs_active ?? 0,
            cpus: bytes(body.cpus),
            memoryTotal: bytes(body.memory_total),
            memoryUsed: bytes(body.memory_used),
            memoryWaiting: bytes(body.memory_waiting),
            v8LostIsolates: bytes(body.v8_lost_isolates),
            v8LostHeap: bytes(body.v8_lost_heap),
            split: body.split === true,
            runsHelping: bytes(body.runs_helping) ?? 0,
            platforms: platformsOf(body.platforms),
          };
        } catch {
          return down;
        }
      }),
    );
  }

  /**
   * Sends a slot-taking request (a run or a prepare) to the runner best
   * placed to start it (`byPlacement`), then the next if that one refuses.
   * Returns the runner it landed on, or `null` when none would. A body
   * given as a function is made for each runner tried, from it and the
   * other runners that could have taken the request.
   *
   * A request that needs `platforms` is tried only on the runners that have
   * all of them, when any that is up does; otherwise on every runner, as
   * one that needs none (see the top of this file). Either way `others` is
   * every other runner that is up and not draining.
   */
  async place(
    path: string,
    body: string | ((runner: Capacity, others: Capacity[]) => string),
    platforms: readonly string[] = [],
  ): Promise<Placed | null> {
    const order = (await this.capacity()).filter((c) => c.up && !c.draining).sort(byPlacement);
    const capable = order.filter((c) => hasPlatforms(c, platforms));
    for (const runner of capable.length > 0 ? capable : order) {
      const others = order.filter((c) => c !== runner);
      let response: Response;
      try {
        response = await this.call(runner.name, path, {
          method: "POST",
          body: typeof body === "string" ? body : body(runner, others),
        });
      } catch {
        continue;
      }
      if (response.status === 429) {
        await response.body?.cancel();
        continue;
      }
      return { runner: runner.name, response, capacity: runner, others };
    }
    return null;
  }

  /** The first runner that answers a request that any runner can serve. */
  async any(path: string, init: RequestInit = {}): Promise<Response | null> {
    for (const { name } of this.runners) {
      try {
        const response = await this.call(name, path, init);
        if (response.status < 500) return response;
        await response.body?.cancel();
      } catch {
        // Down; try the next.
      }
    }
    return null;
  }
}

/** Splits a proxy run id (`<runner>.<id>`) whose runner is in the pool. */
export function parseRunId(id: string, pool: Pool): { runner: string; id: string } | null {
  const match = /^([a-z0-9][a-z0-9-]{0,39})\.([0-9a-f]{32})$/.exec(id);
  if (!match) return null;
  const [, runner = "", runId = ""] = match;
  return pool.find(runner) ? { runner, id: runId } : null;
}
