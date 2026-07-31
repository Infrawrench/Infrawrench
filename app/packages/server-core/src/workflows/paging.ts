/**
 * Cloud delivery for `infra.page(...)`.
 *
 * A workflow raises an alert; this module supplies the cooldown row and the
 * deep links, and `paging/deliver.ts` does the rest — the cooldown protocol and
 * the fan-out over Twilio, mobile push, Slack, and Microsoft Teams, shared with
 * pages a server raises over the HTTP API.
 *
 * The cooldown is a row in `workflow_pages` keyed by (workflow, page key), and
 * the claim is a single conditional upsert: whoever wins the statement sends,
 * everyone else is suppressed. That is what stops two poller replicas running
 * the same cron from double-paging.
 */
import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import type { PageResult, PageSpec } from "@infrawrench/workflow-runtime";

import { db } from "../db/client";
import { workflowPages } from "../db/schema";
import {
  appBaseUrl,
  deliverPage,
  pageKeyAndCooldown,
  type PageAudience,
  type PageCooldownStore,
  type PriorPage,
} from "../paging/deliver";

/** Which workflow (and run) is raising the alert. */
export interface WorkflowPageContext {
  organizationId: string;
  workflowId: string;
  /** Used as the notification title when the author didn't set one. */
  workflowName: string;
  /** The run raising the page, so the mobile deep link can open its logs. */
  runId?: string;
}

/**
 * The `workflow_pages` row for one (workflow, key) pair.
 *
 * Exported because `infra.page` is not the only thing a workflow can emit that
 * needs damping: `workflows/approvals.ts` throttles the SMS leg of its approval
 * fan-out on a reserved key in this same table, so that a looping workflow
 * cannot turn one approval gate into fifty text messages. Same row, same
 * conditional-claim protocol, different key.
 */
export function workflowPageCooldownStore(
  ctx: WorkflowPageContext,
  key: string,
): PageCooldownStore {
  const where = and(eq(workflowPages.workflowId, ctx.workflowId), eq(workflowPages.key, key));
  return {
    async read(): Promise<PriorPage | null> {
      const [row] = await db
        .select({ lastPagedAt: workflowPages.lastPagedAt })
        .from(workflowPages)
        .where(where)
        .limit(1);
      return row ?? null;
    },

    // The `setWhere` predicate reads the *existing* row, so a losing replica
    // gets no row back and reports the page as suppressed.
    async claim(message: string, cooldownMinutes: number): Promise<boolean> {
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
    },

    async release(prior: PriorPage | null): Promise<void> {
      if (prior) {
        await db.update(workflowPages).set({ lastPagedAt: prior.lastPagedAt }).where(where);
        return;
      }
      await db.delete(workflowPages).where(where);
    },
  };
}

/** Deep link to the workflow, for the Slack and Teams message buttons. */
function workflowUrl(ctx: WorkflowPageContext): string | null {
  const base = appBaseUrl();
  return base ? `${base}/org/${ctx.organizationId}/workflows/${ctx.workflowId}` : null;
}

function audienceFor(ctx: WorkflowPageContext): PageAudience {
  return {
    organizationId: ctx.organizationId,
    name: ctx.workflowName,
    context: `Workflow: ${ctx.workflowName}`,
    url: workflowUrl(ctx),
    pushData: {
      type: "workflow_page",
      orgId: ctx.organizationId,
      workflowId: ctx.workflowId,
      ...(ctx.runId ? { runId: ctx.runId } : {}),
    },
  };
}

/**
 * Deliver one `infra.page(...)`, honoring the key's cooldown. Never throws:
 * a paging outage must not fail the workflow that reported the problem.
 */
export async function pageFromWorkflow(
  ctx: WorkflowPageContext,
  spec: PageSpec,
): Promise<PageResult> {
  const { key } = pageKeyAndCooldown(spec);
  return deliverPage(audienceFor(ctx), workflowPageCooldownStore(ctx, key), spec);
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
