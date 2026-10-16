/**
 * The session gateway's background export loop: claims queued cost export
 * jobs (`cost-export-jobs.ts`) and writes their files.
 *
 * It runs in the web process, beside the dashboard delivery loop, for the same
 * reason that loop does: the work reuses this app's services (the unit-cost
 * query, the report reader), and a job can run for minutes, which rules out
 * the edge and the request-bound Lambda tier. The create route is a session
 * route (`edge/gateway-routes.ts`) so the request lands on a process running
 * this loop and can kick it rather than wait for the next tick; any process
 * running the loop picks up any job, so a kick is latency, not correctness.
 *
 * Jobs run detached from the tick, a couple at a time per process: a tick only
 * claims and launches, so one long file never holds up the next claim or the
 * expiry sweep. A process stopped mid-file leaves the job's lease to lapse and
 * another claim restarts it.
 */
import { TickLoop } from "@infrawrench/server-core/tick-loop";
import { claimCostExportJobs, pruneCostExportJobs, runCostExportJob } from "./cost-export-jobs";

/** Five seconds: a person is watching a progress bar. */
const TICK_MS = 5_000;

/** Files written at once by one process. Each is mostly waiting on ClickHouse. */
const CONCURRENT_JOBS = 2;

/** Expiry sweep cadence. Files expire on a 24h clock; ten minutes is plenty. */
const PRUNE_EVERY_MS = 10 * 60 * 1000;

class CostExportJobLoop extends TickLoop {
  private readonly inFlight = new Set<Promise<void>>();
  private lastPrunedAt = 0;

  constructor() {
    super("cost-export-jobs", TICK_MS);
  }

  protected async runTick(): Promise<void> {
    if (Date.now() - this.lastPrunedAt > PRUNE_EVERY_MS) {
      this.lastPrunedAt = Date.now();
      await pruneCostExportJobs().catch((e: unknown) =>
        console.error("[cost-export-jobs] prune failed:", e),
      );
    }
    const claimed = await claimCostExportJobs(CONCURRENT_JOBS - this.inFlight.size);
    for (const job of claimed) {
      const run = runCostExportJob(job).finally(() => {
        this.inFlight.delete(run);
      });
      this.inFlight.add(run);
    }
  }

  /** Wait (bounded by the base class) for the tick, then for running files. */
  override async stop(): Promise<void> {
    await super.stop();
    await Promise.race([
      Promise.allSettled([...this.inFlight]),
      new Promise((resolve) => setTimeout(resolve, 20_000)),
    ]);
  }
}

let loop: CostExportJobLoop | null = null;

/** Start the loop. A no-op without a database. */
export function startCostExportJobLoop(): void {
  if (loop || !process.env["DATABASE_URL"]) return;
  loop = new CostExportJobLoop();
  loop.start();
}

/**
 * Claim now rather than at the next tick: called after a job is created on a
 * process that runs the loop. A no-op elsewhere (the edge, Lambda, tests).
 */
export function kickCostExportJobLoop(): void {
  if (loop) void loop.tick();
}

/** Drain (bounded) before the process exits. */
export async function stopCostExportJobLoop(): Promise<void> {
  await loop?.stop();
  loop = null;
}
