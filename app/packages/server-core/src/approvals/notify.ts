/**
 * The approval fan-out, shared by every kind of approval request.
 *
 * Extracted from `workflows/approvals.ts` when break-glass access requests
 * became the second caller. The mechanics are genuinely the same regardless of
 * what is being approved: push, Slack (with Approve/Deny buttons, tracked so a
 * decision can retire every copy in place), Microsoft Teams (same text without
 * the markup — the Adaptive Card escaper turns `*` into a literal asterisk),
 * and an SMS behind a cooldown. What differs is only the wording and where the
 * link points, so those are the parameters.
 *
 * **Never throws.** Every transport swallows its own errors and the caller
 * wraps this anyway: by the time this runs the request is already recorded, so
 * the inbox can decide it whether or not anyone was told. Failing the caller
 * over a notification outage would be strictly worse.
 *
 * On the trigger: everything here rides the `workflowPages` opt-in. That is
 * the argument the workflow approvals already made — an approval is something
 * asking for a human, the opt-in a member or channel already made is the same
 * one, and the user-facing label ("Pages") already covers it. A break-glass
 * request is if anything more page-worthy than a workflow gate: someone is
 * asking for authority they do not have, right now.
 */
import { routeAlert } from "../alerts/route";
import {
  recordSlackApprovalMessages,
  slackApprovalButtons,
  type SlackApprovalKind,
} from "../slack-approvals";
import type { PushData } from "../push/types";

export interface ApprovalFanOut {
  organizationId: string;
  /** Which table `approvalId` points at; also what a Slack button echoes back. */
  kind: SlackApprovalKind;
  approvalId: string;
  /** Short headline, rendered as "Approval needed: {title}". */
  title: string;
  /** What the approver is deciding. */
  message: string;
  /**
   * Lines appended under `message` in the Slack/Teams/push detail — who is
   * asking, what for, when it lapses. Caller-owned because "run 41f, started
   * on its schedule" and "Dana, for 30 minutes" are not the same sentence.
   */
  detailLines: string[];
  /** One-line context shown under the message body. */
  context: string;
  /** Deep link to the screen with the buttons on it; null without APP_URL. */
  url: string | null;
  /** Mobile push payload. */
  push: PushData;
  /** Slack lead-in above the detail, e.g. "*X* needs a decision …". */
  slackLead: string;
  /** Teams lead-in; the same sentence without Slack's markup. */
  teamsLead: string;
}

/** Human phrasing for a request's deadline, shared by every transport. */
export function formatApprovalExpiry(expiresAt: Date, timeoutMinutes: number): string {
  const unit = timeoutMinutes === 1 ? "minute" : "minutes";
  return `expires in ${timeoutMinutes} ${unit} (${expiresAt.toISOString().replace("T", " ").slice(0, 16)} UTC)`;
}

/**
 * Deliver one approval request over push, Slack and Teams.
 *
 * The SMS leg is *not* here: it is throttled per caller on a key only the
 * caller knows (a workflow id, an org), and the two callers' cooldown stories
 * differ enough that folding them in would take more parameters than it saved.
 *
 * Push, Slack and Teams stay one-message-per-request on purpose: each approval
 * is a distinct decision that blocks someone until it is made, and collapsing
 * those would hide requests nobody then goes and decides.
 */
export async function fanOutApprovalRequest(args: ApprovalFanOut): Promise<void> {
  const detail =
    args.detailLines.length > 0
      ? `${args.message}\n\n${args.detailLines.join("\n")}`
      : args.message;
  const heading = `Approval needed: ${args.title}`;

  // Quiet hours must not hold an approval: a timeout with no decision is a
  // denial, so parking the request until morning would silently deny it.
  const routed = await routeAlert(
    {
      organizationId: args.organizationId,
      trigger: "workflowPages",
      title: heading,
      body: `${args.slackLead}\n\n${detail}`,
      teamsBody: `${args.teamsLead}\n\n${detail}`,
      pushBody: args.message,
      context: args.context,
      ...(args.url ? { url: args.url } : {}),
      pushData: args.push,
      facts: { key: args.kind },
    },
    {
      track: true,
      bypassQuietHours: true,
      slackButtons: slackApprovalButtons({
        kind: args.kind,
        approvalId: args.approvalId,
        organizationId: args.organizationId,
      }),
    },
  );
  try {
    await recordSlackApprovalMessages(
      args.organizationId,
      args.kind,
      args.approvalId,
      routed.slackMessages,
      { title: heading, body: args.message },
    );
  } catch (err) {
    console.error(`[approvals] recording Slack messages for ${args.approvalId} failed:`, err);
  }
}

/** `APP_URL`-rooted deep link, or null when the server has no `APP_URL`. */
export function appPath(path: string): string | null {
  const base = process.env["APP_URL"];
  if (!base) return null;
  return `${base.replace(/\/$/, "")}${path}`;
}
