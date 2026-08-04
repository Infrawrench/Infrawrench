import { eq } from "drizzle-orm";
import { nextCronOccurrence } from "@infrawrench/client-core";
import { db } from "@infrawrench/server-core/db/client";
import { workflows } from "@infrawrench/server-core/db/schema";
import { runOrgWorkflow } from "@infrawrench/server-core/workflows/runner";
import { loadPlugins } from "@infrawrench/server-core/plugin-loader";
import { runWeeklyDigests } from "@infrawrench/server-core/digest/weekly";
import { runStatusFeedCollection } from "@infrawrench/server-core/status/collect";
import { runExpiryAlerts } from "@infrawrench/server-core/expiry/alerts";
import { runPostureAlerts } from "@infrawrench/server-core/posture/alerts";
import { runSchedulePass } from "@infrawrench/server-core/schedules/pass";
import { runLeasePass } from "@infrawrench/server-core/leases/pass";
import { runLogAlertPass } from "@infrawrench/server-core/log-workspaces/pass";
import { runMetricAlertPass } from "@infrawrench/server-core/metric-alerts/pass";
import { runProbePass } from "@infrawrench/server-core/probes/pass";
import {
  pruneResourceChanges,
  CHANGE_RETENTION_INTERVAL_MS,
} from "@infrawrench/server-core/resource-changes";
import { TickLoop } from "@infrawrench/server-core/tick-loop";
import { pollAccount, type PollAccountRow } from "./poll-account";
import { pollAccountCosts } from "./cost-poll";
import {
  claimDueAccounts,
  claimDueCostAccounts,
  claimDueWorkflows,
  type DueWorkflowRow,
} from "./claim";
import { TokenBucketRegistry } from "./token-bucket";

export const DEFAULT_TICK_MS = 15_000;
export const DEFAULT_CONCURRENCY = 8;
const WORKFLOW_LIMIT = 8;
const COST_LIMIT = 2;

/** A workflow's `trigger` jsonb, narrowed to the cron fields we read. */
interface CronTrigger {
  kind?: string;
  expression?: string;
  timezone?: string;
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
    return nextCronOccurrence(t.expression, {
      from,
      ...(t.timezone ? { timezone: t.timezone } : {}),
    });
  } catch {
    return null;
  }
}

interface LoopOptions {
  tickMs?: number;
  concurrency?: number;
}

/**
 * Each tick atomically claims a batch of due accounts and workflows (see
 * `claim.ts`), so any number of poller instances can run concurrently against
 * the same database — scale out by adding replicas, no shard configuration.
 */
export class PollerLoop extends TickLoop {
  private buckets = new TokenBucketRegistry();
  private readonly concurrency: number;
  /** Plugin IDs whose manifest declares a `costs` capability; resolved lazily on first tick. */
  private costCapablePluginIds: string[] | null = null;
  /** Epoch ms of the last retention pass; 0 means "run on the first tick". */
  private lastRetentionAt = 0;

  constructor(options: LoopOptions = {}) {
    super("poller", options.tickMs ?? DEFAULT_TICK_MS);
    this.concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  }

  protected async runTick(): Promise<void> {
    const claimed = await claimDueAccounts(this.concurrency);
    if (claimed.length > 0) {
      await Promise.allSettled(claimed.map((row) => this.runOne(row)));
    }

    // Second pass: due cron workflows. Kept separate and defensive so a bad
    // workflow never affects account polling.
    await this.tickWorkflows();

    // Third pass: cost collection (daily cadence per account). Also
    // defensive — billing-API problems never affect resource polling.
    await this.tickCosts();

    // Fourth pass: weekly digests. A no-op outside the Monday-morning send
    // window; the conditional-UPDATE claim inside makes it replica- and
    // restart-safe, and it claims a bounded batch per call (see
    // `DIGESTS_PER_TICK`) so a morning where every org comes due at once drains
    // over several ticks instead of stalling this one. Defensive like the
    // others.
    await this.tickDigests();

    // Fifth pass: retention. Rate-limited to once an hour per process and
    // idempotent, so replicas and restarts just repeat cheap no-ops. Defensive
    // like the others.
    await this.tickRetention();

    // Sixth pass: provider status feeds. Claims due feeds with the same
    // SKIP LOCKED lease protocol as accounts (the lease lives in
    // `provider_status_feeds.next_fetch_at`), so replicas share the work.
    // Defensive like the others.
    await this.tickStatusFeeds();

    // Seventh pass: expiry alerts. A bounded batch of orgs whose 24h scan
    // window has elapsed; the conditional-upsert claim inside
    // (`org_expiry_settings.last_notified_at`) makes it replica- and
    // restart-safe. Defensive like the others.
    await this.tickExpiryAlerts();

    // Posture alerts: a bounded batch of orgs whose 24h posture-scan window
    // has elapsed; the conditional-upsert claim inside
    // (`org_posture_settings.last_notified_at`) makes it replica- and
    // restart-safe. Defensive like the others.
    await this.tickPostureAlerts();

    // Eighth pass: sleep/wake schedules. Claims due transitions with the
    // accounts lease protocol (`resource_schedules.next_transition_at`
    // doubles as the lease) and executes the plugin's declared lifecycle
    // action; idempotency keys make restarts safe. Defensive like the others.
    await this.tickSchedules();

    // Lease pass: resource leases with auto-delete. Claims due leases with
    // the accounts lease protocol (`resource_leases.next_check_at` doubles as
    // the lease), sends the two mandatory announcements and deletes the
    // resource at expiry, deferring during change freezes. Defensive like the
    // others.
    await this.tickLeases();

    // Ninth pass: log-match alerts. Claims due alert-enabled saved log
    // queries with the same lease protocol (`log_workspace_queries.
    // next_eval_at` doubles as the lease), fetches a bounded tail per stream
    // through the plugin `getLogs` contract and notifies on match, with a
    // per-query cooldown. Defensive like the others.
    await this.tickLogAlerts();

    // Tenth pass: metric threshold alert rules. Claims due rules with the
    // accounts lease protocol (`metric_alert_rules.next_eval_at` doubles as
    // the lease), judges each rule's trailing window against ClickHouse, and
    // opens/resolves firing events. Defensive like the others.
    await this.tickMetricAlerts();

    // Eleventh pass: synthetic probes. Claims due probes with the accounts
    // lease protocol (`synthetic_probes.next_probe_at` doubles as the lease —
    // the claim writes the probe's own interval), runs each through the
    // egress proxy's /probe endpoint from outside the cluster, records the
    // result as metric points and runs the up/down state machine. Skips
    // silently when the proxy env isn't configured. Defensive like the
    // others.
    await this.tickProbes();
  }

  private async runOne(row: PollAccountRow): Promise<void> {
    try {
      await pollAccount(row, this.buckets);
    } catch (e) {
      // The claim lease stays in place, so this account retries when it
      // expires rather than hot-looping every tick.
      console.error(`[poller] account ${row.id} (${row.pluginId}) poll failed:`, e);
    }
  }

  /** Claim due cron workflows, reschedule them to their true next fire, run them. */
  private async tickWorkflows(): Promise<void> {
    try {
      const claimed = await claimDueWorkflows(WORKFLOW_LIMIT);
      if (claimed.length === 0) return;

      await Promise.allSettled(claimed.map((row) => this.runWorkflowOnce(row)));
    } catch (e) {
      console.error("[poller] workflow tick failed:", e);
    }
  }

  /** Claim accounts due for cost collection and run them. */
  private async tickCosts(): Promise<void> {
    try {
      if (!this.costCapablePluginIds) {
        const loaded = await loadPlugins();
        this.costCapablePluginIds = loaded
          .filter((l) => l.plugin.manifest.costs)
          .map((l) => l.plugin.manifest.id);
      }
      const claimed = await claimDueCostAccounts(COST_LIMIT, this.costCapablePluginIds);
      if (claimed.length === 0) return;
      await Promise.allSettled(claimed.map((row) => pollAccountCosts(row)));
    } catch (e) {
      console.error("[poller] cost tick failed:", e);
    }
  }

  /** Fetch any provider status feeds that have come due. */
  private async tickStatusFeeds(): Promise<void> {
    try {
      await runStatusFeedCollection();
    } catch (e) {
      console.error("[poller] status feed tick failed:", e);
    }
  }

  /** Scan a bounded batch of orgs whose expiry-alert window has come due. */
  private async tickExpiryAlerts(): Promise<void> {
    try {
      await runExpiryAlerts({ limit: 4 });
    } catch (e) {
      console.error("[poller] expiry alert tick failed:", e);
    }
  }

  /** Scan a bounded batch of orgs whose posture-alert window has come due. */
  private async tickPostureAlerts(): Promise<void> {
    try {
      await runPostureAlerts({ limit: 4 });
    } catch (e) {
      console.error("[poller] posture alert tick failed:", e);
    }
  }

  /** Execute any sleep/wake schedule transitions that have come due. */
  private async tickSchedules(): Promise<void> {
    try {
      await runSchedulePass({ limit: 4 });
    } catch (e) {
      console.error("[poller] schedule tick failed:", e);
    }
  }

  /** Advance any due auto-delete resource leases (announce / defer / delete). */
  private async tickLeases(): Promise<void> {
    try {
      await runLeasePass({ limit: 4 });
    } catch (e) {
      console.error("[poller] lease tick failed:", e);
    }
  }

  /** Evaluate any alert-enabled saved log queries that have come due. */
  private async tickLogAlerts(): Promise<void> {
    try {
      await runLogAlertPass({ limit: 4 });
    } catch (e) {
      console.error("[poller] log alert tick failed:", e);
    }
  }

  /** Evaluate any metric threshold alert rules that have come due. */
  private async tickMetricAlerts(): Promise<void> {
    try {
      await runMetricAlertPass({ limit: 8 });
    } catch (e) {
      console.error("[poller] metric alert tick failed:", e);
    }
  }

  /** Run any synthetic probes that have come due. */
  private async tickProbes(): Promise<void> {
    try {
      await runProbePass({ limit: 8 });
    } catch (e) {
      console.error("[poller] probe tick failed:", e);
    }
  }

  /** Send any weekly digests that have come due. */
  private async tickDigests(): Promise<void> {
    try {
      await runWeeklyDigests();
    } catch (e) {
      console.error("[poller] digest tick failed:", e);
    }
  }

  /**
   * Trim the change timeline back to its retention window.
   *
   * Unlike the digest there is no claim: the prune is idempotent and uses
   * `SKIP LOCKED`, so several replicas running it costs a little duplicated
   * index probing and nothing else. The in-process clock is only there to keep
   * the work off the 15s tick — a restarted poller pruning again immediately
   * finds nothing to delete.
   */
  private async tickRetention(): Promise<void> {
    const now = Date.now();
    if (this.lastRetentionAt !== 0 && now - this.lastRetentionAt < CHANGE_RETENTION_INTERVAL_MS) {
      return;
    }
    this.lastRetentionAt = now;
    try {
      await pruneResourceChanges();
    } catch (e) {
      console.error("[poller] retention tick failed:", e);
    }
  }

  private async runWorkflowOnce(row: DueWorkflowRow): Promise<void> {
    // The claim leased this workflow ~10 minutes out; replace that with the
    // cron's true next fire time before running. If this write fails, the
    // lease bounds the retry rather than letting the next tick re-fire it.
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
