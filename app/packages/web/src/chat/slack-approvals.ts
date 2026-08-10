/**
 * Slack leg of the chat agent's destructive-tool approvals.
 *
 * When `runAgentTurn` suspends on a destructive tool call it inserts a
 * `chat_pending_actions` row and the UI shows Approve/Reject. This module
 * mirrors that request into Slack (under the same `workflowPages` channel
 * opt-in that carries workflow approvals) with interactive buttons, and
 * rewrites the message once the action is decided — from either surface.
 *
 * The Slack button resolves through the same transitions the web route uses
 * (`chat_pending_actions.status`, `executePendingAction` /
 * `rejectPendingAction`); only the conversation's owner may decide, exactly as
 * on the web. See api/routes/slack-inbound.ts for the enforcement.
 */
import { isSlackConfigured } from "@infrawrench/server-core/slack";
import { routeAlert } from "@infrawrench/server-core/alerts/route";
import {
  recordSlackApprovalMessages,
  slackApprovalButtons,
  updateSlackApprovalMessages,
} from "@infrawrench/server-core/slack-approvals";

function appUrl(): string | null {
  return process.env["APP_URL"] ?? null;
}

const INPUT_SUMMARY_MAX_FIELDS = 8;

/**
 * A redacted, non-sensitive shape of a tool's input: field *names* only, never
 * values. Tool inputs routinely carry things a shared channel must not see —
 * connection strings, SQL, key material — and a Slack channel is a much wider
 * audience than the conversation owner. The full input stays where it always
 * was: the authenticated in-app approval view.
 */
export function summarizeToolInput(toolInput: unknown): string {
  if (toolInput === null || toolInput === undefined) return "no input";
  if (Array.isArray(toolInput)) {
    return `a list of ${toolInput.length} item${toolInput.length === 1 ? "" : "s"}`;
  }
  if (typeof toolInput === "object") {
    const keys = Object.keys(toolInput as Record<string, unknown>);
    if (keys.length === 0) return "no input";
    const shown = keys.slice(0, INPUT_SUMMARY_MAX_FIELDS).map((k) => `\`${k}\``);
    const more = keys.length > INPUT_SUMMARY_MAX_FIELDS ? ", …" : "";
    return `${keys.length} field${keys.length === 1 ? "" : "s"} (${shown.join(", ")}${more})`;
  }
  return `a single ${typeof toolInput} value`;
}

/** The request's headline/body, shared by the initial post and the update. */
export function chatApprovalText(
  toolName: string,
  toolInput: unknown,
): { title: string; body: string } {
  return {
    title: `Approval needed: ${toolName}`,
    body:
      `The chat agent wants to run the destructive tool \`${toolName}\` and is waiting for approval.\n\n` +
      `Input: ${summarizeToolInput(toolInput)} — review the full input in Infrawrench before deciding.`,
  };
}

/**
 * Mirror a pending destructive tool call into Slack with Approve/Deny buttons.
 * Never throws — a Slack outage must not fail the agent turn; the in-app
 * approval UI is the primary surface and keeps working regardless.
 */
export async function notifyChatToolApproval(args: {
  organizationId: string;
  conversationId: string;
  pendingActionId: string;
  toolName: string;
  toolInput: unknown;
  /** Conversation owner, shown so channel readers know whose agent is asking. */
  ownerEmail?: string;
}): Promise<void> {
  try {
    if (!isSlackConfigured()) return;
    const { title, body } = chatApprovalText(args.toolName, args.toolInput);
    const base = appUrl();
    const url = base
      ? `${base.replace(/\/$/, "")}/org/${args.organizationId}/chat/${args.conversationId}`
      : null;
    const owner = args.ownerEmail ?? "the conversation owner";
    // Routed like every other alert, but never held: the conversation is
    // blocked on the decision, so quiet hours would strand the person who asked.
    const sent = await routeAlert(
      {
        organizationId: args.organizationId,
        trigger: "workflowPages",
        title,
        body,
        context: `chat agent · requested in ${owner}'s conversation · only they can decide`,
        ...(url ? { url } : {}),
        // No `pushData`, so a `push` destination on the matching rule is
        // skipped. A chat tool approval lives inside one person's conversation
        // and only they can decide it; the mobile app has no screen to deep-link
        // to, and buzzing the whole org about a request nobody else can action
        // would be worse than the Slack-only reach this had before.
      },
      {
        track: true,
        bypassQuietHours: true,
        slackButtons: slackApprovalButtons({
          kind: "chat",
          approvalId: args.pendingActionId,
          organizationId: args.organizationId,
        }),
      },
    );
    await recordSlackApprovalMessages(
      args.organizationId,
      "chat",
      args.pendingActionId,
      sent.slackMessages,
      { title, body },
    );
  } catch (err) {
    console.error(`[chat] Slack approval notification for ${args.pendingActionId} failed:`, err);
  }
}

/**
 * Rewrite the Slack copies of a chat tool approval once it is decided —
 * called for web decisions and Slack-button decisions alike. Never throws.
 */
export async function noteChatToolApprovalDecided(args: {
  organizationId: string;
  pendingActionId: string;
  toolName: string;
  toolInput: unknown;
  decision: "approved" | "denied";
  decidedByName: string | null;
  via: "Slack" | "the web app";
}): Promise<void> {
  const { title, body } = chatApprovalText(args.toolName, args.toolInput);
  await updateSlackApprovalMessages(args.organizationId, "chat", args.pendingActionId, {
    decision: args.decision,
    decidedByName: args.decidedByName,
    via: args.via,
    title,
    body,
  });
}
