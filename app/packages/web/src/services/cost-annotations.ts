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
import { costAnnotations, costReports } from "../db/schema";

type CostAnnotationRow = typeof costAnnotations.$inferSelect;

/** A bad request rather than a server fault — the API maps this to a 400. */
export class CostAnnotationError extends Error {}

function toCostAnnotation(row: CostAnnotationRow): CostAnnotation {
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
  };
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

  const rows = await db
    .select()
    .from(costAnnotations)
    .where(scope)
    .orderBy(desc(costAnnotations.startDate), asc(costAnnotations.id));
  return rows.map(toCostAnnotation);
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
  return toCostAnnotation(created!);
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
  return updated ? toCostAnnotation(updated) : null;
}

/**
 * Delete an annotation. False when not found.
 *
 * A hard delete: a withdrawn explanation should stop appearing on charts, and
 * there is no config inside a note that anything else references.
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
