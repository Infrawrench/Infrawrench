/**
 * The poller passes that keep CI moving.
 *
 * - `runCiStatusPass` fires pipelines' `on.schedule` crons
 *   (`schedules.ts`), lets runs waiting for their concurrency group go once
 *   it is free, dispatches queued runs (retrying a busy or unreachable
 *   runner pool) and follows running ones, which is what moves every check
 *   on GitHub and the CI tab. It runs on a loop of its own every second
 *   (`ownLoopMs` in the poller's registry), not on the shared tick: behind
 *   the cost polls and alert passes a status waited a minute or more. A
 *   finished run is noticed within that second; what need not be that
 *   prompt keeps a slower clock of its own here (schedules, a running
 *   run's job checks), and a pass with no run waiting or going is one read.
 * - `runCiUpkeepPass` closes forks' runs nobody approved and sends usage
 *   and storage to the billing meters, none of which a person is watching,
 *   on the shared tick.
 *
 * Postgres, the CI proxy and GitHub's and Stripe's APIs only, so both run
 * on the edge. Every step claims or settles rows itself, so overlapping
 * ticks (and the webhook, which also dispatches) never act twice.
 */
import { runWithConcurrency } from "@infrawrench/client-core";

import { reportRunUsage, reportStorage, sampleStorage } from "./billing.js";
import { admitRun, pendingRuns } from "./concurrency.js";
import { ciProxyConfigured } from "./proxy.js";
import {
  anyLiveRun,
  dispatchRun,
  dueQueuedRunIds,
  expireApprovals,
  runningRuns,
  syncRun,
} from "./runs.js";
import { fireDueSchedules, refreshSchedules } from "./schedules.js";

/**
 * How many runs one pass works on at once. Each run's own GitHub writes stay
 * one at a time, as GitHub asks of an integration; separate runs need not
 * wait for each other.
 */
export const CI_RUN_CONCURRENCY = 16;

/** How often schedules are fired and re-read: crons are to the minute. */
export const SCHEDULES_EVERY_MS = 5_000;
/**
 * How often a running run's job checks are written to GitHub. Following a
 * run costs one read of the proxy; its job checks are a GitHub call each,
 * one at a time, and a pass busy writing them is a pass not noticing that
 * the run has finished.
 */
export const JOB_CHECKS_EVERY_MS = 5_000;

// Clocks of this process (an isolate, on the edge) only: they space out
// work that claims or settles its own rows, so several processes each
// keeping their own is harmless.
let schedulesAt = Number.NEGATIVE_INFINITY;
const jobChecksAt = new Map<string, number>();

/** Forgets the pass's clocks, for tests. */
export function resetCiStatusClocks(): void {
  schedulesAt = Number.NEGATIVE_INFINITY;
  jobChecksAt.clear();
}

export async function runCiStatusPass(now: () => number = Date.now): Promise<void> {
  if (!ciProxyConfigured()) return;
  // Scheduled pipelines due this minute become queued runs first, so this
  // same pass dispatches them. Only a few repositories are re-read per pass;
  // a read clones a branch.
  if (now() - schedulesAt >= SCHEDULES_EVERY_MS) {
    schedulesAt = now();
    await fireDueSchedules().catch((err) => console.warn("[ci] firing schedules failed:", err));
    await refreshSchedules().catch((err) => console.warn("[ci] reading schedules failed:", err));
  }
  // Nothing waiting or going is the usual pass, and this is all of it.
  if (!(await anyLiveRun())) {
    jobChecksAt.clear();
    return;
  }
  // Runs waiting for a concurrency group, oldest first and one at a time,
  // so the one whose group came free first goes first.
  for (const row of await pendingRuns(20)) {
    await admitRun(row).catch((err) => console.warn(`[ci] admitting ${row.id} failed:`, err));
  }
  await runWithConcurrency(await dueQueuedRunIds(20), CI_RUN_CONCURRENCY, (id) =>
    dispatchRun(id).catch((err) => console.warn(`[ci] dispatching ${id} failed:`, err)),
  );
  const running = await runningRuns(50);
  const ids = new Set(running.map((row) => row.id));
  for (const id of jobChecksAt.keys()) if (!ids.has(id)) jobChecksAt.delete(id);
  await runWithConcurrency(running, CI_RUN_CONCURRENCY, (row) => {
    const jobChecks =
      now() - (jobChecksAt.get(row.id) ?? Number.NEGATIVE_INFINITY) >= JOB_CHECKS_EVERY_MS;
    if (jobChecks) jobChecksAt.set(row.id, now());
    return syncRun(row, { jobChecks }).catch((err) =>
      console.warn(`[ci] syncing ${row.id} failed:`, err),
    );
  });
}

export async function runCiUpkeepPass(): Promise<void> {
  if (!ciProxyConfigured()) return;
  await expireApprovals();
  await reportRunUsage(50);
  await sampleStorage();
  await reportStorage(50);
}
