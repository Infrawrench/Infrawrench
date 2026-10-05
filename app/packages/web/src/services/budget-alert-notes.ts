/**
 * Notes on fired budget alerts: where the rules in server-core
 * `cost/budget-alert-note.ts` meet the tables, and the read helpers every
 * budget surface uses to show a note with its byline.
 *
 * Writing a note is one transaction across two tables, for the reason
 * `acknowledgeCostAnomaly` gives: the note on the alert and the annotation on
 * the charts are written together or not at all, or a retry would mint a
 * second marker for the same firing. The chat follow-up runs after the commit
 * and never fails the request: by then the note exists.
 */
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";

import {
  budgetAlertNoteFollowUpText,
  type BudgetAlertEvent,
  type BudgetAlertNote,
  type BudgetAlertNoteResult,
} from "@infrawrench/client-core";
import {
  BudgetAlertNoteError,
  planBudgetAlertNote,
  postBudgetAlertNoteFollowUp,
} from "@infrawrench/server-core/cost/budget-alert-note";
import { orgAppUrl } from "@infrawrench/server-core/app-url";

import { db } from "../db/client";
import { budgetAlertEvents, budgets, costAnnotations, users } from "../db/schema";
import { visibilityOwnerCondition } from "./cost-visibility-filter";

export { BudgetAlertNoteError };

type EventRow = typeof budgetAlertEvents.$inferSelect;

/** A note-bearing event row plus its author, as one select returns them. */
export interface EventWithAuthor {
  event: EventRow;
  authorName: string | null;
}

/** The note half of an event, or null while nobody has written one. */
export function toBudgetAlertNote(
  row: EventRow,
  authorName: string | null,
): BudgetAlertNote | null {
  if (!row.notedAt || row.note === null) return null;
  return {
    text: row.note,
    notedAt: row.notedAt.toISOString(),
    notedByUserId: row.notedByUserId,
    notedByName: authorName,
    annotationId: row.annotationId,
  };
}

export function toBudgetAlertEvent(row: EventRow, authorName: string | null): BudgetAlertEvent {
  return {
    id: row.id,
    month: row.month,
    thresholdType: row.thresholdType,
    thresholdPercent: row.thresholdPercent,
    actualAmountCents: row.actualAmountCents,
    forecastAmountCents: row.forecastAmountCents,
    triggeredAt: row.triggeredAt.toISOString(),
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    actualUsage: row.actualUsage,
    forecastUsage: row.forecastUsage,
    note: toBudgetAlertNote(row, authorName),
  };
}

/**
 * Author display names for `userIds`: display name, else email. One query for
 * a whole list, so a budget with ten noted firings is not ten lookups.
 */
export async function loadAuthorNames(userIds: Array<string | null>): Promise<Map<string, string>> {
  const ids = [...new Set(userIds.filter((id): id is string => id !== null))];
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: users.id, displayName: users.displayName, email: users.email })
    .from(users)
    .where(inArray(users.id, ids));
  return new Map(rows.map((u) => [u.id, u.displayName?.trim() || u.email]));
}

/** Events with their notes' authors resolved, newest first. */
export async function withAuthors(rows: EventRow[]): Promise<BudgetAlertEvent[]> {
  const names = await loadAuthorNames(rows.map((r) => r.notedByUserId));
  return rows.map((r) =>
    toBudgetAlertEvent(r, r.notedByUserId ? (names.get(r.notedByUserId) ?? null) : null),
  );
}

/**
 * Write (or rewrite) the note on one firing of a budget the caller can see.
 * Null when the budget or the event is not found (or not visible). Throws
 * {@link BudgetAlertNoteError} for a note an annotation could not hold.
 */
export async function noteBudgetAlertEvent(
  organizationId: string,
  budgetId: string,
  eventId: string,
  note: string,
  userId: string | null,
): Promise<BudgetAlertNoteResult | null> {
  const [found] = await db
    .select({ event: budgetAlertEvents, budgetName: budgets.name })
    .from(budgetAlertEvents)
    .innerJoin(budgets, eq(budgets.id, budgetAlertEvents.budgetId))
    .where(
      and(
        eq(budgetAlertEvents.id, eventId),
        eq(budgetAlertEvents.budgetId, budgetId),
        eq(budgetAlertEvents.organizationId, organizationId),
        eq(budgets.organizationId, organizationId),
        isNull(budgets.deletedAt),
        // A budget the caller's cost-visibility scope hides is not theirs to
        // explain: answered as not found, exactly as GET /budgets/:id is.
        visibilityOwnerCondition(budgets.visibilityUserId, organizationId),
      ),
    )
    .limit(1);
  if (!found) return null;
  const existing = found.event;

  const plan = planBudgetAlertNote(
    {
      triggeredAt: existing.triggeredAt,
      notedAt: existing.notedAt,
      annotationId: existing.annotationId,
    },
    note,
  );
  const text =
    plan.action === "create" ? plan.input.text : plan.action === "update" ? plan.text : note.trim();

  const row = await db.transaction(async (tx) => {
    let annotationId: string | null = existing.annotationId;
    if (plan.action === "create") {
      const [created] = await tx
        .insert(costAnnotations)
        .values({
          id: uuidv4(),
          organizationId,
          costReportId: null,
          startDate: plan.input.startDate,
          endDate: null,
          text: plan.input.text,
          createdByUserId: userId,
        })
        .returning({ id: costAnnotations.id });
      annotationId = created?.id ?? null;
    } else if (plan.action === "update") {
      // Text only: the marker's date and scope may have been edited on purpose.
      const [updated] = await tx
        .update(costAnnotations)
        .set({ text: plan.text, updatedAt: new Date() })
        .where(
          and(
            eq(costAnnotations.id, plan.annotationId),
            eq(costAnnotations.organizationId, organizationId),
          ),
        )
        .returning({ id: costAnnotations.id });
      annotationId = updated?.id ?? null;
    }
    const [saved] = await tx
      .update(budgetAlertEvents)
      .set({ note: text, notedAt: new Date(), notedByUserId: userId, annotationId })
      .where(eq(budgetAlertEvents.id, existing.id))
      .returning();
    return saved ?? null;
  });
  if (!row) return null;

  const names = await loadAuthorNames([userId]);
  const author = userId ? (names.get(userId) ?? null) : null;
  const event = toBudgetAlertEvent(row, author);
  const followUp = await postBudgetAlertNoteFollowUp(
    organizationId,
    { slackMessages: row.slackMessages ?? null, msTeamsWebhookIds: row.msTeamsWebhookIds ?? null },
    {
      title: `Budget "${found.budgetName}" alert explained`,
      text: budgetAlertNoteFollowUpText(found.budgetName, event, text, author),
      url: orgAppUrl(organizationId, `budgets/${budgetId}`) ?? undefined,
    },
  );
  return { ...event, followUp };
}

/** A budget's last 100 firings with notes, newest first; null when not found. */
export async function listBudgetAlertEventsWithNotes(
  organizationId: string,
  budgetId: string,
): Promise<BudgetAlertEvent[] | null> {
  const [budget] = await db
    .select({ id: budgets.id })
    .from(budgets)
    .where(
      and(
        eq(budgets.id, budgetId),
        eq(budgets.organizationId, organizationId),
        visibilityOwnerCondition(budgets.visibilityUserId, organizationId),
      ),
    )
    .limit(1);
  if (!budget) return null;
  const rows = await db
    .select()
    .from(budgetAlertEvents)
    .where(eq(budgetAlertEvents.budgetId, budget.id))
    .orderBy(desc(budgetAlertEvents.triggeredAt))
    .limit(100);
  return withAuthors(rows);
}
