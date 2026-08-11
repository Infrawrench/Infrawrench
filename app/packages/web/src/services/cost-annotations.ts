/**
 * Org-scoped cost-annotation CRUD — the dated notes drawn over cost charts.
 *
 * Shared by the HTTP routes (api/routes/cost-annotations.ts) the same way
 * services/cost-reports.ts is, so there is one implementation of "which notes
 * does this chart show" no matter which caller asks.
 *
 * The scoping rule is the only interesting thing in here and it lives in
 * {@link listCostAnnotations}: a null `costReportId` is org-wide and belongs on
 * every cost chart, so a query for one report returns that report's own notes
 * **plus** the org-wide ones. Anything else would mean "we changed instance
 * types" had to be re-entered on every report it explains.
 */
import { and, asc, desc, eq, isNull, or } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";

import {
  costAnnotationInputError,
  type CostAnnotation,
  type CostAnnotationInput,
} from "@infrawrench/client-core";

import { db } from "../db/client";
import { costAnnotations, costAnomalies, costReports } from "../db/schema";

type CostAnnotationRow = typeof costAnnotations.$inferSelect;

/** A bad request rather than a server fault — the API maps this to a 400. */
export class CostAnnotationError extends Error {}

/**
 * @param costAnomalyId The finding this note was written to explain, when it
 * came from acknowledging one. Resolved from `cost_anomalies.annotation_id` —
 * the same single foreign key the anomaly reads forwards — so the link cannot
 * disagree with itself. Null on the create path, where a note written by hand
 * explains no finding by definition.
 */
function toCostAnnotation(row: CostAnnotationRow, costAnomalyId: string | null): CostAnnotation {
  return {
    id: row.id,
    // `date` columns come back as YYYY-MM-DD strings, which is exactly the
    // shape the bucket mapping compares against — never parsed into a Date on
    // the way through, because a timezone would be invented in the process.
    startDate: row.startDate,
    endDate: row.endDate,
    text: row.text,
    costReportId: row.costReportId,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    costAnomalyId,
  };
}

/**
 * The finding that points at this note, if any — the reverse of the link, read
 * from the anomaly's side because that is where the only copy of it lives.
 */
async function anomalyIdForAnnotation(annotationId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: costAnomalies.id })
    .from(costAnomalies)
    .where(eq(costAnomalies.annotationId, annotationId))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Reject a report id that isn't this org's (or has been deleted) before it can
 * become an FK violation, so scoping a note to somebody else's report is a 400
 * with a sentence rather than a 500.
 */
async function assertCostReportInOrg(organizationId: string, reportId: string): Promise<void> {
  const [row] = await db
    .select({ id: costReports.id })
    .from(costReports)
    .where(
      and(
        eq(costReports.id, reportId),
        eq(costReports.organizationId, organizationId),
        isNull(costReports.deletedAt),
      ),
    )
    .limit(1);
  if (!row) throw new CostAnnotationError("Unknown cost report.");
}

/** Shape-check an input the way both the editors and the API must. */
function assertValid(input: CostAnnotationInput): void {
  const problem = costAnnotationInputError(input);
  if (problem) throw new CostAnnotationError(problem);
}

/**
 * The org's annotations, newest first.
 *
 * With `reportId`, this is the set a chart for that report draws: the org-wide
 * notes **and** that report's own. Without it, every annotation in the org —
 * what a management list wants, and what an ad-hoc dashboard cost card draws
 * (an org-wide note belongs on every chart, and a card belongs to no report).
 */
export async function listCostAnnotations(
  organizationId: string,
  options: { reportId?: string | undefined } = {},
): Promise<CostAnnotation[]> {
  const scope = options.reportId
    ? and(
        eq(costAnnotations.organizationId, organizationId),
        or(
          isNull(costAnnotations.costReportId),
          eq(costAnnotations.costReportId, options.reportId),
        ),
      )
    : eq(costAnnotations.organizationId, organizationId);

  // Left-joined rather than a second query: an annotation that came from
  // acknowledging an anomaly should say so wherever it is drawn, and the join
  // is on `cost_anomalies.annotation_id`, which is unique where it is set — so
  // this can only ever add one id per note, never duplicate a row.
  const rows = await db
    .select({ annotation: costAnnotations, anomalyId: costAnomalies.id })
    .from(costAnnotations)
    .leftJoin(costAnomalies, eq(costAnomalies.annotationId, costAnnotations.id))
    .where(scope)
    .orderBy(desc(costAnnotations.startDate), asc(costAnnotations.id));
  return rows.map(({ annotation, anomalyId }) => toCostAnnotation(annotation, anomalyId));
}

export async function createCostAnnotation(
  organizationId: string,
  input: CostAnnotationInput,
  createdByUserId: string | null,
): Promise<CostAnnotation> {
  assertValid(input);
  if (input.costReportId) await assertCostReportInOrg(organizationId, input.costReportId);
  const [created] = await db
    .insert(costAnnotations)
    .values({
      id: uuidv4(),
      organizationId,
      costReportId: input.costReportId ?? null,
      startDate: input.startDate,
      // An end equal to the start is a moment, so it is stored as one: two
      // spellings of the same fact would otherwise render differently.
      endDate: input.endDate && input.endDate > input.startDate ? input.endDate : null,
      text: input.text.trim(),
      createdByUserId,
    })
    .returning();
  // A note written by hand explains no finding, so the reverse link is null
  // without a lookup — only an acknowledgement can create that link, and it
  // writes the anomaly's side of it in the same transaction.
  return toCostAnnotation(created!, null);
}

/**
 * Replace an annotation's date, span, text and scope. Null when not found.
 *
 * A full replace, matching every other cost object: the editor always holds the
 * whole note, and there is nothing in it small enough to be worth patching.
 */
export async function updateCostAnnotation(
  organizationId: string,
  annotationId: string,
  input: CostAnnotationInput,
): Promise<CostAnnotation | null> {
  assertValid(input);
  if (input.costReportId) await assertCostReportInOrg(organizationId, input.costReportId);
  const [updated] = await db
    .update(costAnnotations)
    .set({
      costReportId: input.costReportId ?? null,
      startDate: input.startDate,
      endDate: input.endDate && input.endDate > input.startDate ? input.endDate : null,
      text: input.text.trim(),
      updatedAt: new Date(),
    })
    .where(
      and(eq(costAnnotations.id, annotationId), eq(costAnnotations.organizationId, organizationId)),
    )
    .returning();
  if (!updated) return null;
  // Editing a note never changes which finding points at it — the link lives on
  // the anomaly and this endpoint cannot reach that column — but the answer
  // still has to carry it, or rewording an anomaly's note would read back as
  // having severed it.
  return toCostAnnotation(updated, await anomalyIdForAnnotation(updated.id));
}

/**
 * Delete an annotation. False when not found.
 *
 * A hard delete: a withdrawn explanation should stop appearing on charts, and
 * there is no config inside a note that anything else references.
 *
 * An acknowledged anomaly pointing at this note is **not** reopened by it. The
 * foreign key nulls `cost_anomalies.annotation_id` (ON DELETE SET NULL) and
 * nothing else changes: the finding keeps its explanation and stays out of the
 * unexplained count, because somebody did work out what it was and deleting
 * their chart marker is not a retraction of that.
 */
export async function deleteCostAnnotation(
  organizationId: string,
  annotationId: string,
): Promise<boolean> {
  const [deleted] = await db
    .delete(costAnnotations)
    .where(
      and(eq(costAnnotations.id, annotationId), eq(costAnnotations.organizationId, organizationId)),
    )
    .returning({ id: costAnnotations.id });
  return Boolean(deleted);
}
