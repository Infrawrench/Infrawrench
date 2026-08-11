/**
 * Read side of cost anomaly detection — the poller writes `cost_anomalies`
 * (server-core `cost/anomaly-eval.ts`); this lists them for the Costs panel
 * and the HTTP API.
 *
 * It also owns the one *write* a person can make to a finding: acknowledging
 * it with an explanation, which records what it was and mints the annotation
 * that says so on every chart covering the day. The rules for that live in
 * server-core `cost/anomaly-acknowledge.ts`, with no database in them; this
 * file is where they meet the tables.
 */
import { and, desc, eq, gte } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import type { CostAnomaly, CostAnomalyAcknowledgement } from "@infrawrench/client-core";
import {
  planAnomalyAcknowledgement,
  CostAnomalyAcknowledgeError,
} from "@infrawrench/server-core/cost/anomaly-acknowledge";
import { db } from "../db/client";
import { costAnnotations, costAnomalies } from "../db/schema";

export { CostAnomalyAcknowledgeError };

/** Hard cap on rows returned, whatever window was asked for. */
const MAX_ROWS = 200;

type CostAnomalyRow = typeof costAnomalies.$inferSelect;

/**
 * The acknowledgement half of a row, or null while nobody has explained it.
 *
 * `acknowledgedAt` is the discriminator rather than `explanation` or
 * `annotationId`: the note can be deleted (`annotationId` goes null by the
 * foreign key's ON DELETE SET NULL) and that must not turn an explained finding
 * back into an open question.
 */
function toAcknowledgement(row: CostAnomalyRow): CostAnomalyAcknowledgement | null {
  if (!row.acknowledgedAt) return null;
  return {
    explanation: row.explanation ?? "",
    acknowledgedAt: row.acknowledgedAt.toISOString(),
    acknowledgedByUserId: row.acknowledgedByUserId,
    annotationId: row.annotationId,
  };
}

function toCostAnomaly(row: CostAnomalyRow): CostAnomaly {
  return {
    id: row.id,
    day: row.day,
    kind: row.kind,
    dimension: row.dimension,
    dimensionKey: row.dimensionKey,
    currency: row.currency,
    actualCents: row.actualAmountCents,
    baselineCents: row.baselineAmountCents,
    thresholdCents: row.thresholdAmountCents,
    detectedAt: row.detectedAt.toISOString(),
    notifiedAt: row.notifiedAt ? row.notifiedAt.toISOString() : null,
    // Rows written before hints existed (or whose hint queries failed at
    // detection time) hold null; the wire contract is always an array.
    hints: row.hints ?? [],
    acknowledgement: toAcknowledgement(row),
  };
}

/**
 * Anomalies detected in the last `days` days (by anomalous day, not detection
 * time), newest day first, then largest overshoot first within a day.
 *
 * Explained findings are **not** filtered out. Acknowledging stops a row
 * nagging — it drops out of the unexplained count and renders as answered — but
 * the detection was correct and the record is the point: hiding it would lose
 * the history and invite the next reader to work the same spike out again.
 */
export async function listRecentCostAnomalies(
  organizationId: string,
  days: number,
): Promise<CostAnomaly[]> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const rows = await db
    .select()
    .from(costAnomalies)
    .where(and(eq(costAnomalies.organizationId, organizationId), gte(costAnomalies.day, since)))
    .orderBy(desc(costAnomalies.day), desc(costAnomalies.actualAmountCents))
    .limit(MAX_ROWS);

  return rows.map(toCostAnomaly);
}

/** One anomaly by id, scoped to the org. Null when it isn't theirs. */
export async function getCostAnomaly(
  organizationId: string,
  anomalyId: string,
): Promise<CostAnomaly | null> {
  const [row] = await db
    .select()
    .from(costAnomalies)
    .where(and(eq(costAnomalies.id, anomalyId), eq(costAnomalies.organizationId, organizationId)))
    .limit(1);
  return row ? toCostAnomaly(row) : null;
}

/**
 * Explain a finding: record the sentence on the anomaly and put it on the
 * charts as an annotation at the anomaly's own day, org-wide.
 *
 * Null when the anomaly isn't this org's. Throws
 * {@link CostAnomalyAcknowledgeError} for an explanation an annotation could
 * not hold — the API answers 400.
 *
 * Both writes happen in one transaction. Without it a failure between them
 * leaves a note on every chart that no finding claims, and — worse — a retry
 * would mint a *second* one, because the anomaly still looks unacknowledged.
 * The annotation row is written here rather than through
 * services/cost-annotations.ts for that reason alone (those helpers hold the
 * module-level `db` and cannot join a transaction); the values still come from
 * the one shared derivation, `costAnomalyAnnotationInput`, so the note's date
 * and scope are decided in exactly one place.
 */
export async function acknowledgeCostAnomaly(
  organizationId: string,
  anomalyId: string,
  explanation: string,
  userId: string | null,
): Promise<CostAnomaly | null> {
  const [existing] = await db
    .select()
    .from(costAnomalies)
    .where(and(eq(costAnomalies.id, anomalyId), eq(costAnomalies.organizationId, organizationId)))
    .limit(1);
  if (!existing) return null;

  const plan = planAnomalyAcknowledgement(
    {
      day: existing.day,
      acknowledgedAt: existing.acknowledgedAt,
      annotationId: existing.annotationId,
    },
    explanation,
  );

  // The sentence as it will be stored, trimmed once by the shared derivation so
  // the anomaly's record and the note's text are the same string — including in
  // the "none" case, where there is no note left to compare against.
  const text =
    plan.action === "create"
      ? plan.input.text
      : plan.action === "update"
        ? plan.text
        : explanation.trim();

  return db.transaction(async (tx) => {
    let annotationId: string | null = existing.annotationId;

    if (plan.action === "create") {
      const [created] = await tx
        .insert(costAnnotations)
        .values({
          id: uuidv4(),
          organizationId,
          costReportId: plan.input.costReportId ?? null,
          startDate: plan.input.startDate,
          endDate: null,
          text: plan.input.text,
          createdByUserId: userId,
        })
        .returning({ id: costAnnotations.id });
      annotationId = created?.id ?? null;
    } else if (plan.action === "update") {
      // Text only. The date and the scope may have been edited deliberately in
      // the annotation editor since, and a correction to the wording is not a
      // licence to move somebody's note back.
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
      // Deleted between the read and the write: the foreign key has already
      // nulled the link, so record that rather than pointing at a dead row.
      annotationId = updated?.id ?? null;
    }

    const [row] = await tx
      .update(costAnomalies)
      .set({
        explanation: text,
        // Restamped by a correction: this is when the *current* explanation was
        // recorded, not when the finding was first closed.
        acknowledgedAt: new Date(),
        acknowledgedByUserId: userId,
        annotationId,
      })
      .where(eq(costAnomalies.id, anomalyId))
      .returning();
    return row ? toCostAnomaly(row) : null;
  });
}
