/**
 * "The issue is done, so the finding is resolved": the one finding kind on
 * which that concept exists is the cost anomaly, whose resolution is the
 * acknowledgement (an explanation on the row plus the org-wide chart note it
 * mints; see `cost/anomaly-acknowledge.ts` for the rules).
 *
 * Opt-in per tracker (`acknowledge_on_done`), and only ever a *first*
 * acknowledgement: an anomaly somebody already explained keeps their words.
 * The explanation names the issue ("Resolved in Jira as OPS-412 (Done)") so
 * whoever reads the chart note can follow it to the discussion.
 *
 * This is the background twin of web's `acknowledgeCostAnomaly`, which needs a
 * request (visibility scopes, a user) the poll and the webhook receivers do
 * not have. It writes the same two rows in one transaction, from the same
 * shared planner, and then resolves the finding's GitHub issue exactly as a
 * person's acknowledgement does.
 */
import { and, eq, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { planAnomalyAcknowledgement } from "../cost/anomaly-acknowledge";
import { db } from "../db/client";
import { costAnnotations, costAnomalies } from "../db/schema";
import { resolveFindingIssues } from "../github-issues/filing";

/** Thrown inside the transaction to roll back the note when a person got there first. */
class LostRace extends Error {}

/** The explanation recorded on the anomaly. Pure, so the wording is pinned by tests. */
export function issueDoneExplanation(
  trackerLabel: string,
  handle: string,
  status: string | null,
): string {
  return `Resolved in ${trackerLabel} as ${handle}${status ? ` (${status})` : ""}.`;
}

/**
 * Acknowledge one anomaly because its issue was finished. Returns true when
 * it did; false when the anomaly is gone, already acknowledged, or the write
 * failed (logged). Never throws: it runs inside a webhook delivery and a poll.
 */
export async function acknowledgeAnomalyFromIssue(
  organizationId: string,
  anomalyId: string,
  explanation: string,
): Promise<boolean> {
  try {
    const [existing] = await db
      .select()
      .from(costAnomalies)
      .where(and(eq(costAnomalies.id, anomalyId), eq(costAnomalies.organizationId, organizationId)))
      .limit(1);
    if (!existing || existing.acknowledgedAt !== null) return false;
    const plan = planAnomalyAcknowledgement(
      { day: existing.day, acknowledgedAt: null, annotationId: existing.annotationId },
      explanation,
    );
    if (plan.action !== "create") return false;

    const done = await db.transaction(async (tx) => {
      const [note] = await tx
        .insert(costAnnotations)
        .values({
          id: randomUUID(),
          organizationId,
          costReportId: plan.input.costReportId ?? null,
          startDate: plan.input.startDate,
          endDate: null,
          text: plan.input.text,
          createdByUserId: null,
        })
        .returning({ id: costAnnotations.id });
      // Conditional on still being unacknowledged: a person explaining it in
      // the same instant wins, and this transaction then rolls back its note.
      const [row] = await tx
        .update(costAnomalies)
        .set({
          explanation: plan.input.text,
          acknowledgedAt: new Date(),
          acknowledgedByUserId: null,
          annotationId: note?.id ?? null,
        })
        .where(and(eq(costAnomalies.id, anomalyId), isNull(costAnomalies.acknowledgedAt)))
        .returning({ id: costAnomalies.id });
      if (!row) throw new LostRace();
      return true;
    });
    if (!done) return false;

    await resolveFindingIssues(
      organizationId,
      [{ sourceKind: "cost_anomaly", sourceId: anomalyId }],
      explanation,
    );
    return true;
  } catch (err) {
    if (err instanceof LostRace) return false;
    console.error("[issue-status] acknowledging anomaly", anomalyId, "failed:", err);
    return false;
  }
}
