// The runners behind the proxy. A run is placed on the runner with the
// most job memory to spare for each run it has (`byPlacement`, and the
// README's "Placement"); a runner that answers 429, or that is draining
// before an update or a stop, is passed over, and the caller only hears 429
// when every runner is full, draining or down. Run ids carry the runner's
// name (`<name>.<id>`), so status and log requests go straight back to it.
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
 * Orders runners for a new run, best first:
 *
 * 1. Runners with job memory to spare come first, then any that report no
 *    memory budget, then those whose memory is all spoken for (held by
 *    running jobs or asked for by queued ones).
 * 2. Among those with room, the most room per run, counting the new one:
 *    `room / (runs_active + 1)`, what each run would get if they shared it.
 *    Among those without, the smallest backlog.
 * 3. Then the most free slots, the fewest active runs, and the name, so the
 *    order is stable.
 *
 * Slots alone would send every run to the runner with the most of them
 * while its memory is full (#1089): a run's jobs wait for memory, and a
 * run cannot move once it starts.
 */
export function byPlacement(a: Capacity, b: Capacity): number {
  const roomA = memoryRoom(a);
  const roomB = memoryRoom(b);
  const tier = (room: number | null) => (room === null ? 1 : room > 0 ? 0 : 2);
  const tierA = tier(roomA);
  const tierB = tier(roomB);
  if (tierA !== tierB) return tierA - tierB;
  if (roomA !== null && roomB !== null) {
    const order =
      tierA === 0 ? roomB / (b.runsActive + 1) - roomA / (a.runsActive + 1) : roomB - roomA;
    if (order !== 0) return order;
  }
  return (
    b.slotsFree - a.slotsFree ||
    a.runsActive - b.runsActive ||
    (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  );
}

/** A non-negative byte count from a capacity body, or `null`. */
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
