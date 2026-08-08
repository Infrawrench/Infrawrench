/**
 * Accepted posture findings (`posture_dismissals`).
 *
 * A finding is not a row — it is recomputed from stored fields on every read
 * — so "dismiss this warning" cannot be a flag on the finding. It is a
 * decision recorded against `(resourceId, ruleId)` and replayed by the feed,
 * which partitions the matching findings out of the list and out of the alert
 * pass. Everything that reads `listPosture` therefore inherits dismissals for
 * free: the web/desktop/mobile screens, the CLI, the MCP tool, the weekly
 * digest and the poller's daily alert.
 *
 * Deliberately *not* a delete: the dismissal keeps the note and the author,
 * the rule keeps being evaluated, and the feed reports the suppressed
 * findings back under `dismissed` so an accepted risk stays reviewable.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { PostureDismissal } from "@infrawrench/client-core";
import { db } from "../db/client";
import { postureDismissals, users } from "../db/schema";

/** Longest note we store. Long enough for a ticket link and a sentence. */
export const MAX_DISMISSAL_REASON_LENGTH = 500;

export interface PostureDismissalRecord extends PostureDismissal {
  id: string;
  organizationId: string;
}

interface DismissalRow {
  id: string;
  organizationId: string;
  resourceId: string;
  ruleId: string;
  reason: string | null;
  dismissedBy: string | null;
  dismissedByName: string | null;
  dismissedByEmail: string | null;
  updatedAt: Date;
}

/**
 * The wire shape. `dismissedBy` is a *name*, not an id — every surface
 * renders it directly, and the id is meaningless off-server. A deleted user
 * (the FK nulls out) reads as unknown rather than as a dangling reference.
 */
function toRecord(row: DismissalRow): PostureDismissalRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    resourceId: row.resourceId,
    ruleId: row.ruleId,
    reason: row.reason,
    dismissedBy: row.dismissedByName || row.dismissedByEmail || null,
    dismissedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The joined column list both reads select. A function, not a module-level
 * constant: touching schema columns at import time would make merely
 * importing this module (which the digest and the poller do transitively)
 * depend on the schema being resolvable.
 */
function selection() {
  return {
    id: postureDismissals.id,
    organizationId: postureDismissals.organizationId,
    resourceId: postureDismissals.resourceId,
    ruleId: postureDismissals.ruleId,
    reason: postureDismissals.reason,
    dismissedBy: postureDismissals.dismissedBy,
    dismissedByName: users.displayName,
    dismissedByEmail: users.email,
    updatedAt: postureDismissals.updatedAt,
  };
}

/** Every dismissal the org has recorded, most recent first. */
export async function listPostureDismissals(
  organizationId: string,
): Promise<PostureDismissalRecord[]> {
  const rows = await db
    .select(selection())
    .from(postureDismissals)
    .leftJoin(users, eq(users.id, postureDismissals.dismissedBy))
    .where(eq(postureDismissals.organizationId, organizationId))
    .orderBy(desc(postureDismissals.updatedAt));
  return rows.map(toRecord);
}

export interface DismissPostureFindingInput {
  resourceId: string;
  ruleId: string;
  reason?: string | null | undefined;
  /** Who is accepting the risk; null for an API-key caller with no user. */
  userId?: string | null | undefined;
}

/** An empty or whitespace-only note is stored as "no note", never as `""`. */
function normalizeReason(reason: string | null | undefined): string | null {
  if (typeof reason !== "string") return null;
  const trimmed = reason.trim();
  if (trimmed === "") return null;
  return trimmed.slice(0, MAX_DISMISSAL_REASON_LENGTH);
}

/**
 * Accept a finding. Idempotent by design — dismissing something already
 * dismissed rewrites the note, the author and the timestamp instead of
 * failing, so a retried request (or two admins reaching the same conclusion)
 * lands one row rather than an error.
 */
export async function dismissPostureFinding(
  organizationId: string,
  input: DismissPostureFindingInput,
): Promise<PostureDismissalRecord> {
  const resourceId = input.resourceId.trim();
  const ruleId = input.ruleId.trim();
  if (!resourceId) throw new Error("resourceId is required");
  if (!ruleId) throw new Error("ruleId is required");

  const now = new Date();
  const values = {
    reason: normalizeReason(input.reason),
    dismissedBy: input.userId ?? null,
    updatedAt: now,
  };
  const [row] = await db
    .insert(postureDismissals)
    .values({ id: randomUUID(), organizationId, resourceId, ruleId, ...values })
    .onConflictDoUpdate({
      target: [
        postureDismissals.organizationId,
        postureDismissals.resourceId,
        postureDismissals.ruleId,
      ],
      set: values,
    })
    .returning({ id: postureDismissals.id });
  if (!row) throw new Error("Failed to dismiss the posture finding");

  const [record] = await db
    .select(selection())
    .from(postureDismissals)
    .leftJoin(users, eq(users.id, postureDismissals.dismissedBy))
    .where(eq(postureDismissals.id, row.id))
    .limit(1);
  if (!record) throw new Error("Failed to dismiss the posture finding");
  return toRecord(record);
}

/**
 * Undo a dismissal. Returns whether a row was actually removed, so the route
 * can answer 404 for a key that was never dismissed rather than pretending.
 *
 * The key is trimmed exactly as `dismissPostureFinding` trims it before
 * storing: `DELETE /dismissals` reads both halves out of the query string,
 * which is where stray whitespace comes from, and a padded value that matched
 * on the way in has to match on the way out.
 */
export async function restorePostureFinding(
  organizationId: string,
  resourceId: string,
  ruleId: string,
): Promise<boolean> {
  const removed = await db
    .delete(postureDismissals)
    .where(
      and(
        eq(postureDismissals.organizationId, organizationId),
        eq(postureDismissals.resourceId, resourceId.trim()),
        eq(postureDismissals.ruleId, ruleId.trim()),
      ),
    )
    .returning({ id: postureDismissals.id });
  return removed.length > 0;
}
