/**
 * Runbook documents — CRUD, shared by the web API and the MCP surface.
 *
 * Validation comes from `@infrawrench/client-core` (`validateRunbookInput`),
 * the same function the editor previews with, so the form and the server can
 * never disagree about what a valid runbook is.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  normalizeRunbookSteps,
  validateRunbookInput,
  type Runbook,
  type RunbookInput,
} from "@infrawrench/client-core";

import { db } from "../db/client";
import { rawTimestampToDate } from "../db/raw-timestamp";
import { users } from "../db/schema";
import { runbookRuns, runbooks } from "../db/runbook-schema";

export class RunbookInputError extends Error {
  status: 400 | 404 | 409;
  constructor(message: string, status: 400 | 404 | 409 = 400) {
    super(message);
    this.name = "RunbookInputError";
    this.status = status;
  }
}

const MAX_RUNBOOKS_PER_ORG = 300;

interface RunbookRow {
  id: string;
  name: string;
  description: string | null;
  steps: unknown;
  resourceTypeIds: string;
  tagKey: string | null;
  tagValue: string | null;
  enabled: boolean;
  createdByUserId: string | null;
  createdByName: string | null;
  createdAt: Date;
  updatedAt: Date;
  runCount: number;
  /**
   * A raw-`sql` selection, so drizzle's timestamp mapping never runs on it and
   * postgres-js hands back the wire string. Typed honestly so `toWire` has to
   * convert rather than call `.toISOString()` on a string (which is a crash
   * that only appears once a runbook has been run).
   */
  lastRunAt: Date | string | null;
}

function toWire(row: RunbookRow): Runbook {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    steps: (row.steps as Runbook["steps"]) ?? [],
    resourceTypeIds: row.resourceTypeIds ? row.resourceTypeIds.split(",").filter(Boolean) : [],
    tagKey: row.tagKey,
    tagValue: row.tagValue,
    enabled: row.enabled,
    createdByUserId: row.createdByUserId,
    createdByName: row.createdByName,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    runCount: Number(row.runCount ?? 0),
    lastRunAt: row.lastRunAt != null ? rawTimestampToDate(row.lastRunAt).toISOString() : null,
  };
}

/**
 * The run count and last-run time come from a correlated subquery rather than a
 * join with a GROUP BY: the list is small, the counts are what the list page
 * shows on every row, and grouping would have to carry every runbook column
 * through the aggregate.
 */
function selectRunbooks() {
  return db
    .select({
      id: runbooks.id,
      name: runbooks.name,
      description: runbooks.description,
      steps: runbooks.steps,
      resourceTypeIds: runbooks.resourceTypeIds,
      tagKey: runbooks.tagKey,
      tagValue: runbooks.tagValue,
      enabled: runbooks.enabled,
      createdByUserId: runbooks.createdByUserId,
      createdByName: users.displayName,
      createdAt: runbooks.createdAt,
      updatedAt: runbooks.updatedAt,
      runCount:
        sql<number>`(SELECT count(*) FROM ${runbookRuns} WHERE ${runbookRuns.runbookId} = ${runbooks.id})`.as(
          "run_count",
        ),
      lastRunAt: sql<
        Date | string | null
      >`(SELECT max(${runbookRuns.startedAt}) FROM ${runbookRuns} WHERE ${runbookRuns.runbookId} = ${runbooks.id})`.as(
        "last_run_at",
      ),
    })
    .from(runbooks)
    .leftJoin(users, eq(users.id, runbooks.createdByUserId));
}

export async function listRunbooks(organizationId: string): Promise<Runbook[]> {
  const rows = await selectRunbooks()
    .where(eq(runbooks.organizationId, organizationId))
    .orderBy(runbooks.name);
  return rows.map(toWire);
}

export async function getRunbook(
  organizationId: string,
  runbookId: string,
): Promise<Runbook | null> {
  const rows = await selectRunbooks()
    .where(and(eq(runbooks.organizationId, organizationId), eq(runbooks.id, runbookId)))
    .limit(1);
  return rows[0] ? toWire(rows[0]) : null;
}

export async function createRunbook(
  organizationId: string,
  input: RunbookInput,
  userId: string | null,
): Promise<Runbook> {
  const problem = validateRunbookInput(input);
  if (problem) throw new RunbookInputError(problem);

  const existing = await db
    .select({ id: runbooks.id })
    .from(runbooks)
    .where(eq(runbooks.organizationId, organizationId));
  if (existing.length >= MAX_RUNBOOKS_PER_ORG) {
    throw new RunbookInputError(`An organization may have ${MAX_RUNBOOKS_PER_ORG} runbooks.`);
  }

  const id = randomUUID();
  try {
    await db.insert(runbooks).values({
      id,
      organizationId,
      name: input.name.trim(),
      description: input.description?.trim() || null,
      steps: normalizeRunbookSteps(input.steps ?? [], randomUUID),
      resourceTypeIds: (input.resourceTypeIds ?? []).join(","),
      tagKey: input.tagKey ?? null,
      tagValue: input.tagValue ?? null,
      enabled: input.enabled ?? true,
      createdByUserId: userId,
    });
  } catch (err) {
    throw asNameConflict(err, input.name.trim());
  }
  const created = await getRunbook(organizationId, id);
  if (!created) throw new Error("Failed to create the runbook");
  return created;
}

export async function updateRunbook(
  organizationId: string,
  runbookId: string,
  patch: Partial<RunbookInput>,
): Promise<Runbook> {
  const current = await getRunbook(organizationId, runbookId);
  if (!current) throw new RunbookInputError("No such runbook.", 404);

  // Validated after merging, not before: a patch that only changes the steps
  // still has to produce a runbook that is valid as a whole, and validating the
  // patch alone would let one through with, say, a tag value and no key.
  const merged: RunbookInput = {
    name: patch.name ?? current.name,
    description: patch.description !== undefined ? patch.description : current.description,
    steps: patch.steps ?? current.steps,
    resourceTypeIds: patch.resourceTypeIds ?? current.resourceTypeIds,
    tagKey: patch.tagKey !== undefined ? patch.tagKey : current.tagKey,
    tagValue: patch.tagValue !== undefined ? patch.tagValue : current.tagValue,
    enabled: patch.enabled ?? current.enabled,
  };
  const problem = validateRunbookInput(merged);
  if (problem) throw new RunbookInputError(problem);

  try {
    await db
      .update(runbooks)
      .set({
        name: merged.name.trim(),
        description: merged.description?.trim() || null,
        steps: normalizeRunbookSteps(merged.steps ?? [], randomUUID),
        resourceTypeIds: (merged.resourceTypeIds ?? []).join(","),
        tagKey: merged.tagKey ?? null,
        tagValue: merged.tagValue ?? null,
        enabled: merged.enabled ?? true,
        updatedAt: new Date(),
      })
      .where(and(eq(runbooks.organizationId, organizationId), eq(runbooks.id, runbookId)));
  } catch (err) {
    throw asNameConflict(err, merged.name.trim());
  }

  const updated = await getRunbook(organizationId, runbookId);
  if (!updated) throw new RunbookInputError("No such runbook.", 404);
  return updated;
}

export async function deleteRunbook(organizationId: string, runbookId: string): Promise<boolean> {
  const deleted = await db
    .delete(runbooks)
    .where(and(eq(runbooks.organizationId, organizationId), eq(runbooks.id, runbookId)))
    .returning({ id: runbooks.id });
  return deleted.length > 0;
}

/**
 * Turn a unique-violation into the message the user needs.
 *
 * The name uniqueness is enforced by the index rather than by a pre-check,
 * because a check-then-insert loses the race — and the race here is two people
 * writing up the same incident afterwards, which is not a rare event.
 */
function asNameConflict(err: unknown, name: string): unknown {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("runbooks_org_name_unique")) {
    return new RunbookInputError(`A runbook called "${name}" already exists.`, 409);
  }
  return err;
}

/** Runbooks the org has, newest run first — the "recently used" ordering. */
export async function listRecentlyRunRunbooks(
  organizationId: string,
  limit = 5,
): Promise<Runbook[]> {
  const rows = await selectRunbooks()
    .where(and(eq(runbooks.organizationId, organizationId), eq(runbooks.enabled, true)))
    .orderBy(desc(sql`last_run_at`))
    .limit(limit);
  return rows.map(toWire);
}
