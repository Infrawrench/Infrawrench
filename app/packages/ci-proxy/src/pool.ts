// The runners behind the proxy. A run is placed on the runner with the
// most free slots; a runner that answers 429, or that is draining before an
// update or a stop, is passed over, and the caller only hears 429 when every
// runner is full, draining or down. Run ids carry the runner's name
// (`<name>.<id>`), so status and log requests go straight back to it.
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
          };
        } catch {
          return down;
        }
      }),
    );
  }

  /**
   * Sends a slot-taking request (a run or a prepare) to the runner most
   * likely to take it. Returns the runner it landed on, or `null` when none
   * would.
   */
  async place(path: string, body: string): Promise<{ runner: string; response: Response } | null> {
    const order = (await this.capacity())
      .filter((c) => c.up && !c.draining)
      .sort(
        (a, b) =>
          b.slotsFree - a.slotsFree ||
          a.runsActive - b.runsActive ||
          (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
      );
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
