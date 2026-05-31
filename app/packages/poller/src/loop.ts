import { and, asc, eq, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { CronExpressionParser } from "cron-parser";
import { db } from "@infrawrench/server-core/db/client";
import { accounts, workflows } from "@infrawrench/server-core/db/schema";
import { runOrgWorkflow } from "@infrawrench/server-core/workflows/runner";
import { pollAccount, type PollAccountRow } from "./poll-account";
import { TokenBucketRegistry } from "./token-bucket";

const TICK_MS = 15_000;
const CONCURRENCY = 8;
const WORKFLOW_LIMIT = 8;

/** A workflow's `trigger` jsonb, narrowed to the cron fields we read. */
interface CronTrigger {
  kind?: string;
  expression?: string;
  timezone?: string;
}

interface DueWorkflowRow {
  id: string;
  organizationId: string;
  trigger: unknown;
}

/**
 * Compute the next fire time from a cron trigger. Returns `null` when the
 * trigger isn't cron or the expression can't be parsed, which de-schedules the
 * workflow (it won't be picked up again until re-saved).
 */
function nextRunAtFromTrigger(trigger: unknown, from: Date): Date | null {
  const t = trigger as CronTrigger | null;
  if (!t || t.kind !== "cron" || !t.expression) return null;
  try {
    const interval = CronExpressionParser.parse(t.expression, {
      currentDate: from,
      ...(t.timezone ? { tz: t.timezone } : {}),
    });
    return interval.next().toDate();
  } catch {
    return null;
  }
}

interface LoopOptions {
  tickMs?: number;
  concurrency?: number;
}

export class PollerLoop {
  private buckets = new TokenBucketRegistry();
  private stopping = false;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly tickMs: number;
  private readonly concurrency: number;

  constructor(options: LoopOptions = {}) {
    this.tickMs = options.tickMs ?? TICK_MS;
    this.concurrency = options.concurrency ?? CONCURRENCY;
  }

  start(): void {
    if (this.timer) return;
    const scheduleNext = () => {
      if (this.stopping) return;
      this.timer = setTimeout(async () => {
        await this.tick();
        scheduleNext();
      }, this.tickMs);
    };
    // Fire first tick immediately, then schedule on interval.
    void this.tick().then(scheduleNext);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Wait briefly for any in-flight tick to drain.
    const deadline = Date.now() + 30_000;
    while (this.running && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = new Date();
      const dueRows = await db
        .select({
          id: accounts.id,
          organizationId: accounts.organizationId,
          pluginId: accounts.pluginId,
          displayName: accounts.displayName,
          pollFailureCount: accounts.pollFailureCount,
        })
        .from(accounts)
        .where(
          and(
            isNull(accounts.deletedAt),
            or(isNull(accounts.nextPollAt), lte(accounts.nextPollAt, now)),
          ),
        )
        .orderBy(sql`${accounts.lastPolledAt} asc nulls first`, asc(accounts.id))
        .limit(this.concurrency);

      if (dueRows.length > 0) {
        await Promise.allSettled(dueRows.map((row) => this.runOne(row)));
      }

      // Second pass: due cron workflows. Kept separate and defensive so a bad
      // workflow never affects account polling.
      await this.tickWorkflows();
    } catch (e) {
      console.error("[poller] tick failed:", e);
    } finally {
      this.running = false;
    }
  }

  private async runOne(row: PollAccountRow): Promise<void> {
    try {
      await pollAccount(row, this.buckets);
    } catch (e) {
      console.error(`[poller] account ${row.id} (${row.pluginId}) poll failed:`, e);
    }
  }

  /** Run all cron workflows whose `nextRunAt` is due, then reschedule them. */
  private async tickWorkflows(): Promise<void> {
    try {
      const now = new Date();
      const dueWorkflows: DueWorkflowRow[] = await db
        .select({
          id: workflows.id,
          organizationId: workflows.organizationId,
          trigger: workflows.trigger,
        })
        .from(workflows)
        .where(
          and(
            eq(workflows.enabled, true),
            isNull(workflows.deletedAt),
            isNotNull(workflows.nextRunAt),
            lte(workflows.nextRunAt, now),
          ),
        )
        .orderBy(asc(workflows.nextRunAt), asc(workflows.id))
        .limit(WORKFLOW_LIMIT);

      if (dueWorkflows.length === 0) return;

      await Promise.allSettled(dueWorkflows.map((row) => this.runWorkflowOnce(row)));
    } catch (e) {
      console.error("[poller] workflow tick failed:", e);
    }
  }

  private async runWorkflowOnce(row: DueWorkflowRow): Promise<void> {
    // Reschedule from "now" up-front so a long-running or failing workflow can't
    // be re-picked on the next tick before this run finishes.
    const nextRunAt = nextRunAtFromTrigger(row.trigger, new Date());
    try {
      await db
        .update(workflows)
        .set({ nextRunAt, updatedAt: new Date() })
        .where(eq(workflows.id, row.id));
    } catch (e) {
      console.error(`[poller] workflow ${row.id} reschedule failed:`, e);
    }

    try {
      await runOrgWorkflow({
        organizationId: row.organizationId,
        workflowId: row.id,
        triggerSource: "cron",
      });
    } catch (e) {
      console.error(`[poller] workflow ${row.id} run failed:`, e);
    }
  }
}
