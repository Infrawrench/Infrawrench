// The runners behind the proxy. A run is placed on the runner with the
// most free slots; a runner that answers 429 is passed over for the next,
// and the caller only hears 429 when every runner is full or down. Run ids
// carry the runner's position in RUNNERS (`<index>.<id>`), so status and
// log requests go straight back to it without a table.

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface Capacity {
  index: number;
  url: string;
  up: boolean;
  slotsTotal: number;
  slotsFree: number;
  runsActive: number;
}

/** How long a runner gets to answer a capacity probe before it counts as down. */
const PROBE_TIMEOUT_MS = 2000;

export class Pool {
  constructor(
    readonly urls: string[],
    private readonly key: string,
    private readonly fetchFn: Fetch,
  ) {}

  static fromList(list: string, key: string, fetchFn: Fetch): Pool {
    const urls = list
      .split(",")
      .map((u) => u.trim().replace(/\/+$/, ""))
      .filter((u) => u.length > 0);
    return new Pool(urls, key, fetchFn);
  }

  /** A request to runner `index`, with the runners' key. */
  call(index: number, path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.key}`);
    if (init.body !== undefined && !headers.has("Content-Type"))
      headers.set("Content-Type", "application/json");
    return this.fetchFn(`${this.urls[index]}${path}`, { ...init, headers });
  }

  async capacity(): Promise<Capacity[]> {
    return Promise.all(
      this.urls.map(async (url, index): Promise<Capacity> => {
        const down: Capacity = {
          index,
          url,
          up: false,
          slotsTotal: 0,
          slotsFree: 0,
          runsActive: 0,
        };
        try {
          const res = await this.call(index, "/v1/capacity", {
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
          });
          if (!res.ok) return down;
          const body = (await res.json()) as {
            slots_total?: number;
            slots_free?: number;
            runs_active?: number;
          };
          return {
            index,
            url,
            up: true,
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
   * likely to take it. Returns the runner it landed on, or `null` with the
   * last refusal when none would.
   */
  async place(path: string, body: string): Promise<{ index: number; response: Response } | null> {
    const order = (await this.capacity())
      .filter((c) => c.up)
      .sort(
        (a, b) => b.slotsFree - a.slotsFree || a.runsActive - b.runsActive || a.index - b.index,
      );
    for (const runner of order) {
      let response: Response;
      try {
        response = await this.call(runner.index, path, { method: "POST", body });
      } catch {
        continue;
      }
      if (response.status === 429) {
        await response.body?.cancel();
        continue;
      }
      return { index: runner.index, response };
    }
    return null;
  }

  /** The first runner that answers a request that any runner can serve. */
  async any(path: string, init: RequestInit = {}): Promise<Response | null> {
    for (let index = 0; index < this.urls.length; index++) {
      try {
        const response = await this.call(index, path, init);
        if (response.status < 500) return response;
        await response.body?.cancel();
      } catch {
        // Down; try the next.
      }
    }
    return null;
  }
}

/** Splits a proxy run id (`<index>.<id>`). */
export function parseRunId(id: string, runners: number): { index: number; id: string } | null {
  const match = /^(\d{1,3})\.([0-9a-f]{32})$/.exec(id);
  if (!match) return null;
  const [, indexText = "", runId = ""] = match;
  const index = Number(indexText);
  return index < runners ? { index, id: runId } : null;
}
