/**
 * `dora.band_changed`: tell event subscriptions when one of the four DORA
 * metrics for production moves to another performance band.
 *
 * There is no stored "last band" on purpose. Each run compares the trailing
 * 30 complete UTC days ending at today's midnight with the 30 ending a day
 * earlier, both summarised from one load ({@link getDoraSummaries}), and
 * raises one event per metric whose band differs. The windows are aligned to
 * UTC days, so every run on the same day computes the same comparison, and
 * the idempotency key `dora-band:<org>:<metric>:<date>` makes repeats (another
 * replica, a restart, the next interval) no-ops. Production is whatever the
 * org's DORA settings say, because the analysis applies them.
 *
 * Cheap by construction: only orgs with an enabled subscription that would
 * take the type, and of those only orgs with a deploy in the span the
 * comparison reads, are loaded at all. Postgres only, so it runs on the edge.
 */
import { and, eq, gte, sql } from "drizzle-orm";
import {
  DORA_BAND_CHANGED,
  doraBandChanges,
  formatDeployFrequency,
  formatDoraHours,
  formatDoraRate,
  type DoraBandChange,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import { deployEvents, deploymentRuns, eventSubscriptions } from "../db/schema";
import { orgAppUrl } from "../app-url";
import { publishEvent } from "../events/publish";
import { getDoraSummaries, type DoraWindow } from "./load";

const DAY_MS = 24 * 3_600_000;

/** How often the pass runs. Several times a day so a missed tick costs hours, not a day. */
export const DORA_BAND_INTERVAL_MS = 6 * 3_600_000;

/** The trailing window each metric is banded over. */
export const DORA_BAND_WINDOW_DAYS = 30;

export interface DoraBandWindows {
  current: DoraWindow;
  previous: DoraWindow;
  /** Today (UTC), the day the comparison is for; the idempotency key's date. */
  date: string;
  /** First and last day of the current window (YYYY-MM-DD, inclusive). */
  windowStart: string;
  windowEnd: string;
}

function day(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

/** The two windows the run at `now` compares. Pure; exported for tests. */
export function doraBandWindows(now: Date): DoraBandWindows {
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const span = DORA_BAND_WINDOW_DAYS * DAY_MS;
  return {
    current: { from: new Date(end - span), to: new Date(end) },
    previous: { from: new Date(end - span - DAY_MS), to: new Date(end - DAY_MS) },
    date: day(end),
    windowStart: day(end - span),
    windowEnd: day(end - DAY_MS),
  };
}

const METRIC_LABELS: Record<DoraBandChange["metric"], string> = {
  deployment_frequency: "Deployment frequency",
  lead_time: "Lead time for changes",
  change_failure_rate: "Change failure rate",
  time_to_restore: "Time to restore",
};

function formatValue(change: DoraBandChange, value: number): string {
  if (change.metric === "deployment_frequency") return formatDeployFrequency(value);
  if (change.metric === "change_failure_rate") return formatDoraRate(value);
  return formatDoraHours(value);
}

/** The event title, e.g. "Lead time for changes improved from high to elite (6.5h)". Exported for tests. */
export function doraBandChangeTitle(change: DoraBandChange): string {
  return `${METRIC_LABELS[change.metric]} ${change.direction} from ${change.previousBand} to ${change.band} (${formatValue(change, change.value)})`;
}

/** Orgs with an enabled subscription that takes the type (or every type). */
async function subscribedOrgs(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ organizationId: eventSubscriptions.organizationId })
    .from(eventSubscriptions)
    .where(
      and(
        eq(eventSubscriptions.enabled, true),
        sql`(cardinality(${eventSubscriptions.eventTypes}) = 0 OR ${DORA_BAND_CHANGED.type} = ANY(${eventSubscriptions.eventTypes}))`,
      ),
    );
  return rows.map((r) => r.organizationId);
}

/** Any deploy, from a plugin, CI or an Infrafile run, since `since`. */
async function hasDeploysSince(organizationId: string, since: Date): Promise<boolean> {
  const [event] = await db
    .select({ id: deployEvents.id })
    .from(deployEvents)
    .where(
      and(eq(deployEvents.organizationId, organizationId), gte(deployEvents.deployedAt, since)),
    )
    .limit(1);
  if (event) return true;
  const [run] = await db
    .select({ id: deploymentRuns.id })
    .from(deploymentRuns)
    .where(
      and(eq(deploymentRuns.organizationId, organizationId), gte(deploymentRuns.startedAt, since)),
    )
    .limit(1);
  return Boolean(run);
}

/** Compare one org's windows and raise an event per metric that changed band. */
export async function checkOrgDoraBands(organizationId: string, now = new Date()): Promise<number> {
  const w = doraBandWindows(now);
  const [current, previous] = await getDoraSummaries(organizationId, [w.current, w.previous]);
  if (!current || !previous) return 0;
  const changes = doraBandChanges(previous, current);
  const url = orgAppUrl(organizationId, "delivery");
  for (const change of changes) {
    await publishEvent(
      DORA_BAND_CHANGED,
      organizationId,
      {
        metric: change.metric,
        previousBand: change.previousBand,
        band: change.band,
        direction: change.direction,
        value: change.value,
        previousValue: change.previousValue,
        sample: change.sample,
        windowStart: w.windowStart,
        windowEnd: w.windowEnd,
      },
      {
        title: doraBandChangeTitle(change),
        severity: change.direction === "worsened" ? "warning" : "info",
        url,
        idempotencyKey: `dora-band:${organizationId}:${change.metric}:${w.date}`,
      },
    );
  }
  return changes.length;
}

/** The poller pass. Never throws past one org: each failure is logged and the next org runs. */
export async function runDoraBandPass(now = new Date()): Promise<void> {
  const orgs = await subscribedOrgs();
  if (orgs.length === 0) return;
  // The earliest deploy the comparison can see: the previous window's start
  // less the same span again, which the loader reads for failure attribution.
  const since = new Date(
    doraBandWindows(now).previous.from.getTime() - DORA_BAND_WINDOW_DAYS * DAY_MS,
  );
  for (const organizationId of orgs) {
    try {
      if (!(await hasDeploysSince(organizationId, since))) continue;
      await checkOrgDoraBands(organizationId, now);
    } catch (err) {
      console.error(`[dora] band check for org ${organizationId} failed:`, err);
    }
  }
}
