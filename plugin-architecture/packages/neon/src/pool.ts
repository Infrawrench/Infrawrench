/**
 * Neon allows 700 requests a minute per account, with bursts of 40 a second per route,
 * and the console draws on the same allowance. At ~0.2s per call, 2 in flight is about
 * 600 a minute, so a poll holds that across every type: a sync lists them all at once on
 * one client. https://neon.com/docs/reference/api/key-concepts
 */
export const NEON_LIST_CONCURRENCY = 2;

/**
 * One user's read of one thing: a short burst, and 8 in flight at ~0.2s is the 40 a
 * second Neon allows one. A list of options should not make them wait as a poll does.
 */
const NEON_SINGLE_READ_CONCURRENCY = 8;

/** One poll's share of the requests: about 100 seconds at the concurrency above. */
const POLL_REQUEST_BUDGET = 1_000;
/** A poll is killed at 300 seconds with no message, so slow answers stop it well before. */
const POLL_TIME_BUDGET_MS = 200_000;
/** The poller's account lease. A client still in use past this is on another poll. */
const POLL_WINDOW_MS = 300_000;
/** Stops starting parents this short of the budget: one already started may need more. */
const REQUESTS_A_STARTED_PARENT_MAY_ADD = 8;
/**
 * Kept for a type whose parents come from another type's read, the Data API from the
 * databases. It would otherwise start once the others had spent everything, and never run.
 */
const HELD_FOR_LATE_TYPES = 60;
/** Reading each project's branches may take this many of a poll's requests. */
const ENUMERATED_PROJECTS_IN_A_POLL = 250;

/** The requests one poll may make, and the slots they queue for, first come first served. */
export class PollBudget {
  private spent = 0;
  private startedAt = 0;
  private inFlight = 0;
  private readonly waiting: Array<() => void> = [];

  private constructor(
    /** False for a read with no poll to fit inside. */
    readonly bounded: boolean,
    /** The requests that may be in flight at once. */
    readonly slots: number,
    /** False for a read that finds one thing, or fills a picker: it lists nothing whole. */
    readonly reportsUnread = true,
  ) {}

  /** A poll's budget. */
  static forPoll(): PollBudget {
    return new PollBudget(true, NEON_LIST_CONCURRENCY);
  }

  /** For a list read whole, with no poll to fit inside. */
  static unbounded(): PollBudget {
    return new PollBudget(false, NEON_SINGLE_READ_CONCURRENCY);
  }

  /** For one user's read of one thing, which has to find it, or of a picker's options. */
  static forLookup(): PollBudget {
    return new PollBudget(false, NEON_SINGLE_READ_CONCURRENCY, false);
  }

  get maxEnumeratedProjects(): number {
    return this.bounded ? ENUMERATED_PROJECTS_IN_A_POLL : Number.POSITIVE_INFINITY;
  }

  hasRoom({ late = false }: { late?: boolean } = {}): boolean {
    if (!this.bounded) return true;
    this.renew();
    const held = late ? 0 : HELD_FOR_LATE_TYPES;
    if (this.spent + held + REQUESTS_A_STARTED_PARENT_MAY_ADD >= POLL_REQUEST_BUDGET) return false;
    return this.spent === 0 || Date.now() - this.startedAt < POLL_TIME_BUDGET_MS;
  }

  async request<T>(call: () => Promise<T>): Promise<T> {
    this.renew();
    if (this.spent === 0) this.startedAt = Date.now();
    this.spent++;
    if (this.inFlight < this.slots) this.inFlight++;
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    try {
      return await call();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.inFlight--;
    }
  }

  private renew(): void {
    if (this.spent > 0 && Date.now() - this.startedAt >= POLL_WINDOW_MS) this.spent = 0;
  }
}

/** `api`, with every call it makes counted against `budget` and queued for a slot. */
export function throughBudget<T extends object>(api: T, budget: PollBudget): T {
  return new Proxy(api, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => budget.request(() => Reflect.apply(value, target, args));
    },
  });
}

/**
 * Where to start reading `length` parents, for a list a poll may not finish. Polls share
 * nothing and do not know how far the last one got, so the start moves by the golden
 * ratio with the clock, which spreads over the list evenly however much each poll reads.
 */
export function rotationStart(length: number): number {
  const minute = Math.floor(Date.now() / 60_000);
  return Math.floor(((minute * 0.618_033_988_75) % 1) * length);
}

/**
 * One read shared by whoever asks while it is running. The types of a poll all start
 * together, so they get one read between them, and nothing is kept to go stale after it.
 */
export class SharedRead<T> {
  private running: Promise<T> | undefined;

  run(read: () => Promise<T>): Promise<T> {
    if (this.running) return this.running;
    const started = read();
    this.running = started;
    const done = (): void => {
      this.running = undefined;
    };
    started.then(done, done);
    return started;
  }

  /** Waits out a read still running, whatever it comes to. */
  async settled(): Promise<void> {
    await this.running?.then(
      () => undefined,
      () => undefined,
    );
  }
}

/**
 * Map `items` through `fn` with at most `limit` calls in flight, and flatten
 * the per-item arrays in input order. The first failure rejects the lot and
 * starts nothing more: reading a failed parent as having no children would
 * prune them, so `fn` catches whatever really does mean none. `start` is the
 * item to begin at, wrapping round; it does not change the order of the result.
 */
export async function flatMapPooled<T, R>(
  items: readonly T[],
  fn: (item: T) => Promise<R[]>,
  limit = NEON_LIST_CONCURRENCY,
  start = 0,
): Promise<R[]> {
  const out: R[][] = new Array(items.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (next < items.length && !failed) {
      const i = (start + next++) % items.length;
      try {
        out[i] = await fn(items[i]!);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out.flat();
}
