/**
 * Cost anomaly evaluation. Runs from the poller after each successful cost
 * collection for an org — the same trigger point as budget evaluation, because
 * org cost data only changes when collection runs, so a daily-per-account
 * collection cadence gives a daily detection cadence for free.
 *
 * The maths live in `anomaly-detect.ts` (pure, unit-tested); this module reads
 * the series from ClickHouse, persists what was flagged, and fans out through
 * the existing notification transports under the `anomalyAlerts` trigger. The
 * thresholds it judges against are per-org (`anomaly-settings.ts`), read once
 * per pass — the detector itself stays pure and takes them as arguments.
 *
 * Two findings share this pipeline: a statistical `spike`, and a `new_source`
 * — a provider or service with no prior spend that suddenly costs money, which
 * no sigma bar can catch. They share the table, the dedup index, the cooldown,
 * the list endpoint and the fan-out, and differ only in a `kind` discriminator
 * and the wording of the alert.
 *
 * Dedup happens in two layers:
 * - The unique index on cost_anomalies (org, day, dimension, key, currency)
 *   plus `notifiedAt`: an upsert refreshes a known anomaly's amounts and
 *   returns the row, and only rows still lacking a `notifiedAt` are candidates
 *   to notify. That makes each anomaly alert at most once no matter how many
 *   passes re-examine the day, while leaving a stored-but-undelivered anomaly
 *   (no transports configured, or a transient Slack/Expo failure) eligible for
 *   a later pass to pick up instead of losing it permanently.
 * - A cross-day cooldown: a sustained level shift is anomalous against the
 *   trailing window for several days running, and re-alerting each morning
 *   about the same jump is noise. An anomaly for a key that was *notified*
 *   within the previous `COOLDOWN_DAYS` days is stored (the list UI still
 *   shows it) but not notified. Counting only notified rows matters twice
 *   over: a suppressed row must not extend its own quiet period into an
 *   unbounded rolling silence, and a row nobody ever received must not
 *   suppress the alert that would have told them.
 */
import { and, eq, gte, isNotNull, lt, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../db/client";
import { costAnomalies } from "../db/schema";
import { getCostCoverage, queryCosts } from "../clickhouse/cost-readers";
import { sendPushToOrg } from "../push/dispatch";
import { sendSlackToOrg } from "../slack";
import { sendMsTeamsToOrg } from "../msteams";
import {
  detectNewSpendSource,
  detectSpike,
  fillDailySeries,
  optionsForCurrency,
  type AnomalyDetectionOptions,
} from "./anomaly-detect";
import { anomalyOptionsForOrg } from "./anomaly-settings";
import { isoDay, addDays, daysBetween } from "./dates";

/** Days of history the baseline is computed over (excluding the day itself). */
const BASELINE_DAYS = 28;

/** Days a key stays quiet after notifying, so a level shift alerts once. */
const COOLDOWN_DAYS = 7;

/**
 * How many trailing days each pass re-examines, most recent last.
 *
 * Evaluating only yesterday would be wrong in two ways, because a day's spend
 * is not final when the day ends. Providers restate late, which is why
 * collection itself re-fetches a trailing window (`DEFAULT_RESTATEMENT_DAYS`
 * in `collect.ts`); and an org's accounts collect at jittered times spread
 * over a 24h cycle, so the first account to run sees an org-wide total for
 * "yesterday" that is missing every other account's share. A day looked at
 * once, early, could read as unremarkable and never be reconsidered — a real
 * spike lost for good. Re-examining the same window collection re-fetches
 * means a day is judged again as it fills in.
 */
const EVALUATION_DAYS = 3;

/**
 * Least time between full evaluations of one org.
 *
 * Detection is invoked per account, so an org with N cost accounts would
 * otherwise issue 2N grouped 29-day ClickHouse reads a day for an answer that
 * only moves when a day's data changes. Correctness never rests on this gate —
 * the unique index does that — so an in-process map is enough: the cost of a
 * poller restart, or of a second replica, is an extra pass, not a double
 * alert.
 */
const MIN_EVAL_INTERVAL_MS = 60 * 60 * 1000;

/** orgId → epoch ms of the last evaluation. Best-effort, per process. */
const lastEvaluatedAt = new Map<string, number>();

/** The two breakdowns evaluated — matches the `dimension` column's type. */
const DIMENSIONS = ["provider", "service"] as const;
type AnomalyDimension = (typeof DIMENSIONS)[number];

/** Deep link to the costs panel, for the Slack/Teams message button. */
function costsUrl(organizationId: string): string | null {
  const base = process.env["APP_URL"];
  if (!base) return null;
  return `${base.replace(/\/$/, "")}/org/${organizationId}/costs`;
}

function formatAmount(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: amount < 10 ? 2 : 0,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

type AnomalyKind = "spike" | "new_source";

interface PendingAnomaly {
  id: string;
  day: string;
  kind: AnomalyKind;
  dimension: AnomalyDimension;
  dimensionKey: string;
  currency: string;
  actual: number;
  mean: number;
  threshold: number;
}

/** What one of the two detectors found, flattened to what a row needs. */
interface Finding {
  kind: AnomalyKind;
  actual: number;
  mean: number;
  threshold: number;
}

/**
 * The org's earliest cost day, or null when it has none at all.
 *
 * This is the org's *collection coverage*, and `detectNewSpendSource` cannot
 * work without it: the baselines below are zero-filled to a fixed width, so a
 * day nobody collected and a day the key spent $0 are the same `0` by the time
 * the detector sees them, and a brand-new org would read as an all-zero
 * 28-day history for every provider and every service at once.
 *
 * Read once per pass, from the existing per-account coverage aggregate. It
 * costs one extra ClickHouse read per org per pass (an hour apart at worst),
 * which is the price of the fact being exact. Deriving it instead from the
 * window `detectForDimension` already fetches would be free but wrong in one
 * direction that matters: that window only reaches back
 * `BASELINE_DAYS + EVALUATION_DAYS`, so an established org that spent nothing
 * at all for a month and then started again would look brand new and have its
 * genuine new source suppressed.
 */
async function firstCostDayForOrg(organizationId: string): Promise<string | null> {
  const coverage = await getCostCoverage(organizationId);
  let first: string | null = null;
  // ISO days sort lexicographically, so plain `<` is the right comparison.
  for (const { firstDay } of coverage.values()) {
    if (firstDay && (first === null || firstDay < first)) first = firstDay;
  }
  return first;
}

/**
 * Judge one day for one key. Spikes take precedence: a key with a baseline
 * worth measuring against is never also a "new source", and running them in a
 * fixed order is what makes each (day, key) exactly one kind of finding rather
 * than two rows racing for the same unique index.
 *
 * `coverageDays` is org-wide on purpose. It gates only the org's own first
 * days of collection; a key that genuinely appeared for the first time
 * yesterday within an established org still fires, which is the whole feature.
 */
function judgeDay(
  baseline: number[],
  actual: number,
  coverageDays: number,
  options: AnomalyDetectionOptions,
): Finding | null {
  const spike = detectSpike(baseline, actual, options);
  if (spike) {
    return { kind: "spike", actual: spike.actual, mean: spike.mean, threshold: spike.threshold };
  }
  const fresh = detectNewSpendSource(baseline, actual, coverageDays, options);
  if (fresh) {
    return {
      kind: "new_source",
      actual: fresh.actual,
      mean: fresh.mean,
      threshold: fresh.threshold,
    };
  }
  return null;
}

/**
 * Detect anomalies in one dimension's series across `days`, upsert them, and
 * return those still awaiting notification.
 *
 * One ClickHouse read covers every day in the window: the series needed to
 * judge the oldest day is a prefix of the series needed to judge the newest,
 * so widening the read by `EVALUATION_DAYS` costs nothing extra per pass.
 *
 * The upsert refreshes the stored amounts, because a day re-judged after more
 * of its data has landed is the more accurate reading of it. `notifiedAt` is
 * deliberately left alone — it is what makes an alert fire once.
 */
async function detectForDimension(
  organizationId: string,
  dimension: AnomalyDimension,
  days: string[],
  options: AnomalyDetectionOptions,
  firstCostDay: string | null,
): Promise<PendingAnomaly[]> {
  const newest = days[days.length - 1];
  const oldest = days[0];
  if (!newest || !oldest) return [];
  const from = addDays(oldest, -BASELINE_DAYS);
  const groups = await queryCosts(organizationId, {
    from,
    to: newest,
    binning: "daily",
    groupBy: dimension,
    filters: [],
  });

  const pending: PendingAnomaly[] = [];
  for (const group of groups) {
    if (!group.key) continue; // rows with no value for this dimension
    const byDay = new Map<string, number>();
    for (const p of group.points) byDay.set(p.bucket, (byDay.get(p.bucket) ?? 0) + p.amount);

    // The noise floor is denominated in USD; a series billed in a currency
    // with much smaller units needs it scaled or the floor stops filtering.
    const scoped = optionsForCurrency(group.currency, options);

    for (const day of days) {
      const baseline = fillDailySeries(byDay, addDays(day, -BASELINE_DAYS), addDays(day, -1));
      const actual = byDay.get(day) ?? 0;
      // Days of collection behind this day — 0 when the org has no cost data
      // at all, which can only mean there is nothing here worth judging.
      const coverageDays = firstCostDay === null ? 0 : daysBetween(firstCostDay, day);
      const finding = judgeDay(baseline, actual, coverageDays, scoped);
      if (!finding) continue;

      const amounts = {
        kind: finding.kind,
        actualAmountCents: Math.round(finding.actual * 100),
        baselineAmountCents: Math.round(finding.mean * 100),
        thresholdAmountCents: Math.round(finding.threshold * 100),
      };
      const [row] = await db
        .insert(costAnomalies)
        .values({
          id: randomUUID(),
          organizationId,
          day,
          dimension,
          dimensionKey: group.key,
          currency: group.currency,
          ...amounts,
        })
        .onConflictDoUpdate({
          target: [
            costAnomalies.organizationId,
            costAnomalies.day,
            costAnomalies.dimension,
            costAnomalies.dimensionKey,
            costAnomalies.currency,
          ],
          // `kind` is refreshed with the amounts for the same reason they are:
          // a day re-judged once more of its data has landed is the more
          // accurate reading of it, including which detection it belongs to.
          set: amounts,
        })
        .returning({ id: costAnomalies.id, notifiedAt: costAnomalies.notifiedAt });
      if (!row || row.notifiedAt) continue; // already delivered for this day

      pending.push({
        id: row.id,
        day,
        kind: finding.kind,
        dimension,
        dimensionKey: group.key,
        currency: group.currency,
        actual: finding.actual,
        mean: finding.mean,
        threshold: finding.threshold,
      });
    }
  }
  return pending;
}

/**
 * True when the same key was *notified* about within the cooldown window.
 * Stored-but-unnotified rows are ignored on purpose — see the module note.
 */
async function inCooldown(organizationId: string, anomaly: PendingAnomaly): Promise<boolean> {
  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(costAnomalies)
    .where(
      and(
        eq(costAnomalies.organizationId, organizationId),
        eq(costAnomalies.dimension, anomaly.dimension),
        eq(costAnomalies.dimensionKey, anomaly.dimensionKey),
        eq(costAnomalies.currency, anomaly.currency),
        isNotNull(costAnomalies.notifiedAt),
        gte(costAnomalies.day, addDays(anomaly.day, -COOLDOWN_DAYS)),
        lt(costAnomalies.day, anomaly.day),
      ),
    );
  return Number(rows[0]?.n ?? 0) > 0;
}

/**
 * Evaluate an org's recent spend against its trailing baseline, per provider
 * and per service, and notify anomalies that have not been delivered yet
 * through push/Slack/Teams. Errors are logged, never thrown — anomaly
 * evaluation must not break the poller's cost pass. Amounts compare in
 * currency units; the stored rows are cents, matching the budget tables.
 *
 * Rate-limited per org (`MIN_EVAL_INTERVAL_MS`); pass `force` to bypass that,
 * which is what an on-demand caller or a test wants.
 */
export async function detectCostAnomaliesForOrg(
  organizationId: string,
  now = new Date(),
  options?: AnomalyDetectionOptions,
  force = false,
): Promise<void> {
  const at = now.getTime();
  const last = lastEvaluatedAt.get(organizationId);
  if (!force && last !== undefined && at - last < MIN_EVAL_INTERVAL_MS) return;
  lastEvaluatedAt.set(organizationId, at);

  // Thresholds are per-org (`org_cost_anomaly_settings`), read once per pass
  // rather than per key: an org that has never opened the form gets the
  // shipped defaults. An explicit `options` argument wins, which is what a
  // test or a one-off caller wants.
  const tuning = options ?? (await anomalyOptionsForOrg(organizationId));

  // Yesterday is the latest day worth judging — today is still accruing and
  // would read as a dip, never a spike — back through the restatement window,
  // oldest first so a day that only now looks anomalous alerts before the
  // fresher days that may share its cooldown key.
  const newest = addDays(isoDay(now), -1);
  const days = Array.from({ length: EVALUATION_DAYS }, (_, i) =>
    addDays(newest, -(EVALUATION_DAYS - 1 - i)),
  );

  // How far back the org's cost data goes, read once per pass and shared by
  // both dimensions. A failure here degrades rather than aborts: spikes still
  // detect, and only new-source findings — the ones that need this fact — go
  // quiet for the pass.
  let firstCostDay: string | null = null;
  try {
    firstCostDay = await firstCostDayForOrg(organizationId);
  } catch (err) {
    console.error(`[anomaly-eval] cost coverage read failed for org ${organizationId}:`, err);
  }

  for (const dimension of DIMENSIONS) {
    let pending: PendingAnomaly[];
    try {
      pending = await detectForDimension(organizationId, dimension, days, tuning, firstCostDay);
    } catch (err) {
      console.error(`[anomaly-eval] ${dimension} detection failed for org ${organizationId}:`, err);
      continue;
    }

    for (const anomaly of pending) {
      try {
        if (await inCooldown(organizationId, anomaly)) continue;

        const label = dimension === "provider" ? "provider" : "service";
        // A new source has no baseline to compare against, so saying it "cost
        // $5,000 against a $0/day baseline" buries the lede. Lead with the
        // fact that the thing is new.
        const title =
          anomaly.kind === "new_source"
            ? `New spend source: ${anomaly.dimensionKey}`
            : `Cost anomaly: ${anomaly.dimensionKey}`;
        const body =
          anomaly.kind === "new_source"
            ? `infrawrench new spend source: ${label} "${anomaly.dimensionKey}" cost ` +
              `${formatAmount(anomaly.actual, anomaly.currency)} on ${anomaly.day}, with no ` +
              `spend at all in the prior ${BASELINE_DAYS} days`
            : `infrawrench spend anomaly: ${label} "${anomaly.dimensionKey}" cost ` +
              `${formatAmount(anomaly.actual, anomaly.currency)} on ${anomaly.day}, against a ` +
              `${formatAmount(anomaly.mean, anomaly.currency)}/day baseline over the prior ${BASELINE_DAYS} days`;
        const context = `${anomaly.day} · ${label}${anomaly.kind === "new_source" ? " · new" : ""}`;

        const pushed = await sendPushToOrg(organizationId, "anomalyAlerts", {
          title,
          body,
          data: {
            type: "cost_anomaly",
            orgId: organizationId,
            day: anomaly.day,
            kind: anomaly.kind,
            dimension,
            dimensionKey: anomaly.dimensionKey,
          },
        });
        const url = costsUrl(organizationId);
        const slacked = await sendSlackToOrg(organizationId, "anomalyAlerts", {
          title,
          body,
          context,
          ...(url ? { url } : {}),
        });
        const teamed = await sendMsTeamsToOrg(organizationId, "anomalyAlerts", {
          title,
          body,
          context,
          ...(url ? { url } : {}),
        });
        if (pushed.succeeded > 0 || slacked.succeeded > 0 || teamed.succeeded > 0) {
          await db
            .update(costAnomalies)
            .set({ notifiedAt: new Date() })
            .where(eq(costAnomalies.id, anomaly.id));
        }
      } catch (err) {
        console.error(`[anomaly-eval] notify failed for anomaly ${anomaly.id}:`, err);
      }
    }
  }
}
