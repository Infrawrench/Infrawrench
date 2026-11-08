/**
 * The poller pass that keeps CI moving: dispatches queued runs (retrying a
 * busy or unreachable runner pool), follows running ones until they finish,
 * closes forks' runs nobody approved, and sends usage to the billing meters.
 *
 * Postgres, the CI proxy and GitHub's and Stripe's APIs only, so it runs
 * on the edge. Every step claims or settles rows itself, so overlapping
 * ticks (and the webhook, which also dispatches) never act twice.
 */
import { reportRunUsage, reportStorage, sampleStorage } from "./billing.js";
import { ciProxyConfigured } from "./proxy.js";
import { dispatchRun, dueQueuedRunIds, expireApprovals, runningRuns, syncRun } from "./runs.js";

export async function runCiPass(): Promise<void> {
  if (!ciProxyConfigured()) return;
  for (const id of await dueQueuedRunIds(20)) {
    await dispatchRun(id).catch((err) => console.warn(`[ci] dispatching ${id} failed:`, err));
  }
  for (const row of await runningRuns(50)) {
    await syncRun(row).catch((err) => console.warn(`[ci] syncing ${row.id} failed:`, err));
  }
  await expireApprovals();
  await reportRunUsage(50);
  await sampleStorage();
  await reportStorage(50);
}
