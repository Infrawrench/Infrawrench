/**
 * Commitment alert evaluation — the impure half of the two commitment
 * detectors. Runs from the poller after each successful cost collection for an
 * org, the same trigger point as budget, anomaly and change-alert evaluation,
 * because everything it reads (the collected inventory, the cost rows behind
 * utilization) only changes when collection runs.
 *
 * The judgements live next door in `expiry-detect.ts` and `idle-detect.ts` —
 * both pure and exhaustively tested. This module reads the inventory and the
 * ClickHouse aggregates, persists what fired, and notifies through the alert
 * routing layer under the `commitmentExpiryAlerts` and `commitmentIdleAlerts`
 * triggers. **Nothing here talks to a transport**: routing rules, quiet hours
 * and escalation apply exactly as they do to budgets and anomalies, which is
 * the whole reason `routeAlert` exists.
 *
 * ## One pass, two detectors
 *
 * They share every read — the plugin manifests, the account list, the
 * inventory, the days-with-data set, the delivered totals — so they share a
 * pass. Splitting them into two entry points would double four queries to
 * answer two questions about the same rows.
 *
 * ## Fire-once
 *
 * Both use the `budget_alert_events` protocol: insert with
 * `onConflictDoNothing() … RETURNING`, and only a fresh insert notifies. The
 * period differs because the questions differ — a horizon for expiry (60/30/7
 * each fire once per term), a calendar month for idleness (a standing
 * condition restated monthly, not daily). See the two table comments in
 * `db/commitment-schema.ts`.
 *
 * ## Attribution gating
 *
 * Derived utilization only uses accounts whose plugin declares
 * `costs.chargeTypes`, exactly as `feed.ts` does: for anyone else every cost
 * row reads as plain uncovered usage, delivered reads 0, and a healthy plan
 * would be alerted as idle — the failure that gets a working commitment
 * cancelled. Expiry does *not* need attribution (a term end is a term end), so
 * an unattributed account still gets its expiry warnings; only the money
 * estimate inside them goes unstated.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";

import { db } from "../db/client";
import {
  accountCommitments,
  accounts,
  commitmentExpiryEvents,
  commitmentIdleEvents,
} from "../db/schema";
import { loadPlugins } from "../plugin-loader";
import { getAccountDataDays, getCommitmentDeliveredTotals } from "../clickhouse/commitment-readers";
import { alertReached, routeAlert } from "../alerts/route";
import { usdFloorIn } from "../cost/anomaly-detect";
import { getOrgEfficiencySettings } from "../cost/efficiency-settings";
import { computeCommitmentUtilization } from "./utilization";
import {
  detectCommitmentExpiries,
  type CommitmentExpiryFinding,
  type ExpiringCommitmentInput,
} from "./expiry-detect";
import {
  detectIdleCommitments,
  type IdleCommitmentFinding,
  type IdleCommitmentInput,
} from "./idle-detect";

/**
 * Least time between full evaluations of one org. Same shape and reasoning as
 * the anomaly and change-alert gates: evaluation is invoked once per collected
 * account, the ClickHouse reads are the expensive half, and correctness never
 * rests on this — the events tables' unique indexes do that.
 */
const MIN_EVAL_INTERVAL_MS = 60 * 60 * 1000;

/** orgId → epoch ms of the last evaluation. Best-effort, per process. */
const lastEvaluatedAt = new Map<string, number>();

/**
 * How far back an already-expired commitment may have lapsed and still be
 * worth one alert.
 *
 * 90 days. Long enough that an org connecting an account mid-quarter still
 * hears about the reservation that quietly ended last month — the case the
 * horizon warnings structurally cannot catch — and short enough that
 * connecting an account with years of dead inventory produces one pass of
 * recent news rather than an archive. Not a user knob: it bounds a one-time
 * catch-up, not an ongoing preference.
 */
const EXPIRED_LOOKBACK_DAYS = 90;

const DAY_MS = 86_400_000;

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function daysBack(day: string, n: number): string {
  return new Date(new Date(`${day}T00:00:00Z`).valueOf() - n * DAY_MS).toISOString().slice(0, 10);
}

/** Deep link to the costs panel, where the commitments section lives. */
function costsUrl(organizationId: string): string | null {
  const base = process.env["APP_URL"];
  if (!base) return null;
  return `${base.replace(/\/$/, "")}/org/${organizationId}/costs`;
}

function formatAmount(amount: number, currency: string | null): string {
  const code = currency ?? "USD";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: code,
      maximumFractionDigits: Math.abs(amount) < 100 ? 2 : 0,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${code}`;
  }
}

/** "2,000 vCPU, 8,000 GB RAM" — for a commitment that buys units, not money. */
function formatUnits(units: Array<{ unit: string; amount: number }> | null): string | null {
  if (!units || units.length === 0) return null;
  return units.map((u) => `${u.amount.toLocaleString("en-US")} ${u.unit}`).join(", ");
}

interface CommitmentRow {
  accountId: string;
  accountName: string;
  pluginId: string;
  commitmentId: string;
  kind: string;
  description: string;
  scope: string | null;
  region: string | null;
  state: string;
  startDate: Date | null;
  endDate: Date | null;
  currency: string | null;
  hourlyCommitmentAmount: number | null;
  unitCommitments: Array<{ unit: string; amount: number }> | null;
  attributed: boolean;
  deliveredAmount: number;
  daysWithData: Set<string>;
  measuredDays: number;
}

/**
 * Everything both detectors need, read once.
 *
 * Returns null when the org has nothing to judge — no commitment-capable
 * plugin, no such account, or no collected holdings — so the caller can stop
 * before touching ClickHouse.
 */
async function loadCommitmentContext(
  organizationId: string,
  window: { from: string; to: string },
): Promise<CommitmentRow[] | null> {
  const plugins = await loadPlugins();
  const commitmentPluginIds = new Set(
    plugins.filter((p) => p.plugin.manifest.commitments).map((p) => p.plugin.manifest.id),
  );
  if (commitmentPluginIds.size === 0) return null;
  const chargeTypePluginIds = new Set(
    plugins.filter((p) => p.plugin.manifest.costs?.chargeTypes).map((p) => p.plugin.manifest.id),
  );

  const orgAccounts = await db
    .select({ id: accounts.id, displayName: accounts.displayName, pluginId: accounts.pluginId })
    .from(accounts)
    .where(and(eq(accounts.organizationId, organizationId), isNull(accounts.deletedAt)));
  const relevant = orgAccounts.filter((a) => commitmentPluginIds.has(a.pluginId));
  if (relevant.length === 0) return null;
  const accountById = new Map(relevant.map((a) => [a.id, a]));

  const holdings = await db
    .select()
    .from(accountCommitments)
    .where(
      and(
        eq(accountCommitments.organizationId, organizationId),
        inArray(
          accountCommitments.accountId,
          relevant.map((a) => a.id),
        ),
      ),
    );
  if (holdings.length === 0) return null;

  const attributingAccountIds = relevant
    .filter((a) => chargeTypePluginIds.has(a.pluginId))
    .map((a) => a.id);

  const [dataDays, delivered] = await Promise.all([
    getAccountDataDays(organizationId, window.from, window.to, attributingAccountIds),
    getCommitmentDeliveredTotals(organizationId, window.from, window.to, attributingAccountIds),
  ]);

  // Summed across currencies, matching `feed.ts`: a single commitment bills in
  // one currency in practice, and splitting the total would understate a
  // holding whose provider restated it mid-term.
  const deliveredByKey = new Map<string, number>();
  for (const row of delivered) {
    const key = `${row.account_id}\x00${row.commitment_id}`;
    deliveredByKey.set(key, (deliveredByKey.get(key) ?? 0) + row.amount);
  }
  const attributing = new Set(attributingAccountIds);

  return holdings
    .filter((h) => accountById.has(h.accountId))
    .map((h) => {
      const account = accountById.get(h.accountId)!;
      const daysWithData = dataDays.get(h.accountId) ?? new Set<string>();
      const deliveredAmount = deliveredByKey.get(`${h.accountId}\x00${h.commitmentId}`) ?? 0;
      // Only for the expiry exposure estimate — idle-detect recomputes this
      // itself from the same inputs, because it needs every field and the
      // computation is pure and free.
      const measured = computeCommitmentUtilization({
        hourlyCommitmentAmount: h.hourlyCommitmentAmount,
        startDate: h.startDate?.toISOString() ?? null,
        endDate: h.endDate?.toISOString() ?? null,
        window,
        daysWithData,
        deliveredAmount,
      });
      return {
        accountId: h.accountId,
        accountName: account.displayName,
        pluginId: h.pluginId,
        commitmentId: h.commitmentId,
        kind: h.kind,
        description: h.description,
        scope: h.scope,
        region: h.region,
        state: h.state,
        startDate: h.startDate,
        endDate: h.endDate,
        currency: h.currency,
        hourlyCommitmentAmount: h.hourlyCommitmentAmount,
        unitCommitments: h.unitCommitments,
        attributed: attributing.has(h.accountId),
        deliveredAmount,
        daysWithData,
        measuredDays: measured.measuredDays,
      } satisfies CommitmentRow;
    });
}

/* ------------------------------------------------------------------ *
 * Expiry
 * ------------------------------------------------------------------ */

/** "in 30 days", "tomorrow", "today", "4 days ago". */
function whenPhrase(daysRemaining: number): string {
  if (daysRemaining === 0) return "today";
  if (daysRemaining === 1) return "tomorrow";
  if (daysRemaining > 1) return `in ${daysRemaining} days`;
  if (daysRemaining === -1) return "yesterday";
  return `${-daysRemaining} days ago`;
}

/**
 * The alert body. Three sentences by design — what it is, what it costs, what
 * to do — because these are read days after they arrive and a reader who has
 * to open the panel to find out whether it matters will not open the panel.
 */
function expiryBody(finding: CommitmentExpiryFinding, accountName: string): string {
  const subject = `"${finding.description}" on account "${accountName}"`;

  const money: string[] = [];
  if (finding.monthlyCommitmentAmount !== null) {
    money.push(
      `it commits about ${formatAmount(finding.monthlyCommitmentAmount, finding.currency)}/month`,
    );
  }
  const units = formatUnits(finding.unitCommitments);
  if (units) money.push(`it commits ${units}`);
  if (finding.monthlyCoveredUsageAmount !== null) {
    money.push(
      `and is currently covering at least ` +
        `${formatAmount(finding.monthlyCoveredUsageAmount, finding.currency)}/month of usage`,
    );
  }
  const moneyClause = money.length > 0 ? ` — ${money.join(", ")}` : "";

  if (finding.autoRenewing) {
    return (
      `infrawrench commitment renewal: ${subject} renews automatically ` +
      `${whenPhrase(finding.daysRemaining)} (${finding.termEndDay})${moneyClause}. ` +
      `It will not lapse, but it will keep billing at the then-current rate — ` +
      `cancel it now if the workload it was bought for has gone.`
    );
  }

  if (finding.horizonDays === 0) {
    return (
      `infrawrench commitment expired: ${subject} ended ` +
      `${whenPhrase(finding.daysRemaining)} (${finding.termEndDay}) and was not replaced` +
      `${moneyClause}. That usage is billing at on-demand rates now, which is more than the ` +
      `commitment charged for it. Buy a replacement, or confirm the workload is gone.`
    );
  }

  return (
    `infrawrench commitment expiry: ${subject} ends ` +
    `${whenPhrase(finding.daysRemaining)} (${finding.termEndDay})${moneyClause}. ` +
    `The usage it covers reverts to on-demand pricing the day it ends — at least that much, ` +
    `since on-demand is never cheaper than the committed rate. Renew it, resize it, or budget ` +
    `for the increase.`
  );
}

/**
 * The money a routing rule matches on, in cents.
 *
 * The *exposure* — what the covered usage will cost per month once it reverts
 * — rather than the commitment's own price, because "commitment expiries over
 * $5,000 → #finance" plainly means the size of the problem and not the size of
 * the invoice that is ending. Falls back to the committed amount when nothing
 * could be measured, and is simply absent when neither exists (a unit
 * commitment states no money, and an `amountCents` rule must not match an
 * alert that carries no amount — see `AlertFacts`).
 */
function expiryAmountCents(finding: CommitmentExpiryFinding): number | undefined {
  const amount = finding.monthlyCoveredUsageAmount ?? finding.monthlyCommitmentAmount;
  return amount === null ? undefined : Math.round(amount * 100);
}

async function evaluateExpiries(
  organizationId: string,
  rows: CommitmentRow[],
  settings: Awaited<ReturnType<typeof getOrgEfficiencySettings>>,
  today: string,
  url: string | null,
): Promise<void> {
  const byId = new Map(rows.map((r) => [`${r.accountId}\x00${r.commitmentId}`, r]));
  const inputs: ExpiringCommitmentInput[] = rows.map((r) => ({
    accountId: r.accountId,
    commitmentId: r.commitmentId,
    kind: r.kind,
    description: r.description,
    scope: r.scope,
    region: r.region,
    state: r.state,
    startDay: r.startDate ? isoDay(r.startDate) : null,
    endDay: r.endDate ? isoDay(r.endDate) : null,
    currency: r.currency,
    hourlyCommitmentAmount: r.hourlyCommitmentAmount,
    unitCommitments: r.unitCommitments,
    // Not reported by any collector today — `CommitmentRecord` in
    // `@infrawrench/plugin-base` carries no renewal flag. Successor detection
    // inside the detector covers the case that matters (a replacement already
    // bought); the day a collector reports Azure's `renew` or GCP's
    // `autoRenew`, this line is where it arrives.
    autoRenew: null,
    deliveredAmount: r.attributed ? r.deliveredAmount : null,
    measuredDays: r.measuredDays,
  }));

  const { findings } = detectCommitmentExpiries(
    inputs,
    {
      horizonDays: settings.commitmentExpiryHorizonDays,
      alertOnExpired: settings.commitmentExpiryAlertOnExpired,
      expiredLookbackDays: EXPIRED_LOOKBACK_DAYS,
    },
    today,
  );

  for (const finding of findings) {
    try {
      const row = byId.get(`${finding.accountId}\x00${finding.commitmentId}`);
      if (!row) continue;

      const [inserted] = await db
        .insert(commitmentExpiryEvents)
        .values({
          id: randomUUID(),
          organizationId,
          accountId: finding.accountId,
          commitmentId: finding.commitmentId,
          termEndDay: finding.termEndDay,
          horizonDays: finding.horizonDays,
          description: finding.description,
          currency: finding.currency,
          hourlyCommitmentAmount: finding.hourlyCommitmentAmount,
          onDemandMonthlyAmount: finding.monthlyCoveredUsageAmount,
        })
        .onConflictDoNothing()
        .returning({ id: commitmentExpiryEvents.id });
      // Already warned at this horizon for this term — the fire-once rule.
      if (!inserted) continue;

      const title = finding.autoRenewing
        ? `Commitment renews ${whenPhrase(finding.daysRemaining)}: ${finding.description}`
        : finding.horizonDays === 0
          ? `Commitment expired: ${finding.description}`
          : `Commitment expires ${whenPhrase(finding.daysRemaining)}: ${finding.description}`;

      const amountCents = expiryAmountCents(finding);
      const routed = await routeAlert({
        organizationId,
        trigger: "commitmentExpiryAlerts",
        // An auto-renewal is news, not a problem; an expiry that already
        // happened is the one nobody can plan around any more.
        severity: finding.autoRenewing ? "info" : "warning",
        title,
        body: expiryBody(finding, row.accountName),
        context: `${finding.termEndDay} · ${row.accountName} · ${finding.kind}`,
        url,
        pushData: {
          type: "commitment_expiry",
          orgId: organizationId,
          accountId: finding.accountId,
          commitmentId: finding.commitmentId,
          horizonDays: finding.horizonDays,
        },
        facts: {
          accountId: finding.accountId,
          pluginId: row.pluginId,
          key: finding.description,
          ...(amountCents !== undefined ? { amountCents } : {}),
          ...(finding.currency ? { currency: finding.currency } : {}),
        },
      });
      // `alertReached`, not `succeeded > 0`: a quiet-hours hold is a delivery
      // that has not happened yet, and the events row already deduplicates —
      // `notifiedAt` is bookkeeping for the UI, not a retry gate.
      if (alertReached(routed)) {
        await db
          .update(commitmentExpiryEvents)
          .set({ notifiedAt: new Date() })
          .where(eq(commitmentExpiryEvents.id, inserted.id));
      }
    } catch (err) {
      console.error(`[commitment-alerts] expiry notify failed for ${finding.commitmentId}:`, err);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Idle
 * ------------------------------------------------------------------ */

function idleBody(finding: IdleCommitmentFinding, accountName: string): string {
  const percent = Math.round(finding.utilization * 100);
  const missing =
    finding.missingDays > 0
      ? ` (${finding.measuredDays} of ${finding.measuredDays + finding.missingDays} days had cost data)`
      : "";
  return (
    `infrawrench idle commitment: "${finding.description}" on account "${accountName}" used ` +
    `${percent}% of its committed spend over ${finding.window.from}–${finding.window.to}${missing}. ` +
    `That is ${formatAmount(finding.wastedAmount, finding.currency)} of the ` +
    `${formatAmount(finding.obligationAmount, finding.currency)} committed buying nothing. ` +
    `Move matching workloads onto its scope, resize it at renewal, or sell it on the ` +
    `marketplace if the provider has one.`
  );
}

async function evaluateIdle(
  organizationId: string,
  rows: CommitmentRow[],
  settings: Awaited<ReturnType<typeof getOrgEfficiencySettings>>,
  window: { from: string; to: string },
  url: string | null,
): Promise<void> {
  const byId = new Map(rows.map((r) => [`${r.accountId}\x00${r.commitmentId}`, r]));
  const inputs: IdleCommitmentInput[] = rows.map((r) => ({
    accountId: r.accountId,
    commitmentId: r.commitmentId,
    description: r.description,
    kind: r.kind,
    state: r.state,
    currency: r.currency,
    hourlyCommitmentAmount: r.hourlyCommitmentAmount,
    startDate: r.startDate?.toISOString() ?? null,
    endDate: r.endDate?.toISOString() ?? null,
    attributed: r.attributed,
    daysWithData: r.daysWithData,
    deliveredAmount: r.deliveredAmount,
  }));

  // The waste floor is stored in USD cents and restated per commitment
  // currency, the same way the anomaly detector scales its noise floors — one
  // org-level "$50" means fifty dollars against a plan priced in KRW too.
  // Judged per currency group so the floor is never compared raw.
  const byCurrency = new Map<string, IdleCommitmentInput[]>();
  for (const input of inputs) {
    const currency = (input.currency ?? "USD").toUpperCase();
    const list = byCurrency.get(currency);
    if (list) list.push(input);
    else byCurrency.set(currency, [input]);
  }

  const periodKey = window.to.slice(0, 7);
  for (const [currency, group] of byCurrency) {
    const { findings } = detectIdleCommitments(group, window, {
      thresholdPercent: settings.commitmentIdleThresholdPercent,
      minMeasuredDays: settings.commitmentIdleMinMeasuredDays,
      minWasteAmount: usdFloorIn(currency, settings.commitmentIdleMinWasteCents / 100),
    });

    for (const finding of findings) {
      try {
        const row = byId.get(`${finding.accountId}\x00${finding.commitmentId}`);
        if (!row) continue;

        const [inserted] = await db
          .insert(commitmentIdleEvents)
          .values({
            id: randomUUID(),
            organizationId,
            accountId: finding.accountId,
            commitmentId: finding.commitmentId,
            periodKey,
            windowFrom: finding.window.from,
            windowTo: finding.window.to,
            description: finding.description,
            currency: finding.currency,
            utilization: finding.utilization,
            obligationAmount: finding.obligationAmount,
            deliveredAmount: finding.deliveredAmount,
            wastedAmount: finding.wastedAmount,
            measuredDays: finding.measuredDays,
            missingDays: finding.missingDays,
          })
          .onConflictDoNothing()
          .returning({ id: commitmentIdleEvents.id });
        // Already said this month — idleness is a standing condition, not a
        // daily event.
        if (!inserted) continue;

        const routed = await routeAlert({
          organizationId,
          trigger: "commitmentIdleAlerts",
          title: `Idle commitment (${Math.round(finding.utilization * 100)}%): ${finding.description}`,
          body: idleBody(finding, row.accountName),
          context: `${finding.window.from}–${finding.window.to} · ${row.accountName}`,
          url,
          pushData: {
            type: "commitment_idle",
            orgId: organizationId,
            accountId: finding.accountId,
            commitmentId: finding.commitmentId,
            periodKey,
          },
          // The wasted money, not the commitment's price: "idle commitments
          // over $1,000 → #finance" means the waste.
          facts: {
            accountId: finding.accountId,
            pluginId: row.pluginId,
            key: finding.description,
            amountCents: Math.round(finding.wastedAmount * 100),
            ...(finding.currency ? { currency: finding.currency } : {}),
          },
        });
        if (alertReached(routed)) {
          await db
            .update(commitmentIdleEvents)
            .set({ notifiedAt: new Date() })
            .where(eq(commitmentIdleEvents.id, inserted.id));
        }
      } catch (err) {
        console.error(`[commitment-alerts] idle notify failed for ${finding.commitmentId}:`, err);
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

/**
 * Evaluate an org's commitments for imminent expiry and for idleness, and
 * notify fresh firings through the alert routing layer.
 *
 * Errors are logged, never thrown — like every other evaluator on this path,
 * this must not break the poller's cost pass.
 *
 * Rate-limited per org (`MIN_EVAL_INTERVAL_MS`); pass `force` to bypass, which
 * is what a test or an on-demand caller wants.
 */
export async function evaluateCommitmentAlertsForOrg(
  organizationId: string,
  now = new Date(),
  force = false,
): Promise<void> {
  const at = now.getTime();
  const last = lastEvaluatedAt.get(organizationId);
  if (!force && last !== undefined && at - last < MIN_EVAL_INTERVAL_MS) return;
  lastEvaluatedAt.set(organizationId, at);

  let settings: Awaited<ReturnType<typeof getOrgEfficiencySettings>>;
  try {
    settings = await getOrgEfficiencySettings(organizationId);
  } catch (err) {
    console.error(`[commitment-alerts] settings read failed for org ${organizationId}:`, err);
    return;
  }
  if (!settings.commitmentExpiryEnabled && !settings.commitmentIdleEnabled) return;

  const today = isoDay(now);
  // The window both detectors measure over. Ends today rather than yesterday
  // because a partially-collected trailing day cannot distort a *ratio* the
  // way it distorts a total: it lands in the numerator and the denominator
  // together, and a day with no rows at all is excluded from both by the
  // days-with-data intersection. The idle threshold is judged over ≥14 days;
  // one soft day cannot move it past a bar.
  const window = {
    from: daysBack(today, settings.commitmentIdleWindowDays - 1),
    to: today,
  };

  let rows: CommitmentRow[] | null;
  try {
    rows = await loadCommitmentContext(organizationId, window);
  } catch (err) {
    console.error(`[commitment-alerts] inventory read failed for org ${organizationId}:`, err);
    return;
  }
  if (!rows || rows.length === 0) return;

  const url = costsUrl(organizationId);

  if (settings.commitmentExpiryEnabled) {
    try {
      await evaluateExpiries(organizationId, rows, settings, today, url);
    } catch (err) {
      console.error(`[commitment-alerts] expiry pass failed for org ${organizationId}:`, err);
    }
  }
  if (settings.commitmentIdleEnabled) {
    try {
      await evaluateIdle(organizationId, rows, settings, window, url);
    } catch (err) {
      console.error(`[commitment-alerts] idle pass failed for org ${organizationId}:`, err);
    }
  }
}
