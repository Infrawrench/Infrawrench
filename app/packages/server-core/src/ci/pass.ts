/**
 * The poller passes that keep CI moving.
 *
 * - `runCiStatusPass` dispatches queued runs (retrying a busy or unreachable
 *   runner pool) and follows running ones, which is what moves every check
 *   on GitHub and the CI tab. It runs on a loop of its own every few seconds
 *   (`ownLoopMs` in the poller's registry), not on the shared tick: behind
 *   the cost polls and alert passes a status waited a minute or more.
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
import { ciProxyConfigured } from "./proxy.js";
import { dispatchRun, dueQueuedRunIds, expireApprovals, runningRuns, syncRun } from "./runs.js";

/**
 * How many runs one pass works on at once. Each run's own GitHub writes stay
 * one at a time, as GitHub asks of an integration; separate runs need not
 * wait for each other.
 */
export const CI_RUN_CONCURRENCY = 4;

export async function runCiStatusPass(): Promise<void> {
  if (!ciProxyConfigured()) return;
  await runWithConcurrency(await dueQueuedRunIds(20), CI_RUN_CONCURRENCY, (id) =>
    dispatchRun(id).catch((err) => console.warn(`[ci] dispatching ${id} failed:`, err)),
  );
  await runWithConcurrency(await runningRuns(50), CI_RUN_CONCURRENCY, (row) =>
    syncRun(row).catch((err) => console.warn(`[ci] syncing ${row.id} failed:`, err)),
  );
}

export async function runCiUpkeepPass(): Promise<void> {
  if (!ciProxyConfigured()) return;
  await expireApprovals();
  await reportRunUsage(50);
  await sampleStorage();
  await reportStorage(50);
}
