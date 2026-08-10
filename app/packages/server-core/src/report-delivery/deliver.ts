/**
 * Building and delivering one scheduled cost-report delivery.
 *
 * Gathering mirrors `digest/weekly.ts`: the report's saved config is resolved
 * to a window with the shared `costQueryForConfig`, the spend is read from
 * ClickHouse, converted into the org's display currency at its stated rates
 * (the same `convertGroups` path the digest and the graph API use), and the
 * pure composition in `./compose.ts` turns it into the message every
 * transport renders.
 *
 * Delivery is direct to the schedule's own destinations — Slack channel rows,
 * Teams webhook rows, an email list — **not** through `alerts/route.ts`. That
 * is deliberate and load-bearing: this is the digest pattern (a scheduled
 * summary sent where its schedule says), not an alert (routed by kind).
 *
 * Like every notifier here, nothing throws into the poller: outcomes are
 * recorded on the row so the report page can show them, logged with the
 * `[report-delivery]` prefix, and the tick carries on.
 */
import { and, eq, isNull } from "drizzle-orm";
import {
  COST_DIMENSION_LABELS,
  costQueryForConfig,
  type CostDimensionId,
  type CostFilter,
  type CostGraphConfig,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import { accounts, costReports, organizations, reportNotifications } from "../db/schema";
import { queryCosts, type CostSeriesGroup } from "../clickhouse/cost-readers";
import { isClickHouseConfigured } from "../clickhouse/client";
import { convertGroups, mergeConvertedGroups } from "../cost/currency-convert";
import { getOrgCurrencySettings, listOrgExchangeRates } from "../cost/currency-settings";
import { loadPlugins } from "../plugin-loader";
import { isEmailConfigured, sendEmails, type EmailMessage } from "../email";
import { sendSlackToChannels } from "../slack";
import { sendMsTeamsToWebhooks } from "../msteams";
import {
  classifyReportDelivery,
  formatReportEmailHtml,
  formatReportEmailText,
  formatReportSlackBody,
  formatReportTeamsBody,
  nextReportDeliveryAttemptAt,
  nextReportSendAt,
  reportDeliveryTitle,
  MAX_DELIVERY_GROUPS,
  MAX_REPORT_DELIVERY_ATTEMPTS,
  type ReportDeliveryData,
  type ReportDeliveryGroup,
  type ReportDeliveryResult,
  type ReportDeliveryStatus,
  type ReportDeliveryTotal,
} from "./compose";
import {
  ReportNotificationInputError,
  getReportNotificationRow,
  scheduleOf,
  toReportNotificationView,
  type ReportNotificationRecord,
} from "./store";

function addDaysIso(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map((n) => Number.parseInt(n, 10));
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + days)).toISOString().slice(0, 10);
}

function daySpan(from: string, to: string): number {
  return (
    Math.round(
      (new Date(`${to}T00:00:00.000Z`).getTime() - new Date(`${from}T00:00:00.000Z`).getTime()) /
        86_400_000,
    ) + 1
  );
}

/** Deep link to the report's own page, for the message button. */
function reportUrl(organizationId: string, reportId: string): string | null {
  const base = process.env["APP_URL"];
  if (!base) return null;
  return `${base.replace(/\/$/, "")}/org/${organizationId}/cost-reports/${reportId}`;
}

function sumOf(g: CostSeriesGroup): number {
  return g.points.reduce((s, p) => s + p.amount, 0);
}

/** Group labels, resolved the light way: plugin names, account names, raw keys. */
async function labelForGroups(
  organizationId: string,
  groupBy: CostGraphConfig["groupBy"],
  keys: string[],
): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  try {
    if (groupBy === "provider") {
      const loaded = await loadPlugins();
      for (const l of loaded) labels.set(l.plugin.manifest.id, l.plugin.manifest.displayName);
    } else if (groupBy === "account" && keys.length > 0) {
      const rows = await db
        .select({ id: accounts.id, displayName: accounts.displayName })
        .from(accounts)
        .where(eq(accounts.organizationId, organizationId));
      for (const row of rows) labels.set(row.id, row.displayName);
    }
  } catch (err) {
    // A label lookup failure costs the message its pretty names, not the send.
    console.error(`[report-delivery] label resolution failed for org ${organizationId}:`, err);
  }
  return labels;
}

/**
 * Run the report and compose the delivery data.
 *
 * Two ClickHouse reads (the report's window and the same span shifted back one
 * full period — the comparison is always included in a delivery, whatever the
 * saved config says, because "vs the period before" is what makes a recurring
 * number readable) plus the org's currency settings. Conversion follows the
 * org's configured display currency, exactly like the digest: a scheduled
 * delivery is the org's own report, so there is no per-request opt-in to ask.
 */
export async function buildReportDelivery(
  organizationId: string,
  report: { id: string; name: string; description: string | null; config: CostGraphConfig },
  now = new Date(),
): Promise<ReportDeliveryData> {
  if (!isClickHouseConfigured()) {
    throw new Error("Cost storage is not configured on this deployment");
  }
  const config = report.config;
  const request = costQueryForConfig(config, now);
  const filters: CostFilter[] = config.filters ?? [];
  const span = daySpan(request.from, request.to);

  const base = {
    binning: "daily" as const,
    groupBy: config.groupBy,
    filters,
    ...(config.groupByTagKey ? { groupByTagKey: config.groupByTagKey } : {}),
    ...(config.costBasis ? { costBasis: config.costBasis } : {}),
  };

  const [rawCurrent, rawPrevious, currencySettings] = await Promise.all([
    queryCosts(organizationId, { from: request.from, to: request.to, ...base }),
    queryCosts(organizationId, {
      from: addDaysIso(request.from, -span),
      to: addDaysIso(request.to, -span),
      ...base,
    }),
    getOrgCurrencySettings(organizationId).catch(() => ({
      displayCurrency: null as string | null,
    })),
  ]);

  const displayCurrency = currencySettings.displayCurrency;
  const rates = displayCurrency ? await listOrgExchangeRates(organizationId) : [];
  const currentConverted = convertGroups(rawCurrent, displayCurrency, rates);
  const previousConverted = convertGroups(rawPrevious, displayCurrency, rates);
  const current = mergeConvertedGroups(currentConverted.groups);
  const previous = mergeConvertedGroups(previousConverted.groups);

  // One total per currency, and the previous period's beside it when that
  // currency existed then. A currency that only appears in one period still
  // shows — dropping it would understate one side of the comparison.
  const byCurrency = new Map<string, { current: number; previous: number | null }>();
  for (const g of current) {
    const entry = byCurrency.get(g.currency) ?? { current: 0, previous: null };
    entry.current += sumOf(g);
    byCurrency.set(g.currency, entry);
  }
  for (const g of previous) {
    const entry = byCurrency.get(g.currency) ?? { current: 0, previous: null };
    entry.previous = (entry.previous ?? 0) + sumOf(g);
    byCurrency.set(g.currency, entry);
  }
  const totals: ReportDeliveryTotal[] = [...byCurrency.entries()]
    .filter(([, v]) => v.current !== 0 || (v.previous ?? 0) !== 0)
    .map(([currency, v]) => ({
      currency,
      currentAmount: v.current,
      previousAmount: v.previous,
    }))
    .sort((a, b) => b.currentAmount - a.currentAmount);

  // Top groups in the primary currency, like the digest's movers.
  const primaryCurrency = totals[0]?.currency ?? null;
  let topGroups: ReportDeliveryGroup[] = [];
  if (primaryCurrency && config.groupBy !== "none") {
    const ranked = current
      .filter((g) => g.currency === primaryCurrency && g.key !== "")
      .map((g) => ({ key: g.key, currency: g.currency, amount: sumOf(g) }))
      .filter((g) => g.amount !== 0)
      .sort((a, b) => b.amount - a.amount)
      .slice(0, Math.min(config.topN ?? MAX_DELIVERY_GROUPS, MAX_DELIVERY_GROUPS));
    const labels = await labelForGroups(
      organizationId,
      config.groupBy,
      ranked.map((g) => g.key),
    );
    topGroups = ranked.map((g) => ({
      label: labels.get(g.key) ?? g.key,
      currency: g.currency,
      amount: g.amount,
    }));
  }

  const groupLabel =
    config.groupBy === "none"
      ? null
      : config.groupBy === "tag"
        ? (config.groupByTagKey ?? "tag")
        : (
            COST_DIMENSION_LABELS[config.groupBy as CostDimensionId] ?? config.groupBy
          ).toLowerCase();

  return {
    reportName: report.name,
    description: report.description,
    from: request.from,
    to: request.to,
    groupLabel,
    totals,
    topGroups,
    ...(currentConverted.conversion ? { conversion: currentConverted.conversion } : {}),
    url: reportUrl(organizationId, report.id),
  };
}

/**
 * Send a composed delivery to one schedule's destinations. Never throws — all
 * three transports already swallow and log; this only counts.
 */
export async function deliverReportNotification(
  organizationId: string,
  row: {
    id: string;
    slackChannelIds: unknown;
    teamsWebhookIds: unknown;
    emailRecipients: unknown;
  },
  data: ReportDeliveryData,
  origin = "scheduled",
): Promise<ReportDeliveryResult> {
  const ids = (raw: unknown): string[] =>
    Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
  const slackIds = ids(row.slackChannelIds);
  const teamsIds = ids(row.teamsWebhookIds);
  const recipients = ids(row.emailRecipients);

  const [org] = await db
    .select({ displayName: organizations.displayName })
    .from(organizations)
    .where(eq(organizations.id, organizationId));

  const title = reportDeliveryTitle(data);
  const context = org ? `${org.displayName} · Infrawrench cost report` : undefined;

  // Built even when mail is unconfigured, on purpose: `sendEmails` logs the
  // "you have recipients but no mail provider" line, and short-circuiting here
  // would make that failure silent — the exact failure mode this feature is
  // designed not to have.
  const text = recipients.length > 0 ? formatReportEmailText(data) : "";
  const html = recipients.length > 0 ? formatReportEmailHtml(data) : "";
  const emails: EmailMessage[] = recipients.map((to) => ({
    to,
    subject: title,
    text,
    html,
    traceKey: `report-notification:${row.id}:${data.to}:${origin}:${to}`,
  }));

  const [slack, teams, email] = await Promise.all([
    sendSlackToChannels(organizationId, slackIds, {
      title,
      body: formatReportSlackBody(data),
      ...(data.url ? { url: data.url } : {}),
      ...(context ? { context } : {}),
    }),
    sendMsTeamsToWebhooks(organizationId, teamsIds, {
      title,
      body: formatReportTeamsBody(data),
      ...(data.url ? { url: data.url } : {}),
      ...(context ? { context } : {}),
    }),
    sendEmails(emails, `report notification ${row.id}`),
  ]);

  // Addresses that could not even be attempted (mail unconfigured) still count
  // as attempted-and-failed here: the schedule names them as destinations, and
  // "your emails silently went nowhere" must show up as a failure, not as a
  // clean success on the other transports.
  const emailAttempted = recipients.length;
  return {
    attempted: slack.attempted + teams.attempted + emailAttempted,
    succeeded: slack.succeeded + teams.succeeded + email.succeeded,
    slack: { attempted: slack.attempted, succeeded: slack.succeeded },
    teams: { attempted: teams.attempted, succeeded: teams.succeeded },
    email: { attempted: emailAttempted, succeeded: email.succeeded },
  };
}

/** Record what an attempt did. Never throws — bookkeeping must not mask the send. */
async function recordAttempt(
  row: ReportNotificationRecord,
  now: Date,
  outcome: { status: ReportDeliveryStatus; error: string | null; retryable: boolean },
): Promise<void> {
  const attemptCount = row.attemptCount + 1;
  const spent = attemptCount >= MAX_REPORT_DELIVERY_ATTEMPTS;
  // The one lease column carries both meanings: a retryable failure with
  // attempts left re-arms `next_send_at` at the digest's backoff, anything
  // else re-arms it at the schedule's true next fire.
  const retryAt = outcome.retryable ? nextReportDeliveryAttemptAt(now, attemptCount) : null;
  const nextSendAt = row.enabled ? (retryAt ?? nextReportSendAt(scheduleOf(row), now)) : null;
  try {
    await db
      .update(reportNotifications)
      .set({
        lastStatus: outcome.status,
        lastError: outcome.error,
        lastAttemptAt: now,
        // `lastSentAt` means "a report actually reached someone".
        ...(outcome.status === "succeeded" || outcome.status === "partial"
          ? { lastSentAt: now }
          : {}),
        attemptCount: outcome.retryable && !spent ? attemptCount : 0,
        nextSendAt,
        updatedAt: now,
      })
      .where(eq(reportNotifications.id, row.id));
  } catch (err) {
    console.error(`[report-delivery] ${row.id}: failed to record attempt outcome:`, err);
  }
}

/** The live report a schedule delivers, or null when it is gone. */
async function loadLiveReport(
  organizationId: string,
  reportId: string,
): Promise<{
  id: string;
  name: string;
  description: string | null;
  config: CostGraphConfig;
} | null> {
  const [row] = await db
    .select({
      id: costReports.id,
      name: costReports.name,
      description: costReports.description,
      config: costReports.config,
    })
    .from(costReports)
    .where(
      and(
        eq(costReports.id, reportId),
        eq(costReports.organizationId, organizationId),
        isNull(costReports.deletedAt),
      ),
    )
    .limit(1);
  if (!row) return null;
  return { ...row, config: row.config as CostGraphConfig };
}

/** Build, deliver, and record one claimed schedule. Never throws. */
export async function runReportNotification(
  row: ReportNotificationRecord,
  now = new Date(),
): Promise<void> {
  const report = await loadLiveReport(row.organizationId, row.costReportId);
  if (!report) {
    // The report was soft-deleted under the schedule (the hard-delete case is
    // the FK cascade). Park the row instead of retrying forever.
    try {
      await db
        .update(reportNotifications)
        .set({
          enabled: false,
          nextSendAt: null,
          lastStatus: "failed",
          lastError: "The report this schedule delivers was deleted.",
          updatedAt: now,
        })
        .where(eq(reportNotifications.id, row.id));
    } catch (err) {
      console.error(`[report-delivery] ${row.id}: failed to park orphaned schedule:`, err);
    }
    return;
  }

  try {
    const data = await buildReportDelivery(row.organizationId, report, now);
    const result = await deliverReportNotification(row.organizationId, row, data);
    const outcome = classifyReportDelivery(result);
    await recordAttempt(row, now, outcome);
    const line = `[report-delivery] ${row.id} (report "${report.name}") attempt ${row.attemptCount + 1}/${MAX_REPORT_DELIVERY_ATTEMPTS}: ${outcome.status} — slack ${result.slack.succeeded}/${result.slack.attempted}, teams ${result.teams.succeeded}/${result.teams.attempted}, email ${result.email.succeeded}/${result.email.attempted}`;
    if (outcome.status === "succeeded") console.log(line);
    else console.warn(`${line}${outcome.error ? ` — ${outcome.error}` : ""}`);
  } catch (err) {
    // A build failure (ClickHouse down, a bad config) is as retryable as a
    // total delivery failure, and just as invisible if only logged.
    const message = err instanceof Error ? err.message : String(err);
    await recordAttempt(row, now, {
      status: "failed",
      error: `Could not run the report: ${message}`,
      retryable: true,
    });
    console.error(`[report-delivery] ${row.id} (report ${row.costReportId}) failed:`, err);
  }
}

/**
 * Run one schedule immediately, ignoring `next_send_at` and `enabled` — backs
 * the report page's "Send now" and the CLI's `reports send`. Unlike the
 * scheduled path this throws when nothing could be delivered, because the
 * caller is a person who needs to see why. A successful manual send also
 * clears parked failure state — it is the documented recovery for a partial
 * delivery.
 */
export async function sendReportNotificationNow(
  organizationId: string,
  reportId: string,
  notificationId: string,
  now = new Date(),
): Promise<ReportDeliveryResult> {
  const row = await getReportNotificationRow(organizationId, reportId, notificationId);
  const report = await loadLiveReport(organizationId, reportId);
  if (!report) throw new ReportNotificationInputError("Report not found", 404);

  const data = await buildReportDelivery(organizationId, report, now);
  const result = await deliverReportNotification(
    organizationId,
    row,
    data,
    `manual-${now.toISOString()}`,
  );
  const hasEmailOnly =
    result.slack.attempted === 0 && result.teams.attempted === 0 && result.email.attempted > 0;
  if (result.attempted === 0) {
    throw new ReportNotificationInputError(
      "This schedule has no live destinations. Pick a Slack channel or Teams webhook, or add an email recipient.",
    );
  }
  const outcome = classifyReportDelivery(result);
  // Recorded so a manual recovery clears the parked failure the UI shows; a
  // manual send never arms the automatic retry, and never touches the
  // schedule's own next fire time.
  try {
    await db
      .update(reportNotifications)
      .set({
        lastStatus: outcome.status,
        lastError: outcome.error,
        lastAttemptAt: now,
        attemptCount: 0,
        ...(outcome.status === "succeeded" || outcome.status === "partial"
          ? { lastSentAt: now }
          : {}),
        updatedAt: now,
      })
      .where(eq(reportNotifications.id, row.id));
  } catch (err) {
    console.error(`[report-delivery] ${row.id}: failed to record manual send:`, err);
  }
  if (result.succeeded === 0) {
    throw new ReportNotificationInputError(
      hasEmailOnly && !isEmailConfigured()
        ? "This schedule only has email recipients and this deployment has no mail provider configured (MAILGUN_API_KEY, MAILGUN_DOMAIN, EMAIL_FROM)."
        : `The report could not be delivered to any of its ${result.attempted} destination(s). Check the Slack, Teams and email settings.`,
    );
  }
  return result;
}

export { toReportNotificationView };
