/**
 * Cloud delivery for `infra.page(...)`.
 *
 * A workflow raises an alert; this module decides whether it is still in
 * cooldown and, if not, fans it out over the same transports the sync-failure
 * pager and budget alerts already use — Twilio SMS (plus voice on request),
 * mobile push, and any Slack or Microsoft Teams channel opted into workflow
 * pages.
 *
 * The cooldown is a row in `workflow_pages` keyed by (workflow, page key), and
 * the claim is a single conditional upsert: whoever wins the statement sends,
 * everyone else is suppressed. That is what stops two poller replicas running
 * the same cron from double-paging. As in twilio-pager.ts, the claim is rolled
 * back when every transport failed, so a page nobody received doesn't start a
 * cooldown.
 */
import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import {
  DEFAULT_PAGE_COOLDOWN_MINUTES,
  DEFAULT_PAGE_KEY,
  type PageResult,
  type PageSpec,
} from "@infrawrench/workflow-runtime";

import { db } from "../db/client";
import { workflowPages } from "../db/schema";
import { sendPushToOrg } from "../push/dispatch";
import { sendSlackToOrg } from "../slack";
import { sendMsTeamsToOrg } from "../msteams";
import { sendOneShotPage } from "../twilio-pager";

/** Which workflow (and run) is raising the alert. */
export interface WorkflowPageContext {
  organizationId: string;
  workflowId: string;
  /** Used as the notification title when the author didn't set one. */
  workflowName: string;
  /** The run raising the page, so the mobile deep link can open its logs. */
  runId?: string;
}

interface PriorPage {
  lastPagedAt: Date;
}

async function readPrior(workflowId: string, key: string): Promise<PriorPage | null> {
  const [row] = await db
    .select({ lastPagedAt: workflowPages.lastPagedAt })
    .from(workflowPages)
    .where(and(eq(workflowPages.workflowId, workflowId), eq(workflowPages.key, key)))
    .limit(1);
  return row ?? null;
}

/**
 * Try to take the cooldown slot for this key. Inserts the row when the key has
 * never paged, and otherwise updates it only when the cooldown has elapsed —
 * the `setWhere` predicate reads the *existing* row, so a losing replica gets
 * no row back and reports the page as suppressed.
 */
async function claimSlot(
  ctx: WorkflowPageContext,
  key: string,
  message: string,
  cooldownMinutes: number,
): Promise<boolean> {
  const now = new Date();
  const claimed = await db
    .insert(workflowPages)
    .values({
      id: randomUUID(),
      organizationId: ctx.organizationId,
      workflowId: ctx.workflowId,
      key,
      lastPagedAt: now,
      lastMessage: message,
    })
    .onConflictDoUpdate({
      target: [workflowPages.workflowId, workflowPages.key],
      set: { lastPagedAt: now, lastMessage: message },
      setWhere: sql`${workflowPages.lastPagedAt} <= now() - (${cooldownMinutes}::double precision * interval '1 minute')`,
    })
    .returning({ id: workflowPages.id });
  return claimed.length > 0;
}

/** Undo a claim whose page reached nobody, so the next run tries again. */
async function releaseSlot(
  workflowId: string,
  key: string,
  prior: PriorPage | null,
): Promise<void> {
  if (prior) {
    await db
      .update(workflowPages)
      .set({ lastPagedAt: prior.lastPagedAt })
      .where(and(eq(workflowPages.workflowId, workflowId), eq(workflowPages.key, key)));
    return;
  }
  await db
    .delete(workflowPages)
    .where(and(eq(workflowPages.workflowId, workflowId), eq(workflowPages.key, key)));
}

/** SMS body: short, prefixed, and says which workflow is talking. */
function smsBody(ctx: WorkflowPageContext, spec: PageSpec): string {
  return `infrawrench: ${spec.title ?? ctx.workflowName} — ${spec.message}`;
}

/**
 * Deliver one `infra.page(...)`, honoring the key's cooldown. Never throws:
 * a paging outage must not fail the workflow that reported the problem.
 */
export async function pageFromWorkflow(
  ctx: WorkflowPageContext,
  spec: PageSpec,
): Promise<PageResult> {
  const key = spec.key || DEFAULT_PAGE_KEY;
  const cooldownMinutes = Math.max(0, spec.cooldownMinutes ?? DEFAULT_PAGE_COOLDOWN_MINUTES);

  const prior = await readPrior(ctx.workflowId, key);
  const claimed = await claimSlot(ctx, key, spec.message, cooldownMinutes);
  if (!claimed) {
    // Only a prior row can block the claim, so `prior` is set here in practice;
    // fall back to "now" rather than reporting a retryAt we can't compute.
    const since = prior?.lastPagedAt ?? new Date();
    return {
      delivered: false,
      suppressed: true,
      sms: 0,
      push: 0,
      slack: 0,
      msTeams: 0,
      retryAt: new Date(since.getTime() + cooldownMinutes * 60_000).toISOString(),
    };
  }

  const twilio = await sendOneShotPage(ctx.organizationId, smsBody(ctx, spec), {
    ...(spec.voice ? { voice: true } : {}),
  });
  const push = await sendPushToOrg(ctx.organizationId, "workflowPages", {
    title: spec.title ?? ctx.workflowName,
    body: spec.message,
    data: {
      type: "workflow_page",
      orgId: ctx.organizationId,
      workflowId: ctx.workflowId,
      ...(ctx.runId ? { runId: ctx.runId } : {}),
    },
  });
  const url = workflowUrl(ctx);
  const slack = await sendSlackToOrg(ctx.organizationId, "workflowPages", {
    title: spec.title ?? ctx.workflowName,
    body: spec.message,
    context: `Workflow: ${ctx.workflowName}`,
    ...(url ? { url } : {}),
  });

  const msTeams = await sendMsTeamsToOrg(ctx.organizationId, "workflowPages", {
    title: spec.title ?? ctx.workflowName,
    body: spec.message,
    context: `Workflow: ${ctx.workflowName}`,
    ...(url ? { url } : {}),
  });

  const delivered = twilio.succeeded + push.succeeded + slack.succeeded + msTeams.succeeded > 0;
  if (!delivered) {
    await releaseSlot(ctx.workflowId, key, prior);
  }
  return {
    delivered,
    suppressed: false,
    sms: twilio.succeeded,
    push: push.succeeded,
    slack: slack.succeeded,
    msTeams: msTeams.succeeded,
  };
}

/** Deep link to the workflow, for the Slack and Teams message buttons. */
function workflowUrl(ctx: WorkflowPageContext): string | null {
  const base = process.env["APP_URL"] ?? process.env["NEXT_PUBLIC_APP_URL"];
  if (!base) return null;
  return `${base.replace(/\/$/, "")}/org/${ctx.organizationId}/workflows/${ctx.workflowId}`;
}

/**
 * Drop a key's cooldown row so its next page delivers immediately. Called by
 * `infra.page.clear(key)` when a workflow sees the condition recover.
 */
export async function clearWorkflowPage(workflowId: string, key: string): Promise<void> {
  await db
    .delete(workflowPages)
    .where(and(eq(workflowPages.workflowId, workflowId), eq(workflowPages.key, key)));
}
