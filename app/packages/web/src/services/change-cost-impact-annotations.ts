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
 *
 * ## "One note per subject" holds under concurrency, in two steps
 *
 * "Read the link, then write a note, then insert the link" reads correctly and
 * is wrong: two requests pinning the same subject at once both find no link,
 * both mint a note, and the second insert dies on the unique index with its
 * annotation already committed and now unreachable. Precisely the duplicate
 * marker the table exists to prevent, plus an orphan.
 *
 * So the write is ordered claim-first and neither step trusts the previous one:
 *
 * 1. {@link claimSubjectLink} inserts the link with a **null** annotation id
 *    under `onConflictDoNothing`, so both writers agree on one row before
 *    either writes anything.
 * 2. The note is attached by a **compare-and-swap** on that still-null column
 *    (`SET ... WHERE id = ? AND cost_annotation_id IS NULL RETURNING`), because
 *    step 1 only agrees on the row and not on who fills it. The writer whose
 *    swap returns nothing deletes the note it just made and rewords the
 *    winner's instead, so both requests end up describing one note.
 *
 * That is the conditional-UPDATE protocol `claimDueDeploymentTriggers` and the
 * digest's `last_sent_week_start` claim already use, reused rather than
 * reinvented.
 */
import { and, eq, isNull } from "drizzle-orm";
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
  deleteCostAnnotation,
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

  // Claim the subject BEFORE writing anything. See {@link claimSubjectLink}.
  const link = await claimSubjectLink(organizationId, request);

  // A null `costAnnotationId` means either a link we just minted or a note that
  // was deleted out from under an old one (ON DELETE SET NULL). Deleting a
  // marker is not a retraction, so both states mean the same thing here: there
  // is nothing to reword, write a fresh note and point the link at it.
  const existing = await readLinkedAnnotation(organizationId, link.costAnnotationId);

  try {
    if (existing) {
      // Text only: the date and the report scope may have been edited on
      // purpose since, and a restated number is not a reason to move a marker.
      const updated = await updateCostAnnotation(organizationId, existing.id, {
        startDate: existing.startDate,
        text,
      });
      if (updated) {
        await touchLink(link.id);
        return { annotationId: updated.id, impact: resolved.impact, text };
      }
    }

    const created = await createCostAnnotation(
      organizationId,
      { startDate: resolved.impact.eventDay, text },
      userId,
    );

    // Attaching is a compare-and-swap on the still-null column, not a plain
    // UPDATE — the same conditional-UPDATE protocol the deployment-trigger and
    // digest claims use. Two writers can hold the same freshly claimed link
    // (the claim above only agrees on the row, not on who fills it), and only
    // the one that moves the column off null owns the note it just wrote.
    const [won] = await db
      .update(changeCostImpactAnnotations)
      .set({ costAnnotationId: created.id, updatedAt: new Date() })
      .where(
        and(
          eq(changeCostImpactAnnotations.id, link.id),
          isNull(changeCostImpactAnnotations.costAnnotationId),
        ),
      )
      .returning({ id: changeCostImpactAnnotations.id });

    if (won) return { annotationId: created.id, impact: resolved.impact, text };

    // Somebody attached first. Ours must not survive as a second marker on the
    // same day — that is the whole reason this link table exists — so it is
    // deleted and the winner's note is reworded instead. Both writers then
    // agree on one note carrying the same text.
    await deleteCostAnnotation(organizationId, created.id);
    const winner = await readLinkedAnnotation(organizationId, await linkedAnnotationId(link.id));
    if (!winner) {
      throw new ChangeImpactAnnotationError(
        "This finding was being annotated concurrently; try again.",
      );
    }
    const updated = await updateCostAnnotation(organizationId, winner.id, {
      startDate: winner.startDate,
      text,
    });
    if (!updated) {
      throw new ChangeImpactAnnotationError(
        "This finding was being annotated concurrently; try again.",
      );
    }
    return { annotationId: updated.id, impact: resolved.impact, text };
  } catch (e) {
    if (e instanceof CostAnnotationError) throw new ChangeImpactAnnotationError(e.message);
    throw e;
  }
}

/**
 * The link row for this subject, minting one when nobody holds it yet.
 *
 * The unique index on `(organization_id, subject_kind, subject_id)` is the
 * mutual exclusion, and `onConflictDoNothing` is what turns it from an error
 * into an agreement: two requests pinning the same subject at once settle on
 * one row **before** either writes a note, instead of both minting one and the
 * loser blowing up on the constraint with an orphaned annotation left behind.
 *
 * The row is created with a null `cost_annotation_id` on purpose. A claim that
 * carried the note's id would have to write the note first, which is the
 * ordering that leaks orphans; a null there is also exactly the state a deleted
 * note leaves, so it needs no separate branch downstream.
 */
async function claimSubjectLink(
  organizationId: string,
  request: ChangeImpactAnnotationRequest,
): Promise<{ id: string; costAnnotationId: string | null }> {
  const where = and(
    eq(changeCostImpactAnnotations.organizationId, organizationId),
    eq(changeCostImpactAnnotations.subjectKind, request.subjectKind),
    eq(changeCostImpactAnnotations.subjectId, request.subjectId),
  );

  // Two passes, because the pair is not itself atomic: a conflict says the row
  // existed a moment ago, and an org cascade could take it away before the
  // read. One retry covers that; a second miss is a real fault, not a race.
  for (let attempt = 0; attempt < 2; attempt++) {
    const [inserted] = await db
      .insert(changeCostImpactAnnotations)
      .values({
        id: uuidv4(),
        organizationId,
        subjectKind: request.subjectKind,
        subjectId: request.subjectId,
        costAnnotationId: null,
      })
      .onConflictDoNothing()
      .returning({
        id: changeCostImpactAnnotations.id,
        costAnnotationId: changeCostImpactAnnotations.costAnnotationId,
      });
    if (inserted) return inserted;

    const [existing] = await db
      .select({
        id: changeCostImpactAnnotations.id,
        costAnnotationId: changeCostImpactAnnotations.costAnnotationId,
      })
      .from(changeCostImpactAnnotations)
      .where(where)
      .limit(1);
    if (existing) return existing;
  }

  throw new ChangeImpactAnnotationError(
    "This finding was being annotated concurrently; try again.",
  );
}

/** Which note a link currently points at, re-read rather than remembered. */
async function linkedAnnotationId(linkId: string): Promise<string | null> {
  const [row] = await db
    .select({ costAnnotationId: changeCostImpactAnnotations.costAnnotationId })
    .from(changeCostImpactAnnotations)
    .where(eq(changeCostImpactAnnotations.id, linkId))
    .limit(1);
  return row?.costAnnotationId ?? null;
}

/** The note itself, or null when there is none (or it is another org's). */
async function readLinkedAnnotation(
  organizationId: string,
  annotationId: string | null,
): Promise<{ id: string; startDate: string } | null> {
  if (!annotationId) return null;
  const [row] = await db
    .select({ id: costAnnotations.id, startDate: costAnnotations.startDate })
    .from(costAnnotations)
    .where(
      and(eq(costAnnotations.id, annotationId), eq(costAnnotations.organizationId, organizationId)),
    )
    .limit(1);
  return row ?? null;
}

/** Record that the finding was re-pinned, without touching what it points at. */
async function touchLink(linkId: string): Promise<void> {
  await db
    .update(changeCostImpactAnnotations)
    .set({ updatedAt: new Date() })
    .where(eq(changeCostImpactAnnotations.id, linkId));
}
