/**
 * Performing a runbook: starting a run, ticking a step, closing it out.
 *
 * A run is a *snapshot*, not a pointer. Starting one copies every step's title
 * and kind into its own rows, so the record of what somebody was asked to do at
 * 03:14 survives the runbook being rewritten the following week. That is the
 * whole reason this is a table rather than a join.
 *
 * Ticking a step is a single targeted `UPDATE` on one row. Two responders
 * working the same incident tick different steps at the same moment, and the
 * obvious alternative — a jsonb array on the run — loses whichever write lands
 * second.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type {
  RunbookRun,
  RunbookRunStep,
  RunbookStep,
  RunbookStepStatus,
} from "@infrawrench/client-core";

import { db } from "../db/client";
import { users } from "../db/schema";
import { runbookRunSteps, runbookRuns, runbooks } from "../db/runbook-schema";
import { RunbookInputError } from "./store";

const MAX_NOTE_LENGTH = 4000;
const MAX_SUMMARY_LENGTH = 8000;

export interface StartRunbookRunOptions {
  organizationId: string;
  runbookId: string;
  userId: string | null;
  /** The incident this is being performed under, when there is one. */
  incidentId?: string | null;
}

/**
 * Start a run.
 *
 * Deliberately **not** idempotent and deliberately not deduplicated against an
 * already-running run of the same runbook: performing the failover procedure
 * twice in one incident is a real thing that happens, and refusing the second
 * one would mean the second attempt goes unrecorded rather than not happening.
 */
export async function startRunbookRun(options: StartRunbookRunOptions): Promise<RunbookRun> {
  const [book] = await db
    .select({ id: runbooks.id, name: runbooks.name, steps: runbooks.steps })
    .from(runbooks)
    .where(
      and(eq(runbooks.organizationId, options.organizationId), eq(runbooks.id, options.runbookId)),
    )
    .limit(1);
  if (!book) throw new RunbookInputError("No such runbook.", 404);

  const steps = (book.steps as RunbookStep[]) ?? [];
  if (steps.length === 0) {
    throw new RunbookInputError("This runbook has no steps yet, so there is nothing to run.");
  }

  const runId = randomUUID();
  await db.transaction(async (tx) => {
    await tx.insert(runbookRuns).values({
      id: runId,
      organizationId: options.organizationId,
      runbookId: book.id,
      // Snapshot, not a join. See the module note.
      runbookName: book.name,
      status: "running",
      incidentId: options.incidentId ?? null,
      startedByUserId: options.userId,
    });
    await tx.insert(runbookRunSteps).values(
      steps.map((step, index) => ({
        id: randomUUID(),
        runId,
        stepId: step.id,
        position: index,
        title: step.title,
        kind: step.kind,
        status: "pending" as const,
      })),
    );
  });

  const run = await getRunbookRun(options.organizationId, runId);
  if (!run) throw new Error("Failed to start the runbook run");
  return run;
}

function toStepWire(row: {
  stepId: string;
  title: string;
  kind: "manual" | "workflow" | "link";
  status: RunbookStepStatus;
  note: string | null;
  workflowRunId: string | null;
  actorUserId: string | null;
  actorName: string | null;
  updatedAt: Date | null;
}): RunbookRunStep {
  return {
    stepId: row.stepId,
    title: row.title,
    kind: row.kind,
    status: row.status,
    note: row.note,
    workflowRunId: row.workflowRunId,
    actorUserId: row.actorUserId,
    actorName: row.actorName,
    updatedAt: row.updatedAt?.toISOString() ?? null,
  };
}

async function loadRunSteps(runId: string): Promise<RunbookRunStep[]> {
  const rows = await db
    .select({
      stepId: runbookRunSteps.stepId,
      title: runbookRunSteps.title,
      kind: runbookRunSteps.kind,
      status: runbookRunSteps.status,
      note: runbookRunSteps.note,
      workflowRunId: runbookRunSteps.workflowRunId,
      actorUserId: runbookRunSteps.actorUserId,
      actorName: users.displayName,
      updatedAt: runbookRunSteps.updatedAt,
    })
    .from(runbookRunSteps)
    .leftJoin(users, eq(users.id, runbookRunSteps.actorUserId))
    .where(eq(runbookRunSteps.runId, runId))
    .orderBy(runbookRunSteps.position);
  return rows.map(toStepWire);
}

export async function getRunbookRun(
  organizationId: string,
  runId: string,
): Promise<RunbookRun | null> {
  const [row] = await db
    .select({
      id: runbookRuns.id,
      runbookId: runbookRuns.runbookId,
      runbookName: runbookRuns.runbookName,
      status: runbookRuns.status,
      incidentId: runbookRuns.incidentId,
      startedByUserId: runbookRuns.startedByUserId,
      startedByName: users.displayName,
      startedAt: runbookRuns.startedAt,
      completedAt: runbookRuns.completedAt,
      summary: runbookRuns.summary,
    })
    .from(runbookRuns)
    .leftJoin(users, eq(users.id, runbookRuns.startedByUserId))
    .where(and(eq(runbookRuns.organizationId, organizationId), eq(runbookRuns.id, runId)))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    runbookId: row.runbookId,
    runbookName: row.runbookName,
    status: row.status,
    incidentId: row.incidentId,
    startedByUserId: row.startedByUserId,
    startedByName: row.startedByName,
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    summary: row.summary,
    steps: await loadRunSteps(row.id),
  };
}

export interface ListRunbookRunsOptions {
  runbookId?: string | undefined;
  incidentId?: string | undefined;
  limit?: number | undefined;
}

/**
 * The org's runs, newest first.
 *
 * Steps are loaded for every returned run rather than lazily, because the list
 * shows each run's progress bar and a page that fetched them one by one would
 * be N+1 requests to render one screen. The limit is what keeps that honest.
 */
export async function listRunbookRuns(
  organizationId: string,
  options: ListRunbookRunsOptions = {},
): Promise<RunbookRun[]> {
  const filters = [eq(runbookRuns.organizationId, organizationId)];
  if (options.runbookId) filters.push(eq(runbookRuns.runbookId, options.runbookId));
  if (options.incidentId) filters.push(eq(runbookRuns.incidentId, options.incidentId));

  const rows = await db
    .select({
      id: runbookRuns.id,
      runbookId: runbookRuns.runbookId,
      runbookName: runbookRuns.runbookName,
      status: runbookRuns.status,
      incidentId: runbookRuns.incidentId,
      startedByUserId: runbookRuns.startedByUserId,
      startedByName: users.displayName,
      startedAt: runbookRuns.startedAt,
      completedAt: runbookRuns.completedAt,
      summary: runbookRuns.summary,
    })
    .from(runbookRuns)
    .leftJoin(users, eq(users.id, runbookRuns.startedByUserId))
    .where(and(...filters))
    .orderBy(desc(runbookRuns.startedAt))
    .limit(Math.min(options.limit ?? 50, 200));

  return Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      runbookId: row.runbookId,
      runbookName: row.runbookName,
      status: row.status,
      incidentId: row.incidentId,
      startedByUserId: row.startedByUserId,
      startedByName: row.startedByName,
      startedAt: row.startedAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
      summary: row.summary,
      steps: await loadRunSteps(row.id),
    })),
  );
}

export interface UpdateRunStepOptions {
  organizationId: string;
  runId: string;
  stepId: string;
  status: RunbookStepStatus;
  note?: string | null | undefined;
  workflowRunId?: string | null | undefined;
  userId: string | null;
}

/**
 * Tick a step.
 *
 * A closed run refuses updates. Reopening is not offered: a run is a record of
 * what happened, and editing one after it was closed out would make the
 * postmortem it feeds unreliable in exactly the way that matters. Start another
 * run instead — which is cheap, and is the honest description of what a second
 * attempt is.
 */
export async function updateRunbookRunStep(options: UpdateRunStepOptions): Promise<RunbookRun> {
  if (options.note != null && options.note.length > MAX_NOTE_LENGTH) {
    throw new RunbookInputError(`A note must be ${MAX_NOTE_LENGTH} characters or fewer.`);
  }

  const [run] = await db
    .select({ id: runbookRuns.id, status: runbookRuns.status })
    .from(runbookRuns)
    .where(
      and(
        eq(runbookRuns.organizationId, options.organizationId),
        eq(runbookRuns.id, options.runId),
      ),
    )
    .limit(1);
  if (!run) throw new RunbookInputError("No such runbook run.", 404);
  if (run.status !== "running") {
    throw new RunbookInputError("This run is closed. Start a new one to record another attempt.");
  }

  const updated = await db
    .update(runbookRunSteps)
    .set({
      status: options.status,
      // `undefined` leaves the note alone, `null` clears it — the PATCH
      // distinction, which matters because ticking a step you already annotated
      // must not silently erase what you wrote.
      ...(options.note !== undefined ? { note: options.note } : {}),
      ...(options.workflowRunId !== undefined ? { workflowRunId: options.workflowRunId } : {}),
      actorUserId: options.userId,
      updatedAt: new Date(),
    })
    .where(
      and(eq(runbookRunSteps.runId, options.runId), eq(runbookRunSteps.stepId, options.stepId)),
    )
    .returning({ id: runbookRunSteps.id });
  if (updated.length === 0) throw new RunbookInputError("No such step in this run.", 404);

  const result = await getRunbookRun(options.organizationId, options.runId);
  if (!result) throw new RunbookInputError("No such runbook run.", 404);
  return result;
}

export interface CloseRunOptions {
  organizationId: string;
  runId: string;
  status: "completed" | "abandoned";
  summary?: string | null | undefined;
}

/**
 * Close a run out.
 *
 * Closing does **not** settle the outstanding steps. A run completed with three
 * steps still pending is a true and useful record — it says the incident ended
 * before the checklist did — and quietly marking them done would erase the one
 * thing a postmortem wants to know.
 */
export async function closeRunbookRun(options: CloseRunOptions): Promise<RunbookRun> {
  if (options.summary != null && options.summary.length > MAX_SUMMARY_LENGTH) {
    throw new RunbookInputError(`A summary must be ${MAX_SUMMARY_LENGTH} characters or fewer.`);
  }
  const closed = await db
    .update(runbookRuns)
    .set({
      status: options.status,
      completedAt: new Date(),
      ...(options.summary !== undefined ? { summary: options.summary } : {}),
    })
    .where(
      and(
        eq(runbookRuns.organizationId, options.organizationId),
        eq(runbookRuns.id, options.runId),
        // Only a running run may be closed, so a double submit cannot rewrite
        // the completion time of a run somebody closed an hour ago.
        eq(runbookRuns.status, "running"),
      ),
    )
    .returning({ id: runbookRuns.id });
  if (closed.length === 0) {
    const existing = await getRunbookRun(options.organizationId, options.runId);
    if (!existing) throw new RunbookInputError("No such runbook run.", 404);
    throw new RunbookInputError("This run is already closed.", 409);
  }
  const result = await getRunbookRun(options.organizationId, options.runId);
  if (!result) throw new RunbookInputError("No such runbook run.", 404);
  return result;
}
