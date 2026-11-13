// The runners behind the proxy. A run is placed on the runner with the
// most job memory for each run it has, weighed by its free V8 heap space
// (`byPlacement`, and the README's "Placement"); a runner that answers 429,
// or that is draining before an update or a stop, is passed over, and the
// caller only hears 429 when every runner is full, draining or down. Run
// ids carry the runner's name (`<name>.<id>`), so status and log requests
// go straight back to it.
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
  /** The runner's job memory budget, in bytes; `null` when it has none. */
  memoryTotal: number | null;
  /** What running jobs have reserved of it. */
  memoryUsed: number | null;
  /**
   * What jobs ready to start but not started yet ask for. `null` from a
   * runner older than the field, which then counts as nothing waiting.
   */
  memoryWaiting: number | null;
  /** The V8 heap space every Node job on the runner shares, in bytes; `null` when not reported. */
  v8HeapSpaceTotal: number | null;
  /** What V8 heaps use of it now, lost isolates' included. */
  v8HeapSpaceUsed: number | null;
  /** Isolates V8 abandoned after running out of memory since the runner started. */
  v8LostIsolates: number | null;
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
 * How much of a runner's V8 heap space is free, from 1 (all of it, or a
 * runner that does not report it) down to 0. Every Node job on a runner
 * shares that space, whatever its job memory, and lost isolates' heaps
 * count as used.
 */
export function v8Free(c: Capacity): number {
  if (c.v8HeapSpaceTotal === null || c.v8HeapSpaceUsed === null || c.v8HeapSpaceTotal === 0)
    return 1;
  return Math.max(0, c.v8HeapSpaceTotal - c.v8HeapSpaceUsed) / c.v8HeapSpaceTotal;
}

/**
 * What a new run could expect of a runner's job memory, in bytes, or
 * `null` when it reports no budget:
 *
 *     (budget + room) / 2 / (runs_active + 1) * (1 + v8 free) / 2
 *
 * The first half is the budget shared among the runs it would then have,
 * an average of its whole budget (what runs get over their life, as the
 * jobs that hold memory now finish) and its room now (budget less held and
 * queued, floored at minus the budget). A run lasts tens of minutes and a
 * runner's reservations swing from a quarter to all of its budget in ten,
 * so the number of runs it shares the host with counts as much as what is
 * free at the moment it is placed. The last factor takes up to half of
 * that away as the V8 heap space every Node job shares fills.
 */
export function placementShare(c: Capacity): number | null {
  const room = memoryRoom(c);
  if (room === null || c.memoryTotal === null) return null;
  const memory = (c.memoryTotal + Math.max(room, -c.memoryTotal)) / 2;
  return (memory / (c.runsActive + 1)) * ((1 + v8Free(c)) / 2);
}

/**
 * Orders runners for a new run, best first:
 *
 * 1. Runners that report a job memory budget, then those that do not.
 * 2. The largest `placementShare`: job memory per run, the new one
 *    included, weighed by how much V8 heap space is free.
 * 3. The most room (budget less held and queued), so a full pool places a
 *    run where the smallest backlog waits.
 * 4. Then the most free slots, the fewest active runs, and the name, so the
 *    order is stable.
 *
 * Slots alone would send every run to the runner with the most of them
 * while its memory is full (#1089). Free memory alone, ranked ahead of run
 * counts, sent every run to a runner with 2 GiB free and four runs over one
 * with none free and two, until its V8 heap space ran out (#1132): a run's
 * jobs wait for memory, and a run cannot move once it starts.
 */
export function byPlacement(a: Capacity, b: Capacity): number {
  const shareA = placementShare(a);
  const shareB = placementShare(b);
  if ((shareA === null) !== (shareB === null)) return shareA === null ? 1 : -1;
  if (shareA !== null && shareB !== null) {
    const order = shareB - shareA || (memoryRoom(b) ?? 0) - (memoryRoom(a) ?? 0);
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
          memoryTotal: null,
          memoryUsed: null,
          memoryWaiting: null,
          v8HeapSpaceTotal: null,
          v8HeapSpaceUsed: null,
          v8LostIsolates: null,
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
            memory_total?: unknown;
            memory_used?: unknown;
            memory_waiting?: unknown;
            v8_heap_space_total?: unknown;
            v8_heap_space_used?: unknown;
            v8_lost_isolates?: unknown;
            draining?: boolean;
            version?: string;
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
            memoryTotal: bytes(body.memory_total),
            memoryUsed: bytes(body.memory_used),
            memoryWaiting: bytes(body.memory_waiting),
            v8HeapSpaceTotal: bytes(body.v8_heap_space_total),
            v8HeapSpaceUsed: bytes(body.v8_heap_space_used),
            v8LostIsolates: bytes(body.v8_lost_isolates),
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
   * Returns the runner it landed on, or `null` when none would.
   */
  async place(path: string, body: string): Promise<{ runner: string; response: Response } | null> {
    const order = (await this.capacity()).filter((c) => c.up && !c.draining).sort(byPlacement);
    for (const runner of order) {
      let response: Response;
      try {
        response = await this.call(runner.name, path, { method: "POST", body });
      } catch {
        continue;
      }
      if (response.status === 429) {
        await response.body?.cancel();
        continue;
      }
      return { runner: runner.name, response };
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
