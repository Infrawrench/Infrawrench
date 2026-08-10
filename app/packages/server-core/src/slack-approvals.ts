/**
 * Interactive Slack approval messages.
 *
 * An approval request — a workflow suspended on `infra.waitForApproval`, the
 * chat agent waiting on a destructive tool call, or a member asking for
 * break-glass access — goes out to Slack with Approve/Deny buttons. This module owns the shared halves of that flow:
 *
 *  - the buttons themselves (`slackApprovalButtons`) and the opaque `value`
 *    payload a click echoes back;
 *  - remembering where each copy of the message landed
 *    (`recordSlackApprovalMessages` → `slack_approval_messages`), because a
 *    request fans out to every opted-in channel and a decision must retire
 *    *all* of them, not just the one that was clicked;
 *  - rewriting those messages once a decision lands
 *    (`updateSlackApprovalMessages`): buttons removed, outcome and decider
 *    shown in place, and a threaded reply for the channel's history.
 *
 * The decision itself never happens here. Buttons resolve through exactly the
 * code path the web UI uses (`decideWorkflowApproval`, the chat pending-action
 * transitions), so the atomic "one decision wins" semantics live there and
 * here is only presentation.
 */
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { db } from "./db/client";
import {
  accessRequests,
  chatPendingActions,
  slackApprovalMessages,
  workflowApprovals,
} from "./db/schema";
import {
  escapeMrkdwn,
  loadOrgSlackTokens,
  postSlackThreadReply,
  updateSlackMessage,
  type SlackMessageButton,
  type SlackPostedMessage,
} from "./slack";

/** Which table the approval id points at. */
export type SlackApprovalKind = "workflow" | "chat" | "access";

export const SLACK_APPROVE_ACTION_ID = "infrawrench_approval_approve";
export const SLACK_DENY_ACTION_ID = "infrawrench_approval_deny";
/** Disambiguation buttons for `/infrawrench status` (not an approval). */
export const SLACK_STATUS_PICK_ACTION_ID = "infrawrench_status_pick";

export interface SlackApprovalButtonValue {
  kind: SlackApprovalKind;
  approvalId: string;
  organizationId: string;
}

/** The Approve/Deny pair for one approval request. */
export function slackApprovalButtons(value: SlackApprovalButtonValue): SlackMessageButton[] {
  const v = JSON.stringify({ k: value.kind, a: value.approvalId, o: value.organizationId });
  return [
    { text: "Approve", actionId: SLACK_APPROVE_ACTION_ID, value: v, style: "primary" },
    { text: "Deny", actionId: SLACK_DENY_ACTION_ID, value: v, style: "danger" },
  ];
}

/** Parse a button's echoed `value`; null for anything malformed. */
export function parseSlackApprovalButtonValue(raw: unknown): SlackApprovalButtonValue | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw) as { k?: string; a?: string; o?: string };
    if (
      (parsed.k !== "workflow" && parsed.k !== "chat" && parsed.k !== "access") ||
      !parsed.a ||
      !parsed.o
    ) {
      return null;
    }
    return { kind: parsed.k, approvalId: parsed.a, organizationId: parsed.o };
  } catch {
    return null;
  }
}

/**
 * The current decided state of an approval, or null while it is still open.
 *
 * A chat action that is `approved` but not yet executed counts as open: the
 * decision paths call `updateSlackApprovalMessages` again once execution
 * settles, so the buttons still get retired.
 */
async function decidedApprovalState(
  kind: SlackApprovalKind,
  approvalId: string,
): Promise<{ decision: SlackApprovalOutcome["decision"]; decidedByName: string | null } | null> {
  if (kind === "workflow") {
    const [row] = await db
      .select({ status: workflowApprovals.status, decidedByName: workflowApprovals.decidedByName })
      .from(workflowApprovals)
      .where(eq(workflowApprovals.id, approvalId))
      .limit(1);
    if (!row || row.status === "pending") return null;
    return {
      decision:
        row.status === "approved" ? "approved" : row.status === "denied" ? "denied" : "expired",
      decidedByName: row.decidedByName ?? null,
    };
  }
  if (kind === "access") {
    const [row] = await db
      .select({ status: accessRequests.status, decidedByName: accessRequests.decidedByName })
      .from(accessRequests)
      .where(eq(accessRequests.id, approvalId))
      .limit(1);
    if (!row || row.status === "pending") return null;
    return {
      decision:
        row.status === "approved" ? "approved" : row.status === "denied" ? "denied" : "expired",
      decidedByName: row.decidedByName ?? null,
    };
  }
  const [row] = await db
    .select({ status: chatPendingActions.status })
    .from(chatPendingActions)
    .where(eq(chatPendingActions.id, approvalId))
    .limit(1);
  if (!row || row.status === "pending" || row.status === "approved") return null;
  // `executed` and `errored` both mean an approval was claimed and ran.
  return { decision: row.status === "rejected" ? "denied" : "approved", decidedByName: null };
}

/**
 * Remember where an approval request's messages landed, for later updates.
 *
 * `rendered` is the request's headline/body as the poster rendered it, so the
 * reconciliation below can retire the copies without re-deriving the text.
 * The reconciliation closes a race: a decision that lands *while the Slack
 * post is in flight* fires `updateSlackApprovalMessages` before these rows
 * exist, and without the re-check the freshly posted copies would keep live
 * buttons forever. Re-reading the approval after the insert converges: either
 * the decision's update saw our rows, or we see the decision here.
 */
export async function recordSlackApprovalMessages(
  organizationId: string,
  kind: SlackApprovalKind,
  approvalId: string,
  messages: SlackPostedMessage[],
  rendered: { title: string; body: string },
): Promise<void> {
  if (messages.length === 0) return;
  await db.insert(slackApprovalMessages).values(
    messages.map((m) => ({
      id: randomUUID(),
      organizationId,
      kind,
      approvalId,
      installationId: m.installationId,
      channelId: m.channelId,
      messageTs: m.ts,
    })),
  );
  const decided = await decidedApprovalState(kind, approvalId);
  if (decided) {
    await updateSlackApprovalMessages(organizationId, kind, approvalId, {
      ...decided,
      title: rendered.title,
      body: rendered.body,
    });
  }
}

export interface SlackApprovalOutcome {
  decision: "approved" | "denied" | "expired";
  decidedByName: string | null;
  /** Where the decision landed — "Slack" or "the web app". Unknown for expiry. */
  via?: string;
  /** The request's original headline and body, re-rendered without buttons. */
  title: string;
  body: string;
}

function outcomeLine(outcome: SlackApprovalOutcome): string {
  if (outcome.decision === "expired") {
    // A named decider here means their approval landed after the timeout —
    // the run treats that as expired, so the message must say so too.
    const late = outcome.decidedByName
      ? ` (${outcome.decidedByName}'s approval${outcome.via ? ` via ${outcome.via}` : ""} came after the timeout)`
      : "";
    return `⏳ Expired — not decided within the timeout${late}`;
  }
  const verb = outcome.decision === "approved" ? "Approved" : "Denied";
  const glyph = outcome.decision === "approved" ? "✅" : "🚫";
  const who = outcome.decidedByName ? ` by ${outcome.decidedByName}` : "";
  return `${glyph} ${verb}${who}${outcome.via ? ` via ${outcome.via}` : ""}`;
}

/**
 * Rewrite every copy of an approval request to its decided form and thread the
 * outcome under each. Never throws — the decision is already recorded, and a
 * Slack outage must not make it look like it wasn't. Called after *any*
 * decision (button or web UI), so a message whose buttons nobody pressed still
 * stops offering them.
 */
export async function updateSlackApprovalMessages(
  organizationId: string,
  kind: SlackApprovalKind,
  approvalId: string,
  outcome: SlackApprovalOutcome,
): Promise<void> {
  try {
    const rows = await db
      .select()
      .from(slackApprovalMessages)
      .where(
        and(
          eq(slackApprovalMessages.organizationId, organizationId),
          eq(slackApprovalMessages.kind, kind),
          eq(slackApprovalMessages.approvalId, approvalId),
        ),
      );
    if (rows.length === 0) return;

    const tokens = await loadOrgSlackTokens(organizationId);
    const line = outcomeLine(outcome);
    const text = `${outcome.title} — ${line}`;
    const blocks: unknown[] = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${escapeMrkdwn(outcome.title)}*\n${escapeMrkdwn(outcome.body)}`,
        },
      },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: escapeMrkdwn(line) }],
      },
    ];

    const settled = await Promise.allSettled(
      rows.map(async (row) => {
        const token = tokens.get(row.installationId);
        if (!token) return;
        await updateSlackMessage(token, row.channelId, row.messageTs, text, blocks);
        await postSlackThreadReply(token, row.channelId, row.messageTs, line);
      }),
    );
    for (const s of settled) {
      if (s.status === "rejected") {
        console.error(`[slack] updating approval message for ${kind} ${approvalId}:`, s.reason);
      }
    }
  } catch (err) {
    console.error(`[slack] approval-message update failed for ${kind} ${approvalId}:`, err);
  }
}
