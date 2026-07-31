/**
 * Human-approval gates for workflow runs (`infra.waitForApproval(...)`).
 *
 * The run's worker inserts a `pending` `workflow_approvals` row, notifies the
 * org through the push pipeline, and then blocks the (paused) host call by
 * polling the row until a decision lands or the timeout passes. Timeout counts
 * as a denial; denial and timeout reject, which fails the step unless the
 * author catches it.
 *
 * Why poll rather than suspend the isolate: a run is a single in-process
 * awaited promise (QuickJS asyncify) — there is no snapshot/resume of a
 * half-executed guest, and the poll rides the same pause-aware budget
 * (`PAUSED_METHODS`) that already keeps `infra.prompt()` and long SSH waits
 * from eating the run's execution time. Decisions land over plain HTTP on any
 * web replica; the DB row is the rendezvous.
 */
import { and, desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import {
  DEFAULT_APPROVAL_TIMEOUT_MINUTES,
  type ApprovalResult,
  type ApprovalSpec,
} from "@infrawrench/workflow-runtime";

import { db } from "../db/client";
import { workflowApprovals, workflows } from "../db/schema";
import { sendPushToOrg } from "../push/dispatch";

/** How often the suspended run re-reads its approval row. */
const POLL_INTERVAL_MS = 2500;

/** Which run is asking, threaded from the runner's host extras. */
export interface WorkflowApprovalContext {
  organizationId: string;
  workflowId: string;
  /** Used as the approval title when the author didn't set one. */
  workflowName: string;
  /** The suspended run. Required — an approval must be visible on a run. */
  runId?: string;
  /** Abort (Stop): expires the pending request and rejects. */
  signal?: AbortSignal;
}

export type WorkflowApprovalStatus = "pending" | "approved" | "denied" | "expired";

/** One approval row, shaped for the HTTP API and the run view. */
export interface WorkflowApprovalSummary {
  id: string;
  workflowId: string;
  workflowName: string | null;
  runId: string;
  title: string;
  message: string;
  status: WorkflowApprovalStatus;
  expiresAt: string;
  decidedAt: string | null;
  decidedByName: string | null;
  createdAt: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Mark a still-pending request expired; a landed decision wins the race. */
async function expirePending(approvalId: string): Promise<void> {
  await db
    .update(workflowApprovals)
    .set({ status: "expired", decidedAt: new Date() })
    .where(and(eq(workflowApprovals.id, approvalId), eq(workflowApprovals.status, "pending")));
}

/**
 * Raise an approval request and block until it is decided. Powers the host's
 * `waitForApproval`. Resolves only on approval; denial, timeout, and Stop all
 * reject, so an unhandled deny fails the run.
 */
export async function requestApprovalAndWait(
  ctx: WorkflowApprovalContext,
  spec: ApprovalSpec,
): Promise<ApprovalResult> {
  if (!ctx.runId) {
    throw new Error("infra.waitForApproval() is only available inside a persisted workflow run.");
  }
  const approvalId = randomUUID();
  const timeoutMinutes = spec.timeoutMinutes ?? DEFAULT_APPROVAL_TIMEOUT_MINUTES;
  const title = spec.title ?? ctx.workflowName;
  const expiresAt = new Date(Date.now() + timeoutMinutes * 60_000);

  await db.insert(workflowApprovals).values({
    id: approvalId,
    organizationId: ctx.organizationId,
    workflowId: ctx.workflowId,
    runId: ctx.runId,
    title,
    message: spec.message,
    status: "pending",
    expiresAt,
  });

  // Notify through the existing push pipeline. Reuses the workflowPages
  // opt-in category (an approval is a workflow asking for a human, like a
  // page); sendPushToOrg never throws, so a push outage can't fail the run.
  await sendPushToOrg(ctx.organizationId, "workflowPages", {
    title: `Approval needed: ${title}`,
    body: spec.message,
    data: {
      type: "workflow_approval",
      orgId: ctx.organizationId,
      workflowId: ctx.workflowId,
      runId: ctx.runId,
      approvalId,
    },
  });

  for (;;) {
    if (ctx.signal?.aborted) {
      await expirePending(approvalId);
      throw new Error("Workflow stopped.");
    }
    const [row] = await db
      .select()
      .from(workflowApprovals)
      .where(eq(workflowApprovals.id, approvalId))
      .limit(1);
    if (!row) {
      throw new Error(`Approval request "${title}" disappeared while waiting for a decision.`);
    }
    if (row.status === "approved") {
      return {
        approved: true,
        ...(row.decidedByName ? { decidedBy: row.decidedByName } : {}),
        ...(row.decidedAt ? { decidedAt: row.decidedAt.toISOString() } : {}),
      };
    }
    if (row.status === "denied") {
      throw new Error(
        `Approval request "${title}" was denied` +
          (row.decidedByName ? ` by ${row.decidedByName}.` : "."),
      );
    }
    if (row.status === "expired" || row.expiresAt.getTime() <= Date.now()) {
      await expirePending(approvalId);
      throw new Error(
        `Approval request "${title}" was not decided within ${timeoutMinutes} ` +
          `minute${timeoutMinutes === 1 ? "" : "s"} and was denied.`,
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

function toSummary(
  row: typeof workflowApprovals.$inferSelect,
  workflowName: string | null,
): WorkflowApprovalSummary {
  return {
    id: row.id,
    workflowId: row.workflowId,
    workflowName,
    runId: row.runId,
    title: row.title,
    message: row.message,
    status: row.status as WorkflowApprovalStatus,
    expiresAt: row.expiresAt.toISOString(),
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    decidedByName: row.decidedByName ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * List an org's approval requests, newest first. A `pending` listing hides
 * rows whose timeout has already passed but whose run hasn't marked them yet
 * (the poll loop owns that transition), so the UI never offers a decision the
 * run would ignore.
 */
export async function listWorkflowApprovals(
  organizationId: string,
  opts: {
    status?: WorkflowApprovalStatus;
    workflowId?: string;
    runId?: string;
    limit?: number;
  } = {},
): Promise<WorkflowApprovalSummary[]> {
  const conditions = [eq(workflowApprovals.organizationId, organizationId)];
  if (opts.status) conditions.push(eq(workflowApprovals.status, opts.status));
  if (opts.workflowId) conditions.push(eq(workflowApprovals.workflowId, opts.workflowId));
  if (opts.runId) conditions.push(eq(workflowApprovals.runId, opts.runId));
  const rows = await db
    .select({ approval: workflowApprovals, workflowName: workflows.name })
    .from(workflowApprovals)
    .leftJoin(workflows, eq(workflowApprovals.workflowId, workflows.id))
    .where(and(...conditions))
    .orderBy(desc(workflowApprovals.createdAt))
    .limit(Math.min(Math.max(opts.limit ?? 50, 1), 200));
  const now = Date.now();
  return rows
    .filter(
      (r) =>
        opts.status !== "pending" ||
        (r.approval.status === "pending" && r.approval.expiresAt.getTime() > now),
    )
    .map((r) => toSummary(r.approval, r.workflowName ?? null));
}

/**
 * Record a decision. The conditional UPDATE (`status = 'pending'` and not yet
 * expired) is what makes two members racing the same request produce exactly
 * one decision — the loser gets `"conflict"` back and the UI refreshes.
 */
export async function decideWorkflowApproval(
  organizationId: string,
  approvalId: string,
  decision: "approved" | "denied",
  decidedBy: { userId: string; name?: string | null },
): Promise<
  | { outcome: "decided"; approval: WorkflowApprovalSummary }
  | { outcome: "conflict" }
  | { outcome: "not_found" }
> {
  const [existing] = await db
    .select({ id: workflowApprovals.id })
    .from(workflowApprovals)
    .where(
      and(
        eq(workflowApprovals.id, approvalId),
        eq(workflowApprovals.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!existing) return { outcome: "not_found" };

  const now = new Date();
  const [updated] = await db
    .update(workflowApprovals)
    .set({
      status: decision,
      decidedAt: now,
      decidedByUserId: decidedBy.userId,
      decidedByName: decidedBy.name ?? null,
    })
    .where(
      and(
        eq(workflowApprovals.id, approvalId),
        eq(workflowApprovals.organizationId, organizationId),
        eq(workflowApprovals.status, "pending"),
      ),
    )
    .returning();
  if (!updated) return { outcome: "conflict" };
  // Deciding after the timeout passed but before the run's poll marked the row
  // is still a conflict: the run will treat it as expired, so don't pretend.
  if (updated.expiresAt.getTime() <= now.getTime() && decision === "approved") {
    await db
      .update(workflowApprovals)
      .set({ status: "expired" })
      .where(eq(workflowApprovals.id, approvalId));
    return { outcome: "conflict" };
  }
  return { outcome: "decided", approval: toSummary(updated, null) };
}
