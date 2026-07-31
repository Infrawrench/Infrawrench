/**
 * Local cron runner for desktop workflows.
 *
 * The cloud poller runs org cron workflows server-side; desktop workflows live
 * only in the local SQLite DB, so this renderer-side ticker schedules and runs
 * them. Each tick finds enabled cron workflows, runs the ones whose `next_run_at`
 * is due (non-interactively, trigger_source "cron"), and reschedules them from
 * the cron expression. It also reports the enabled-cron count to the main
 * process (`set_crons_active`) so — like active metric pings — the app stays
 * alive in the background after the window is closed and keeps firing them.
 */
import { nextCronOccurrence } from "@infrawrench/client-core";
import { invoke } from "./invoke";
import { getDb } from "../db/client";
import { runWorkflowById, WORKFLOWS_CHANGED_EVENT } from "./workflow-client";

interface CronWorkflowRow {
  id: string;
  trigger: string;
  next_run_at: string | null;
}

interface CronTrigger {
  kind?: string;
  expression?: string;
  timezone?: string;
}

const POLL_INTERVAL_MS = 30_000;

let started = false;
let runningTick = false;

export function startCronRunner(): void {
  if (started) return;
  started = true;
  void tick();
  setInterval(() => void tick(), POLL_INTERVAL_MS);
  // Re-tick promptly when a workflow is created/updated/deleted so the active
  // count + schedules stay fresh (e.g. enabling a cron right before quitting).
  window.addEventListener(WORKFLOWS_CHANGED_EVENT, () => void tick());
}

function nextRunAt(expression: string, timezone: string | undefined, from: Date): Date | null {
  try {
    return nextCronOccurrence(expression, { from, ...(timezone ? { timezone } : {}) });
  } catch {
    return null;
  }
}

async function tick(): Promise<void> {
  if (runningTick) return;
  runningTick = true;
  try {
    const db = await getDb();
    const rows = await db.select<CronWorkflowRow[]>(
      "SELECT id, trigger, next_run_at FROM workflows WHERE enabled = 1 AND deleted_at IS NULL",
    );

    const crons = rows.flatMap((r) => {
      let t: CronTrigger = {};
      try {
        t = JSON.parse(r.trigger) as CronTrigger;
      } catch {
        /* malformed trigger — skip */
      }
      return t.kind === "cron" && t.expression
        ? [{ row: r, expression: t.expression, timezone: t.timezone }]
        : [];
    });

    // Keep the app alive in the background while any cron is enabled.
    await invoke("set_crons_active", { count: crons.length }).catch(() => undefined);

    const now = Date.now();
    for (const { row, expression, timezone } of crons) {
      // First time we see this cron (no schedule yet) → schedule it forward;
      // don't run immediately on enable.
      if (!row.next_run_at) {
        const next = nextRunAt(expression, timezone, new Date());
        await db.execute("UPDATE workflows SET next_run_at = $1 WHERE id = $2", [
          next ? next.toISOString() : null,
          row.id,
        ]);
        continue;
      }

      const due = new Date(row.next_run_at).getTime();
      if (Number.isNaN(due) || due > now) continue;

      // Reschedule up-front so a slow/failing run isn't re-picked next tick.
      const next = nextRunAt(expression, timezone, new Date());
      await db.execute("UPDATE workflows SET next_run_at = $1 WHERE id = $2", [
        next ? next.toISOString() : null,
        row.id,
      ]);

      try {
        await runWorkflowById(row.id, { interactive: false, triggerSource: "cron" });
      } catch (err) {
        console.error("[cron-runner] workflow run failed:", row.id, err);
      }
    }
  } catch (err) {
    console.error("[cron-runner] tick failed:", err);
  } finally {
    runningTick = false;
  }
}
