/**
 * Every unit of work the poller does on a tick, in tick order, shared by the
 * Node loop (`loop.ts`) and the edge Worker (`edge/worker.ts`).
 *
 * Two shapes:
 *
 * - **Account passes** claim a batch of accounts and then work each one. They
 *   run on both runtimes: the claim takes a {@link PollScope}, so the edge
 *   claims accounts that need nothing Node-only and the gateway claims the
 *   rest (`runtime/account-runtime.ts`). Split into `claim` and `run` so the
 *   edge can give every claimed account its own Worker invocation.
 * - **Periodic passes** are one call that claims its own work internally (all
 *   of them use a row lease, so any number of instances can run one at once).
 *   Each is pinned to one runtime. `gateway` means the pass either needs Node
 *   outright (the workflow isolate) or calls plugin code for arbitrary
 *   accounts, where an account behind a bastion or a socket driver would fail
 *   on the edge with nothing to hand it over; `edge` passes touch only
 *   Postgres, ClickHouse and fixed HTTPS services.
 *
 * Every `run` is defensive: it logs and swallows its own failure, so one
 * broken pass never stops the next, on either runtime.
 */
import { eq } from "drizzle-orm";
import { nextCronOccurrence } from "@infrawrench/client-core";
import { db } from "@infrawrench/server-core/db/client";
import { workflows } from "@infrawrench/server-core/db/schema";
import { runOrgWorkflow } from "@infrawrench/server-core/workflows/runner";
import { loadPlugins } from "@infrawrench/server-core/plugin-loader";
import type { PollScope } from "@infrawrench/server-core/runtime/account-runtime";
import { runWeeklyDigests } from "@infrawrench/server-core/digest/weekly";
import { runStatusFeedCollection } from "@infrawrench/server-core/status/collect";
import { runExpiryAlerts } from "@infrawrench/server-core/expiry/alerts";
import { runPostureAlerts } from "@infrawrench/server-core/posture/alerts";
import { runSavingsFindingScan } from "@infrawrench/server-core/github-issues/savings-scan";
import { runExtendedSupportAlerts } from "@infrawrench/server-core/extended-support/alerts";
import { runSchedulePass } from "@infrawrench/server-core/schedules/pass";
import { runLeasePass } from "@infrawrench/server-core/leases/pass";
import { runTrialExpiryPass } from "@infrawrench/server-core/trials/pass";
import {
  runEnvironmentRepairPass,
  runEnvironmentReconcilePass,
} from "@infrawrench/server-core/environments/pass";
import { runLogAlertPass } from "@infrawrench/server-core/log-workspaces/pass";
import { runMetricAlertPass } from "@infrawrench/server-core/metric-alerts/pass";
import { runQueryMonitorPass } from "@infrawrench/server-core/query-monitors/pass";
import { runBusinessMetricImportPass } from "@infrawrench/server-core/cost/metric-import-pass";
import { runProbePass } from "@infrawrench/server-core/probes/pass";
import { pruneAlertDeliveries, runAlertFollowUpPass } from "@infrawrench/server-core/alerts/pass";
import { runPagingProvidersPass } from "@infrawrench/server-core/paging/providers";
import { runJitAccessExpiryPass } from "@infrawrench/server-core/jit-access/service";
import { runCostExportPass } from "@infrawrench/server-core/cost-exports/pass";
import { runNetworkFlowPass } from "@infrawrench/server-core/network-flow/pass";
import { runAiAttributionPass } from "@infrawrench/server-core/ai-attribution/pass";
import { runReportDeliveryPass } from "@infrawrench/server-core/report-delivery/pass";
import { runVirtualTagPass } from "@infrawrench/server-core/cost/virtual-tag-pass";
import { runFxRateFeedPass } from "@infrawrench/server-core/cost/fx-feed-pass";
import {
  pruneResourceChanges,
  CHANGE_RETENTION_INTERVAL_MS,
} from "@infrawrench/server-core/resource-changes";
import {
  pruneSessionRecordings,
  settleAbandonedRecordings,
} from "@infrawrench/server-core/ssh-recording/retention";
import { pruneCreditSnapshots } from "@infrawrench/server-core/credits/feed";
import { pruneQuotaSnapshots } from "@infrawrench/server-core/quotas/feed";
import { runQuotaAlerts } from "@infrawrench/server-core/quotas/alerts";
import { pruneIacStates } from "@infrawrench/server-core/iac/store";
import { pollAccount, type PollAccountRow } from "./poll-account";
import { pollAccountCosts } from "./cost-poll";
import { pollAccountCredits } from "./credit-poll";
import { pollAccountCommitments } from "./commitment-poll";
import { pollAccountQuotas } from "./quota-poll";
import {
  claimDueAccounts,
  claimDueCommitmentAccounts,
  claimDueCostAccounts,
  claimDueCreditAccounts,
  claimDueQuotaAccounts,
  claimDueWorkflows,
  ACCOUNT_LEASE_MS,
  COST_LEASE_MS,
  type DueWorkflowRow,
} from "./claim";
import type { PollKind } from "./gateway-handoff";
import type { TokenBucketRegistry } from "./token-bucket";

const WORKFLOW_LIMIT = 8;
const COST_LIMIT = 2;

/** What the passes share across ticks within one process or isolate. */
export interface PassContext {
  buckets: TokenBucketRegistry;
  /** Accounts claimed per tick by the resource pass. */
  concurrency: number;
}

export interface AccountPass {
  kind: "accounts";
  name: PollKind;
  /**
   * Log prefix for a failed claim, which is then swallowed. Unset for the
   * resource pass: a database that cannot claim accounts fails the whole
   * tick, loudly, as it always has.
   */
  claimFailureLabel?: string;
  /**
   * How long the claim leases a row. The edge works a claimed row in a later
   * invocation; one that arrives after its lease ran out may already have
   * been claimed again, so it is dropped rather than worked twice.
   */
  leaseMs: number;
  claim: (scope: PollScope, ctx: PassContext) => Promise<PollAccountRow[]>;
  run: (row: PollAccountRow, ctx: PassContext) => Promise<void>;
}

export interface PeriodicPass {
  kind: "periodic";
  name: string;
  runtime: "edge" | "gateway";
  /**
   * Skip the pass until this long after it last ran. Only for passes with no
   * row lease to throttle them; the Node loop keeps the clock in memory and
   * the edge scheduler in Durable Object storage.
   */
  minIntervalMs?: number;
  run: () => Promise<void>;
}

export type Pass = AccountPass | PeriodicPass;

type Capability = "costs" | "credits" | "commitments" | "quotas";
const capablePluginIds = new Map<Capability, Promise<string[]>>();

/** Plugin ids whose manifest declares `capability`; resolved once per process. */
function pluginsWith(capability: Capability): Promise<string[]> {
  let ids = capablePluginIds.get(capability);
  if (!ids) {
    ids = loadPlugins().then((loaded) =>
      loaded.filter((l) => l.plugin.manifest[capability]).map((l) => l.plugin.manifest.id),
    );
    // A failed load must not be cached forever: drop it so the next tick retries.
    ids.catch(() => capablePluginIds.delete(capability));
    capablePluginIds.set(capability, ids);
  }
  return ids;
}

/** Wrap a pass body so a failure is logged and swallowed. */
function guarded(label: string, body: () => Promise<unknown>): () => Promise<void> {
  return async () => {
    try {
      await body();
    } catch (e) {
      console.error(label, e);
    }
  };
}

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

async function runWorkflowOnce(row: DueWorkflowRow): Promise<void> {
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

/**
 * Trim the change timeline (and the other whole-table prunes that share its
 * slot) back to their retention windows. Idempotent and `SKIP LOCKED`, so
 * running it on several replicas costs only duplicated index probing; the
 * pass's `minIntervalMs` keeps it off every tick.
 */
async function runRetention(): Promise<void> {
  try {
    await pruneResourceChanges();
  } catch (e) {
    console.error("[poller] retention tick failed:", e);
  }
  // Session recordings ride the same hourly slot rather than a clock of their
  // own: both are idempotent whole-table prunes with nothing to coordinate,
  // and a second timer would only make "when does old data actually go" two
  // answers instead of one. Their windows differ (recordings are per-org
  // policy, changes are a fixed 90 days) but their cadence has no reason to.
  try {
    await pruneSessionRecordings();
    // Rows the recorder never got to close: a web replica killed mid-session
    // leaves one saying "recording" forever. The list view derives the same
    // thing for display; this makes it true in the table so a SQL-level
    // reader (the CLI's `--json`, an export) agrees with the UI.
    await settleAbandonedRecordings();
  } catch (e) {
    console.error("[poller] session-recording retention tick failed:", e);
  }
  // Credit snapshots keep a year rather than the 30-day burn window: the
  // rows are tiny, and a longer series is the only way to answer "what did
  // this cost us last quarter" if anyone ever asks.
  try {
    await pruneCreditSnapshots();
  } catch (e) {
    console.error("[poller] credit snapshot retention tick failed:", e);
  }
  // Quota snapshots keep a year for the same reason credit snapshots do:
  // the rows are tiny, and a longer series is the only way to answer "when
  // did this start climbing" after the fact.
  try {
    await pruneQuotaSnapshots();
  } catch (e) {
    console.error("[poller] quota snapshot retention tick failed:", e);
  }
  // Delivery rows ride the same hourly clock rather than their own: the work
  // is idempotent and tiny, and a second clock would be a second thing to
  // reason about for no benefit.
  try {
    await pruneAlertDeliveries();
  } catch (e) {
    console.error("[poller] alert delivery retention failed:", e);
  }
  // Uploaded Terraform state documents, same hourly slot. The newest per
  // org+account scope is always kept: retention here is about superseded
  // snapshots, not about forgetting what an org told us Terraform manages.
  try {
    await pruneIacStates();
  } catch (e) {
    console.error("[poller] IaC state retention failed:", e);
  }
}

export const PASSES: readonly Pass[] = [
  // Resource polling: the reason the poller exists.
  {
    kind: "accounts",
    name: "resources",
    leaseMs: ACCOUNT_LEASE_MS,
    claim: (scope, ctx) => claimDueAccounts(ctx.concurrency, scope),
    run: async (row, ctx) => {
      try {
        await pollAccount(row, ctx.buckets);
      } catch (e) {
        // The claim lease stays in place, so this account retries when it
        // expires rather than hot-looping every tick.
        console.error(`[poller] account ${row.id} (${row.pluginId}) poll failed:`, e);
      }
    },
  },

  // Due cron workflows. Gateway-only: the workflow isolate is QuickJS wasm
  // plus the TypeScript compiler, neither of which a Worker can load.
  {
    kind: "periodic",
    name: "workflows",
    runtime: "gateway",
    run: guarded("[poller] workflow tick failed:", async () => {
      const claimed = await claimDueWorkflows(WORKFLOW_LIMIT);
      if (claimed.length === 0) return;
      await Promise.allSettled(claimed.map((row) => runWorkflowOnce(row)));
    }),
  },

  // Cost collection (daily cadence per account). Billing-API problems never
  // affect resource polling: separate claim, separate failure columns.
  {
    kind: "accounts",
    name: "costs",
    leaseMs: COST_LEASE_MS,
    claimFailureLabel: "[poller] cost tick failed:",
    claim: async (scope) => claimDueCostAccounts(COST_LIMIT, await pluginsWith("costs"), scope),
    run: (row) => pollAccountCosts(row),
  },

  // Prepaid credit balances (twice-daily cadence per account). Separate from
  // the cost pass rather than folded into it: the capabilities are
  // independent (most prepaid providers bill nothing in arrears and expose
  // no cost API at all) and a provider whose billing endpoint is down must
  // not stop us reading a balance that is about to hit zero.
  {
    kind: "accounts",
    name: "credits",
    leaseMs: COST_LEASE_MS,
    claimFailureLabel: "[poller] credit tick failed:",
    claim: async (scope) => claimDueCreditAccounts(COST_LIMIT, await pluginsWith("credits"), scope),
    run: (row) => pollAccountCredits(row),
  },

  // Commitment inventories (daily cadence per account). Separate from the
  // cost pass for the same reason credits are: reservations and savings
  // plans come from management APIs, not billing ones, and a billing
  // outage must not stop us noticing a commitment that expires tomorrow.
  {
    kind: "accounts",
    name: "commitments",
    leaseMs: COST_LEASE_MS,
    claimFailureLabel: "[commitments] commitment tick failed:",
    claim: async (scope) =>
      claimDueCommitmentAccounts(COST_LIMIT, await pluginsWith("commitments"), scope),
    run: (row) => pollAccountCommitments(row),
  },

  // Provider quota utilisation (four times a day per account). Its own pass
  // rather than part of the cost pass for the reason credits and commitments
  // have theirs: a quota is a management-API fact, not a billing one, and
  // running out of vCPUs is an outage rather than an invoice, so a billing
  // outage must not stop us noticing it.
  {
    kind: "accounts",
    name: "quotas",
    leaseMs: COST_LEASE_MS,
    claimFailureLabel: "[quotas] quota tick failed:",
    claim: async (scope) => claimDueQuotaAccounts(COST_LIMIT, await pluginsWith("quotas"), scope),
    run: (row) => pollAccountQuotas(row),
  },

  // Network flow attribution (daily cadence per account, opt-in per org).
  // Its own pass rather than part of the cost pass for two reasons that both
  // matter: the data comes from the provider's *log* store rather than its
  // billing API, so a billing outage is unrelated to it; and every query it
  // runs is billed to the customer's own cloud account, so it must be
  // separately gated, separately throttled, and separately switchable off
  // without taking spend collection down with it.
  {
    kind: "periodic",
    name: "network-flows",
    runtime: "gateway",
    run: guarded("[network-flow] flow tick failed:", () => runNetworkFlowPass({ limit: 2 })),
  },

  // AI request attribution: read configured request-log sources (Bedrock
  // invocation logs, AI Gateway logs, LiteLLM, JSONL) one settled day at a
  // time and re-split the day's billed AI spend by caller. Its own pass for
  // the network-flow reason: log stores, not billing APIs, and the
  // CloudWatch kind is billed to the customer per GB scanned.
  {
    kind: "periodic",
    name: "ai-attribution",
    runtime: "gateway",
    run: guarded("[ai-attribution] source tick failed:", () => runAiAttributionPass({ limit: 2 })),
  },

  // Weekly digests. A no-op outside the Monday-morning send window; the
  // conditional-UPDATE claim inside makes it replica- and restart-safe, and
  // it claims a bounded batch per call so a morning where every org comes due
  // at once drains over several ticks instead of stalling this one.
  {
    kind: "periodic",
    name: "digests",
    runtime: "edge",
    run: guarded("[poller] digest tick failed:", () => runWeeklyDigests()),
  },

  // Retention: idempotent prunes, at most hourly.
  {
    kind: "periodic",
    name: "retention",
    runtime: "edge",
    minIntervalMs: CHANGE_RETENTION_INTERVAL_MS,
    run: runRetention,
  },

  // Provider status feeds. Claims due feeds with the same SKIP LOCKED lease
  // protocol as accounts (the lease lives in
  // `provider_status_feeds.next_fetch_at`), so replicas share the work.
  {
    kind: "periodic",
    name: "status-feeds",
    runtime: "edge",
    run: guarded("[poller] status feed tick failed:", () => runStatusFeedCollection()),
  },

  // Expiry alerts. A bounded batch of orgs whose 24h scan window has elapsed;
  // the conditional-upsert claim inside (`org_expiry_settings.last_notified_at`)
  // makes it replica- and restart-safe.
  {
    kind: "periodic",
    name: "expiry-alerts",
    runtime: "edge",
    run: guarded("[poller] expiry alert tick failed:", () => runExpiryAlerts({ limit: 4 })),
  },

  // Quota alerts: a bounded batch of orgs whose 24h quota-scan window has
  // elapsed, claimed on `org_quota_settings.last_notified_at`.
  {
    kind: "periodic",
    name: "quota-alerts",
    runtime: "edge",
    run: guarded("[quotas] quota alert tick failed:", () => runQuotaAlerts({ limit: 4 })),
  },

  // Posture alerts: a bounded batch of orgs whose 24h posture-scan window has
  // elapsed, claimed on `org_posture_settings.last_notified_at`.
  {
    kind: "periodic",
    name: "posture-alerts",
    runtime: "edge",
    run: guarded("[poller] posture alert tick failed:", () => runPostureAlerts({ limit: 4 })),
  },

  // Savings scan: new orphaned/oversized findings raise `savingsFindings`
  // (which a routing rule can send to GitHub issues), and findings that went
  // away resolve their issues. Six-hourly per org, claimed like the radars.
  {
    kind: "periodic",
    name: "savings-scan",
    runtime: "edge",
    run: guarded("[poller] savings scan tick failed:", () => runSavingsFindingScan({ limit: 3 })),
  },

  // Extended-support alerts: the same claim engine on a seven-day window
  // (`org_extended_support_settings.last_notified_at`).
  {
    kind: "periodic",
    name: "extended-support-alerts",
    runtime: "edge",
    run: guarded("[extended-support] alert tick failed:", () =>
      runExtendedSupportAlerts({ limit: 4 }),
    ),
  },

  // Sleep/wake schedules. Claims due transitions with the accounts lease
  // protocol (`resource_schedules.next_transition_at` doubles as the lease)
  // and executes the plugin's declared lifecycle action; idempotency keys
  // make restarts safe.
  {
    kind: "periodic",
    name: "schedules",
    runtime: "gateway",
    run: guarded("[poller] schedule tick failed:", () => runSchedulePass({ limit: 4 })),
  },

  // Resource leases with auto-delete. Claims due leases with the accounts
  // lease protocol (`resource_leases.next_check_at` doubles as the lease),
  // sends the two mandatory announcements and deletes the resource at
  // expiry, deferring during change freezes.
  {
    kind: "periodic",
    name: "leases",
    runtime: "gateway",
    run: guarded("[poller] lease tick failed:", () => runLeasePass({ limit: 4 })),
  },

  // Trial reaper: destroy unclaimed agent trial orgs past their 24 hours.
  // Sits beside the lease pass because it is the same shape of work (a clock
  // ran out, something gets deleted) but takes no claim, since destruction
  // is idempotent across all three stores it touches. Unlike every other pass
  // this one deletes a whole tenant, so the result is logged even when it is
  // zero-work.
  {
    kind: "periodic",
    name: "trials",
    runtime: "gateway",
    run: guarded("[poller] trial reaper tick failed:", async () => {
      const result = await runTrialExpiryPass({ limit: 10 });
      if (result.due > 0) {
        console.log(
          `[poller] trial reaper: ${result.destroyed} destroyed, ${result.failed} failed ` +
            `of ${result.due} due`,
        );
      }
    }),
  },

  // Ephemeral-environment repair, right after the lease pass because it
  // *feeds* it: a member stranded with a live resource and no lease is
  // invisible to leases until this gives it one. Without it the whole recovery
  // story depended on somebody opening the Environments page, and the
  // environment whose creation failed badly is the one nobody opens again,
  // and the one still billing. Repair and reconcile are guarded separately so
  // a throwing repair cannot take the reconcile half down with it.
  {
    kind: "periodic",
    name: "environments",
    runtime: "gateway",
    run: async () => {
      await guarded("[poller] environment repair tick failed:", async () => {
        const result = await runEnvironmentRepairPass({ limit: 4 });
        if (result.claimed > 0) {
          console.log(
            `[poller] environment repair: ${result.repaired} repaired, ${result.failed} failed`,
          );
        }
      })();
      await guarded("[poller] environment reconcile tick failed:", () =>
        runEnvironmentReconcilePass({ limit: 10 }),
      )();
    },
  },

  // Log-match alerts. Fetches a bounded tail per stream through the plugin
  // `getLogs` contract and notifies on match, with a per-query cooldown.
  {
    kind: "periodic",
    name: "log-alerts",
    runtime: "gateway",
    run: guarded("[poller] log alert tick failed:", () => runLogAlertPass({ limit: 4 })),
  },

  // Metric threshold alert rules, judged against ClickHouse.
  {
    kind: "periodic",
    name: "metric-alerts",
    runtime: "edge",
    run: guarded("[poller] metric alert tick failed:", () => runMetricAlertPass({ limit: 8 })),
  },

  // Query monitors: a small batch of due SQL checks, each opening a
  // connection to somebody else's production database. Gateway-only by
  // construction (socket database drivers).
  {
    kind: "periodic",
    name: "query-monitors",
    runtime: "gateway",
    run: guarded("[query-monitors] tick failed:", () => runQueryMonitorPass({ limit: 5 })),
  },

  // Business-metric importers: a small batch of due pulls (CloudWatch,
  // warehouse SQL, billing platforms) that restate a metric's trailing days.
  {
    kind: "periodic",
    name: "metric-imports",
    runtime: "gateway",
    run: guarded("[metric-import] tick failed:", () => runBusinessMetricImportPass({ limit: 3 })),
  },

  // Synthetic probes, run through the egress proxy's /probe endpoint from
  // outside the cluster. Skips silently when the proxy env isn't configured.
  {
    kind: "periodic",
    name: "probes",
    runtime: "edge",
    run: guarded("[poller] probe tick failed:", () => runProbePass({ limit: 8 })),
  },

  // Alert follow-up: releases quiet-hours holds whose window has closed and
  // escalates alerts nobody acknowledged. Cheap when idle: two indexed range
  // scans that usually return nothing.
  {
    kind: "periodic",
    name: "alert-follow-up",
    runtime: "edge",
    run: guarded("[poller] alert follow-up tick failed:", async () => {
      const stats = await runAlertFollowUpPass();
      if (stats.flushed > 0 || stats.escalated > 0) {
        console.log(
          `[poller] alert follow-up: released ${stats.flushed} held, escalated ${stats.escalated}`,
        );
      }
    }),
  },

  // Paging providers (PagerDuty, incident.io): sends queued outbound events
  // (triggers raised on the web edge, retries after a provider outage, the
  // acknowledge/resolve that follows) and reconciles mirrored incidents for
  // accounts with inbound turned on. Gateway: it calls plugin code for
  // arbitrary accounts, some of which may sit behind a bastion.
  {
    kind: "periodic",
    name: "paging-providers",
    runtime: "gateway",
    run: guarded("[poller] paging provider tick failed:", async () => {
      const stats = await runPagingProvidersPass();
      if (stats.sent > 0 || stats.synced > 0) {
        console.log(`[poller] paging providers: sent ${stats.sent}, reconciled ${stats.synced}`);
      }
    }),
  },

  // Just-in-time access: revokes grants whose window ended, retries failed
  // revokes on a backoff (forever, and loudly), finishes grants the approval
  // could not complete inline, and times out undecided requests. Gateway: it
  // calls plugin code (grant/revoke) for arbitrary accounts, some behind a
  // bastion. Runs every tick so a window ends within a minute of its time.
  {
    kind: "periodic",
    name: "jit-access-expiry",
    runtime: "gateway",
    run: guarded("[jit-access] expiry tick failed:", async () => {
      const stats = await runJitAccessExpiryPass({ limit: 50 });
      if (stats.timedOut || stats.granted || stats.revoked || stats.failed) {
        console.log(
          `[jit-access] sweep: ${stats.revoked} revoked, ${stats.granted} granted, ` +
            `${stats.timedOut} timed out, ${stats.failed} failed`,
        );
      }
    }),
  },

  // Scheduled cost exports: streams the org's cost rows out of ClickHouse and
  // writes them to the export's bucket or HTTPS endpoint, through the Node
  // egress path (`cost-exports/egress.ts`).
  {
    kind: "periodic",
    name: "cost-exports",
    runtime: "gateway",
    run: guarded("[cost-export] export tick failed:", () => runCostExportPass({ limit: 2 })),
  },

  // Scheduled cost-report deliveries: runs each schedule's saved report and
  // posts the summary to its Slack channels, Teams webhooks and email list.
  {
    kind: "periodic",
    name: "report-deliveries",
    runtime: "edge",
    run: guarded("[report-delivery] delivery tick failed:", () =>
      runReportDeliveryPass({ limit: 4 }),
    ),
  },

  // Virtual tag processing: evaluates due tags over the org's stored history
  // for the status Settings shows.
  {
    kind: "periodic",
    name: "virtual-tags",
    runtime: "edge",
    run: guarded("[virtual-tags] processing tick failed:", () => runVirtualTagPass()),
  },

  // Exchange-rate feed: the ECB euro reference rates, one global row claimed
  // with a conditional-UPDATE lease, so most ticks this is one UPDATE that
  // matches nothing.
  {
    kind: "periodic",
    name: "fx-rate-feed",
    runtime: "edge",
    run: guarded("[fx-feed] feed tick failed:", () => runFxRateFeedPass()),
  },
];

/**
 * The passes a poller instance with `scope` runs. `all` runs everything;
 * each half of the split runs every account pass (scoped by its claim) and
 * the periodic passes pinned to it.
 */
export function passesFor(scope: PollScope): Pass[] {
  return PASSES.filter((p) => p.kind === "accounts" || scope === "all" || p.runtime === scope);
}

export function findPass(name: string): Pass | undefined {
  return PASSES.find((p) => p.name === name);
}
