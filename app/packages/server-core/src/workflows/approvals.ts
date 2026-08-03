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
import { sendSlackToOrgTracked } from "../slack";
import {
  recordSlackApprovalMessages,
  slackApprovalButtons,
  updateSlackApprovalMessages,
} from "../slack-approvals";
import { sendMsTeamsToOrg } from "../msteams";
import { sendOneShotPage } from "../twilio-pager";
import { workflowPageCooldownStore } from "./paging";

/** How often the suspended run re-reads its approval row. */
const POLL_INTERVAL_MS = 2500;

/**
 * Reserved `workflow_pages` key for the SMS leg of the approval fan-out.
 *
 * Namespaced with underscores because an author's `infra.page({ key })` is a
 * free-form string: a collision would let a workflow's own paging throttle its
 * approvals (or the reverse), and this shape is not one anybody types.
 */
const APPROVAL_PAGE_KEY = "__approval__";

/**
 * How long one approval SMS suppresses the next for the same workflow.
 *
 * Keyed per **workflow**, not per run, and deliberately: the flood this exists
 * to stop is a workflow that raises approvals in a loop, and the two shapes
 * that takes — one run looping over N items, and a run that keeps being
 * re-triggered — are only both covered by the workflow-wide key. `workflow_pages`
 * is already keyed that way for `infra.page`, for the same reason.
 *
 * Fifteen minutes rather than the hour `infra.page` defaults to: an approval is
 * a live question with a deadline (`DEFAULT_APPROVAL_TIMEOUT_MINUTES` is 60), so
 * a window that is a meaningful fraction of the timeout would mute a second,
 * genuinely different request for most of its life. Fifteen collapses a loop —
 * which fires far faster than that — while a distinct approval raised later
 * still reaches a phone.
 *
 * The *first* request is never suppressed: with no row for the key, the claim
 * is an insert, which always wins.
 */
const APPROVAL_PAGE_COOLDOWN_MINUTES = 15;

/** Which run is asking, threaded from the runner's host extras. */
export interface WorkflowApprovalContext {
  organizationId: string;
  workflowId: string;
  /** Used as the approval title when the author didn't set one. */
  workflowName: string;
  /** The suspended run. Required — an approval must be visible on a run. */
  runId?: string;
  /**
   * What started the run, so the request can say who is asking. The schema has
   * no user on `workflow_runs`, so this is the honest answer available: a
   * person at a keyboard ("manual") reads very differently from a 3am cron.
   */
  triggerSource?: string;
  /** Abort (Stop): expires the pending request and rejects. */
  signal?: AbortSignal;
}

/** Human phrasing for a run's trigger source, for the notification body. */
function requesterText(triggerSource: string | undefined): string {
  switch (triggerSource) {
    case "manual":
      return "started manually by a team member";
    case "cron":
      return "started on its schedule";
    case "git":
      return "started by a Git push";
    case "api":
      return "started over the API";
    case "budget":
      return "started by a budget trigger";
    default:
      return "started by an automated trigger";
  }
}

/**
 * The approvals inbox, or null when the server has no `APP_URL`. Deliberately
 * the inbox rather than the run view: the message exists to get a decision
 * landed, and that is the screen with the buttons on it.
 */
function approvalsUrl(organizationId: string): string | null {
  const base = process.env["APP_URL"];
  if (!base) return null;
  return `${base.replace(/\/$/, "")}/org/${organizationId}/settings/approvals`;
}

function formatExpiry(expiresAt: Date, timeoutMinutes: number): string {
  const unit = timeoutMinutes === 1 ? "minute" : "minutes";
  return `expires in ${timeoutMinutes} ${unit} (${expiresAt.toISOString().replace("T", " ").slice(0, 16)} UTC)`;
}

/**
 * Fan an approval request out over every transport the org has configured.
 *
 * Reuses the `workflowPages` trigger rather than adding a sixth column to three
 * tables, for the reason API pages do: an approval *is* a workflow asking for a
 * human, the opt-in a member or channel already made is the same one, and the
 * user-facing label ("Pages") already covers it. The `workflow_pages` columns
 * on `slack_channels` and `msteams_webhooks` predate this change — only the
 * push transport was wired, which is what the follow-up was about.
 *
 * SMS rides `sendOneShotPage` (the same one-shot path budget alerts and
 * `infra.page` use), SMS-only: an approval blocks a run until a human answers,
 * which is the definition of page-worthy. It is gated by the org's Twilio
 * enabled flag, each recipient's SMS opt-in, and — unlike the other three —
 * a cooldown on {@link APPROVAL_PAGE_KEY}. One message per `waitForApproval`
 * call is not a bound: `waitForApproval` is a call a workflow can make in a
 * loop, and N iterations would be N texts to everyone's phone at whatever rate
 * the loop turns. Voice is not used: `infra.page` makes calls only when the
 * author asks for `voice: true`, and an approval has no such knob, so ringing a
 * phone would be a decision made on the author's behalf.
 *
 * **Only SMS is throttled.** Push, Slack and Teams stay one-per-request on
 * purpose: each approval is a *distinct* decision that blocks the run until
 * someone makes it, and collapsing those messages would hide requests nobody
 * then goes and decides. SMS is the "someone should look now" signal rather
 * than the list — one is enough per window, and it is the leg that costs money
 * and wakes people. The approvals inbox always holds every row regardless of
 * what was or was not delivered.
 *
 * Never throws — every transport swallows its own errors, and a notification
 * outage must not fail the run that is waiting on the decision.
 */
async function notifyApprovalRequest(args: {
  ctx: WorkflowApprovalContext;
  approvalId: string;
  runId: string;
  title: string;
  message: string;
  expiresAt: Date;
  timeoutMinutes: number;
}): Promise<void> {
  const { ctx, approvalId, runId, title, message, expiresAt, timeoutMinutes } = args;
  const requester = requesterText(ctx.triggerSource);
  const expiry = formatExpiry(expiresAt, timeoutMinutes);

  const detail =
    `${message}\n\n` +
    `Workflow: ${ctx.workflowName} · run ${runId}\n` +
    `Requested by: the run, ${requester}\n` +
    `Timeout: ${expiry} — no decision counts as a denial.`;
  const context = `${ctx.workflowName} · run ${runId} · ${expiry}`;
  const url = approvalsUrl(ctx.organizationId);

  await sendPushToOrg(ctx.organizationId, "workflowPages", {
    title: `Approval needed: ${title}`,
    body: message,
    data: {
      type: "workflow_approval",
      orgId: ctx.organizationId,
      workflowId: ctx.workflowId,
      runId,
      approvalId,
    },
  });

  // Slack renders `*bold*`; the Teams Adaptive Card escaper turns `*` into a
  // literal asterisk, so it gets the same text with the markup left out — the
  // split the weekly digest and drift alerts already use. Slack's copy carries
  // Approve/Deny buttons and is tracked so a decision can retire every copy in
  // place — the buttons resolve through `decideWorkflowApproval`, the same
  // conditional UPDATE the web UI uses.
  const slackSent = await sendSlackToOrgTracked(ctx.organizationId, "workflowPages", {
    title: `Approval needed: ${title}`,
    body:
      `*${ctx.workflowName}* needs a decision before run \`${runId}\` can continue.\n\n` + detail,
    context,
    ...(url ? { url } : {}),
    buttons: slackApprovalButtons({
      kind: "workflow",
      approvalId,
      organizationId: ctx.organizationId,
    }),
  });
  try {
    await recordSlackApprovalMessages(
      ctx.organizationId,
      "workflow",
      approvalId,
      slackSent.messages,
      // The decided/expired rendering, should the recorder find the request
      // already settled: the same title/body every later update uses.
      { title: `Approval needed: ${title}`, body: message },
    );
  } catch (err) {
    // Losing the refs only costs the in-place update later; the buttons still
    // work, so this must not fail the fan-out.
    console.error(`[approvals] recording Slack messages for ${approvalId} failed:`, err);
  }
  await sendMsTeamsToOrg(ctx.organizationId, "workflowPages", {
    title: `Approval needed: ${title}`,
    body: `${ctx.workflowName} needs a decision before run ${runId} can continue.\n\n` + detail,
    context,
    ...(url ? { url } : {}),
  });

  await pageAboutApproval(
    ctx,
    `infrawrench approval needed: ${title} — ${message} (${ctx.workflowName}, ${expiry})`,
  );
}

/**
 * The SMS leg, behind the workflow's approval cooldown.
 *
 * Same protocol as `paging/deliver.ts`: read the prior row, take the slot with
 * one conditional statement (so two replicas racing the same window still text
 * once), and roll the claim back when the message reached nobody — an SMS
 * nobody received must not start a quiet period. A losing claim is silence, not
 * an error: the request is already in the inbox and the other three transports
 * have already carried it.
 */
async function pageAboutApproval(ctx: WorkflowApprovalContext, body: string): Promise<void> {
  const store = workflowPageCooldownStore(
    {
      organizationId: ctx.organizationId,
      workflowId: ctx.workflowId,
      workflowName: ctx.workflowName,
      ...(ctx.runId ? { runId: ctx.runId } : {}),
    },
    APPROVAL_PAGE_KEY,
  );
  const prior = await store.read();
  if (!(await store.claim(body, APPROVAL_PAGE_COOLDOWN_MINUTES))) return;

  const sms = await sendOneShotPage(ctx.organizationId, body);
  if (sms.succeeded === 0) await store.release(prior);
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

/**
 * Mark a still-pending request expired; a landed decision wins the race. When
 * the expiry wins, every tracked Slack copy is rewritten too — buttons off,
 * "expired" shown — so a channel never keeps offering a decision the run
 * already stopped listening for. Fire-and-forget: the updater never throws.
 */
async function expirePending(approvalId: string): Promise<void> {
  const [expired] = await db
    .update(workflowApprovals)
    .set({ status: "expired", decidedAt: new Date() })
    .where(and(eq(workflowApprovals.id, approvalId), eq(workflowApprovals.status, "pending")))
    .returning();
  if (!expired) return;
  void updateSlackApprovalMessages(expired.organizationId, "workflow", approvalId, {
    decision: "expired",
    decidedByName: null,
    title: `Approval needed: ${expired.title}`,
    body: expired.message,
  });
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

  // Notify every transport the org has configured, under the workflowPages
  // opt-in. Each of them already swallows its own errors; the outer catch is
  // the belt to that braces, because the request is *already recorded* by this
  // point — the approvals inbox can decide it whether or not anyone was told,
  // so failing the run over a notification would be strictly worse.
  try {
    await notifyApprovalRequest({
      ctx,
      approvalId,
      runId: ctx.runId,
      title,
      message: spec.message,
      expiresAt,
      timeoutMinutes,
    });
  } catch (err) {
    console.error(`[approvals] notifying about approval ${approvalId} failed:`, err);
  }

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
  opts: {
    /** Where the decision came from, for the Slack message update. */
    decidedVia?: "Slack" | "the web app";
  } = {},
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
    // The Slack copies must land on "expired" here too — this path is the one
    // where the run's poll never gets to call expirePending (the row left
    // `pending` under the late approval), so nothing else retires them.
    void updateSlackApprovalMessages(organizationId, "workflow", approvalId, {
      decision: "expired",
      decidedByName: decidedBy.name ?? null,
      via: opts.decidedVia ?? "the web app",
      title: `Approval needed: ${updated.title}`,
      body: updated.message,
    });
    return { outcome: "conflict" };
  }
  // Retire any interactive Slack copies of this request: buttons off, outcome
  // and decider shown in place, threaded reply for the channel's history.
  // Fire-and-forget (the updater never throws) — the decision is already
  // landed, and a Slack outage must not turn it into an error.
  void updateSlackApprovalMessages(organizationId, "workflow", approvalId, {
    decision,
    decidedByName: decidedBy.name ?? null,
    via: opts.decidedVia ?? "the web app",
    title: `Approval needed: ${updated.title}`,
    body: updated.message,
  });
  return { outcome: "decided", approval: toSummary(updated, null) };
}
