/**
 * Pin a change's or a deploy's cost impact onto the cost graphs.
 *
 * The impact itself is never stored — `cost/change-impact-load.ts` recomputes
 * it on every read so late-arriving and restated provider cost keeps moving the
 * number. What this writes is a **cost annotation**: a dated note the charts
 * already draw, so "the run rate stepped up here, and this is why" appears on
 * the graph beside the step it explains.
 *
 * Re-pinning the same subject **rewords the same note** rather than minting a
 * second one, which is the whole reason `change_cost_impact_annotations`
 * exists. That matters more here than it does for an acknowledged anomaly: the
 * expected use is to pin a finding a few days after a deploy and pin it again a
 * week later once the provider has finished restating, and without the link
 * every restatement would leave another marker on the same day.
 *
 * The note's **date is not rewritten** on a re-pin, and neither is its scope —
 * the same rule anomaly re-acknowledgement follows, and for the same reason:
 * somebody may have widened or moved it deliberately. Only the text changes.
 */
import { and, eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";

import {
  changeCostImpactAnnotationText,
  type ChangeCostImpact,
  type ChangeCostImpactSubjectKind,
  type CostBasis,
} from "@infrawrench/client-core";
import {
  describeChangeSubject,
  describeDeploymentSubject,
  loadChangeCostImpact,
  loadDeploymentCostImpact,
} from "@infrawrench/server-core/cost/change-impact-load";
import { sumChangeCostImpacts } from "@infrawrench/server-core/cost/change-impact";

import { db } from "../db/client";
import { changeCostImpactAnnotations, costAnnotations } from "../db/schema";
import {
  CostAnnotationError,
  createCostAnnotation,
  updateCostAnnotation,
} from "./cost-annotations";

export interface ChangeImpactAnnotationRequest {
  subjectKind: ChangeCostImpactSubjectKind;
  subjectId: string;
  windowDays?: number | undefined;
  costBasis?: CostBasis | undefined;
}

/**
 * The impact a subject currently has, plus the label the note names it by.
 * Null when the subject is not this org's.
 */
async function resolveSubject(
  organizationId: string,
  request: ChangeImpactAnnotationRequest,
): Promise<{ impact: ChangeCostImpact; label: string } | null> {
  const options = {
    ...(request.windowDays === undefined ? {} : { windowDays: request.windowDays }),
    ...(request.costBasis === undefined ? {} : { costBasis: request.costBasis }),
  };

  if (request.subjectKind === "change") {
    const entry = await loadChangeCostImpact(organizationId, request.subjectId, options);
    if (!entry) return null;
    const label = await describeChangeSubject(organizationId, request.subjectId);
    return { impact: entry.impact, label: label ?? "resource change" };
  }

  const deployment = await loadDeploymentCostImpact(organizationId, request.subjectId, options);
  if (!deployment) return null;
  const label = await describeDeploymentSubject(organizationId, request.subjectId);
  // A deploy has no single impact — it has a breakdown. The note carries the
  // sum, with the same rule the API applies: unknown resources contribute
  // nothing rather than zero, and the confidence is the weakest contributor's.
  const rolled = sumChangeCostImpacts(deployment.resources.map((r) => r.impact));
  const impact: ChangeCostImpact = {
    status: rolled.total.length > 0 ? "measured" : "unknown",
    costBasis: deployment.costBasis,
    windowDays: deployment.windowDays,
    effectiveWindowDays: deployment.windowDays,
    eventDay: deployment.eventDay,
    before: null,
    after: null,
    series: rolled.total.map((t) => ({
      currency: t.currency,
      beforePerDay: 0,
      afterPerDay: 0,
      deltaPerDay: t.deltaPerDay,
      deltaPercent: null,
      beforeTotal: 0,
      afterTotal: 0,
    })),
    confidence: rolled.confidence,
    reasons: rolled.total.length > 0 ? [] : ["no_cost_data"],
    overlappingChanges: deployment.resources.reduce((n, r) => n + r.impact.overlappingChanges, 0),
  };
  return { impact, label: label ?? "deployment" };
}

export class ChangeImpactAnnotationError extends Error {}

/**
 * Write (or reword) the annotation for one subject.
 *
 * Returns null when the subject does not belong to the org. Throws
 * {@link ChangeImpactAnnotationError} when there is nothing worth annotating —
 * an unmeasurable impact must not become a note saying "$0", which is the
 * failure this whole feature is arranged to avoid.
 */
export async function writeChangeImpactAnnotation(
  organizationId: string,
  request: ChangeImpactAnnotationRequest,
  userId: string | null,
): Promise<{ annotationId: string; impact: ChangeCostImpact; text: string } | null> {
  const resolved = await resolveSubject(organizationId, request);
  if (!resolved) return null;

  const text = changeCostImpactAnnotationText(
    { kind: request.subjectKind, label: resolved.label },
    resolved.impact,
  );
  if (text === null) {
    throw new ChangeImpactAnnotationError(
      "There is no measured cost impact to annotate yet — cost data may still be arriving.",
    );
  }

  const [link] = await db
    .select()
    .from(changeCostImpactAnnotations)
    .where(
      and(
        eq(changeCostImpactAnnotations.organizationId, organizationId),
        eq(changeCostImpactAnnotations.subjectKind, request.subjectKind),
        eq(changeCostImpactAnnotations.subjectId, request.subjectId),
      ),
    )
    .limit(1);

  // The note may have been deleted out from under the link (ON DELETE SET
  // NULL), which is not a retraction — it just means there is nothing to
  // reword, so a fresh note is written and the link re-points.
  const existingId = link?.costAnnotationId ?? null;
  const existing = existingId
    ? await db
        .select({ id: costAnnotations.id, startDate: costAnnotations.startDate })
        .from(costAnnotations)
        .where(
          and(
            eq(costAnnotations.id, existingId),
            eq(costAnnotations.organizationId, organizationId),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null)
    : null;

  try {
    if (existing) {
      // Text only: the date and the report scope may have been edited on
      // purpose since, and a restated number is not a reason to move a marker.
      const updated = await updateCostAnnotation(organizationId, existing.id, {
        startDate: existing.startDate,
        text,
      });
      if (updated) {
        await db
          .update(changeCostImpactAnnotations)
          .set({ updatedAt: new Date() })
          .where(eq(changeCostImpactAnnotations.id, link!.id));
        return { annotationId: updated.id, impact: resolved.impact, text };
      }
    }

    const created = await createCostAnnotation(
      organizationId,
      { startDate: resolved.impact.eventDay, text },
      userId,
    );
    if (link) {
      await db
        .update(changeCostImpactAnnotations)
        .set({ costAnnotationId: created.id, updatedAt: new Date() })
        .where(eq(changeCostImpactAnnotations.id, link.id));
    } else {
      await db.insert(changeCostImpactAnnotations).values({
        id: uuidv4(),
        organizationId,
        subjectKind: request.subjectKind,
        subjectId: request.subjectId,
        costAnnotationId: created.id,
      });
    }
    return { annotationId: created.id, impact: resolved.impact, text };
  } catch (e) {
    if (e instanceof CostAnnotationError) throw new ChangeImpactAnnotationError(e.message);
    throw e;
  }
}
