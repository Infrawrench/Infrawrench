/**
 * The web process's scheduled dashboard delivery loop.
 *
 * The one background loop the web pods run, and only because the work needs
 * them: rendering a dashboard PDF calls the same services its cards do
 * (`runCostQuery`, the custom-graph sandbox), which live in this app and not
 * in the poller's bundle. Everything else about it is the poller's pattern:
 * `TickLoop` scheduling (never overlapping, drained on SIGTERM), and a
 * `FOR UPDATE SKIP LOCKED` claim with `next_send_at` as the lease
 * (`server-core/src/report-delivery/dashboard.ts`), so every replica running
 * this loop is safe: a due schedule is handed to exactly one of them.
 *
 * Report schedules stay in the poller; the two claims filter on disjoint
 * target columns of the same table.
 */
import { TickLoop } from "@infrawrench/server-core/tick-loop";
import { runDashboardDeliveryPass } from "@infrawrench/server-core/report-delivery/dashboard";
import { renderDashboardForDelivery } from "./dashboard-pdf";

/** A minute: a delivery that lands a minute late is not late. */
const DASHBOARD_DELIVERY_TICK_MS = 60_000;

class DashboardDeliveryLoop extends TickLoop {
  constructor() {
    super("dashboard-delivery", DASHBOARD_DELIVERY_TICK_MS);
  }

  protected async runTick(): Promise<void> {
    await runDashboardDeliveryPass(renderDashboardForDelivery);
  }
}

let loop: DashboardDeliveryLoop | null = null;

/**
 * Start the loop. A no-op without a database, and when
 * `DASHBOARD_DELIVERY_DISABLED=1` (for a replica set that should not send,
 * e.g. a preview environment sharing a production database).
 */
export function startDashboardDeliveryLoop(): void {
  if (loop || !process.env["DATABASE_URL"]) return;
  if (process.env["DASHBOARD_DELIVERY_DISABLED"] === "1") {
    console.log("[dashboard-delivery] disabled by DASHBOARD_DELIVERY_DISABLED");
    return;
  }
  loop = new DashboardDeliveryLoop();
  loop.start();
}

/** Drain an in-flight tick (bounded) before the process exits. */
export async function stopDashboardDeliveryLoop(): Promise<void> {
  await loop?.stop();
  loop = null;
}
