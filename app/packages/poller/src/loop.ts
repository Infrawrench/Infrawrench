import { and, asc, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "@infrawrench/server-core/db/client";
import { accounts } from "@infrawrench/server-core/db/schema";
import { pollAccount, type PollAccountRow } from "./poll-account";
import { TokenBucketRegistry } from "./token-bucket";

const TICK_MS = 15_000;
const CONCURRENCY = 8;

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

      if (dueRows.length === 0) return;

      await Promise.allSettled(dueRows.map((row) => this.runOne(row)));
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
}
