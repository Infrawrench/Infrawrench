/**
 * Notes on fired budget alerts.
 *
 * A budget alert says *that* spend crossed a line; the person who reads it
 * usually knows *why* within minutes ("the Q3 load test, ends Friday") and
 * that knowledge used to die in a chat reply. A note keeps it: it is stored on
 * the alert's own row, drawn on every cost chart as an org-wide annotation at
 * the day the alert fired, and posted after the alert wherever the alert went
 * (a reply in each Slack message's thread; a follow-up to the same Teams
 * webhooks, since incoming webhooks cannot thread).
 *
 * This is the anomaly-acknowledgement arrangement applied to a different
 * finding, with the same four rules (see `server-core/cost/anomaly-acknowledge`):
 * the note is the act and the annotation the artifact; a later note rewords
 * the annotation it already made instead of filing a second marker; a deleted
 * marker stays deleted; and nothing here touches evaluation. A noted alert is
 * explained, not silenced, and the thresholds keep firing as they always did.
 */
import { costAnnotationInputError, type CostAnnotationInput } from "./cost-annotations";
import { formatMoney, type BudgetWithStatus } from "./costs";
import type { CloudFetch } from "./fetch";

/** The note on one fired alert. */
export interface BudgetAlertNote {
  text: string;
  /** When the note as it now reads was written: restamped by a rewrite. */
  notedAt: string;
  notedByUserId: string | null;
  /** The author's display name (or email), resolved by the API for the byline. */
  notedByName: string | null;
  /**
   * The annotation drawn on the charts, or null once that marker was deleted.
   * Null here never means "no note": the note lives on the alert regardless.
   */
  annotationId: string | null;
}

/** One firing of a budget threshold, as `GET /budgets/:id/events` lists it. */
export interface BudgetAlertEvent {
  id: string;
  /** `YYYY-MM` (UTC) the crossing was observed in. */
  month: string;
  thresholdType: "actual" | "forecast";
  thresholdPercent: number;
  actualAmountCents: number;
  forecastAmountCents: number | null;
  triggeredAt: string;
  /**
   * The period's inclusive bounds; null on events from before budget periods
   * were configurable (those are calendar months: see `month`). Optional for
   * a client a release ahead of its server.
   */
  periodStart?: string | null | undefined;
  periodEnd?: string | null | undefined;
  /** A usage budget's figures at the crossing (the cents fields are 0). */
  actualUsage?: number | null | undefined;
  forecastUsage?: number | null | undefined;
  note: BudgetAlertNote | null;
}

/**
 * What writing a note returns: the firing as it now reads, and how many chat
 * destinations the follow-up reached (Slack threads replied in, Teams webhooks
 * posted to). Zero and zero is normal for an alert that went only to phones.
 */
export interface BudgetAlertNoteResult extends BudgetAlertEvent {
  followUp: { slack: number; msTeams: number };
}

/** The firing a note's annotation is dated from: only `triggeredAt` matters. */
type NotedEvent = Pick<BudgetAlertEvent, "triggeredAt">;

/** The UTC day an alert fired: the date its note's chart marker sits on. */
export function budgetAlertDay(event: NotedEvent): string {
  return event.triggeredAt.slice(0, 10);
}

/**
 * The annotation a note creates: a moment on the day the alert fired, and
 * org-wide, because "we ran a load test" explains that day's spend on every
 * chart, not only on one report somebody happened to be looking at.
 */
export function budgetAlertNoteAnnotationInput(
  event: NotedEvent,
  note: string,
): CostAnnotationInput {
  return { startDate: budgetAlertDay(event), endDate: null, text: note.trim(), costReportId: null };
}

/**
 * Why this note cannot be saved, or null when it can. The annotation's own
 * rule against the note that would be created, so the composer refuses
 * exactly what the API refuses, ceiling included.
 */
export function budgetAlertNoteError(event: NotedEvent, note: string): string | null {
  return costAnnotationInputError(budgetAlertNoteAnnotationInput(event, note));
}

/**
 * What the composer opens with: the fact the alert stated, so the note reads
 * on its own as a chart marker, where the reader has no alert beside it.
 */
export function budgetAlertNotePrefill(
  budgetName: string,
  event: Pick<BudgetAlertEvent, "thresholdType" | "thresholdPercent">,
): string {
  const kind = event.thresholdType === "forecast" ? "forecast " : "";
  return `Budget "${budgetName}" ${kind}at ${event.thresholdPercent}%: `;
}

/**
 * The follow-up posted after the alert: who explained it, then what they said.
 * Plain text, because it goes to a Slack thread reply and a Teams card body.
 */
export function budgetAlertNoteFollowUpText(
  budgetName: string,
  event: Pick<BudgetAlertEvent, "thresholdType" | "thresholdPercent" | "month">,
  note: string,
  author: string | null,
): string {
  const who = author ?? "Someone";
  const kind = event.thresholdType === "forecast" ? "forecast " : "";
  return `${who} explained the ${kind}${event.thresholdPercent}% alert on budget "${budgetName}" (${event.month}): ${note.trim()}`;
}

/** `"Actual 80% · $8,120"`: one firing, compactly, for lists. */
export function describeBudgetAlertEvent(
  event: Pick<
    BudgetAlertEvent,
    "thresholdType" | "thresholdPercent" | "actualAmountCents" | "forecastAmountCents"
  >,
  currency: string,
): string {
  const kind = event.thresholdType === "forecast" ? "Forecast" : "Actual";
  const cents =
    event.thresholdType === "forecast"
      ? (event.forecastAmountCents ?? event.actualAmountCents)
      : event.actualAmountCents;
  return `${kind} ${event.thresholdPercent}% · ${formatMoney(cents / 100, currency)}`;
}

/* ------------------------------------------------------------------ *
 * Transport: GET /budgets/:id/events, POST /budgets/:id/events/:eventId/note.
 * ------------------------------------------------------------------ */

/** A budget's alert history, newest first (the last 100 firings). */
export async function listBudgetAlertEvents(
  api: CloudFetch,
  orgId: string,
  budgetId: string,
): Promise<BudgetAlertEvent[]> {
  return (
    (await api.org<BudgetAlertEvent[]>(orgId, `/budgets/${encodeURIComponent(budgetId)}/events`)) ??
    []
  );
}

/**
 * Write (or rewrite) the note on one firing. The server dates the chart
 * marker from the event and posts the follow-up to wherever the alert went;
 * a rewrite rewords the marker it already made rather than adding a second.
 */
export async function annotateBudgetAlert(
  api: CloudFetch,
  orgId: string,
  budgetId: string,
  eventId: string,
  note: string,
): Promise<BudgetAlertNoteResult | null> {
  return api.org<BudgetAlertNoteResult>(
    orgId,
    `/budgets/${encodeURIComponent(budgetId)}/events/${encodeURIComponent(eventId)}/note`,
    { method: "POST", body: JSON.stringify({ note }) },
  );
}

/** The notes on a budget's current-month firings, newest first. */
export function currentMonthBudgetNotes(
  budget: Pick<BudgetWithStatus, "currentMonthEvents">,
): Array<{ eventId: string; thresholdPercent: number; note: BudgetAlertNote }> {
  return budget.currentMonthEvents.flatMap((e) =>
    e.note ? [{ eventId: e.id, thresholdPercent: e.thresholdPercent, note: e.note }] : [],
  );
}
