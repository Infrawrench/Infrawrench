/**
 * A note on a fired budget alert: the rules, and the follow-up that carries
 * the note back to wherever the alert went.
 *
 * The rules are the anomaly-acknowledgement rules (`anomaly-acknowledge.ts`)
 * applied to a budget firing, and are stated there in full: the note is the
 * act and the annotation the artifact; a rewrite rewords the marker in place
 * (text only, since its date and scope may have been edited deliberately); a
 * marker somebody deleted stays deleted; and nothing here touches evaluation.
 *
 * The follow-up is the part anomalies do not have. A budget alert is a chat
 * message somebody saw, so the explanation belongs under it: a reply in each
 * Slack message's thread (`chat.postMessage` with `thread_ts`, which needs no
 * scope beyond the `chat:write` the alert itself used) and, because Teams
 * incoming webhooks return no message id and cannot thread, a follow-up card
 * to the same webhooks. Budget alerts do not go by email, so there is no email
 * leg to follow.
 */
import {
  budgetAlertNoteAnnotationInput,
  budgetAlertNoteError,
  type CostAnnotationInput,
} from "@infrawrench/client-core";

import { sendMsTeamsToWebhooks } from "../msteams";
import { loadOrgSlackTokens, postSlackThreadReply } from "../slack";

/** The state a note acts on: the event's columns, nothing more. */
export interface NotableBudgetAlert {
  triggeredAt: Date;
  /** Null while nobody has written a note. */
  notedAt: Date | null;
  /** The marker the note already minted, or null (never made, or deleted). */
  annotationId: string | null;
}

export type BudgetAlertNotePlan =
  | { action: "create"; input: CostAnnotationInput }
  | { action: "update"; annotationId: string; text: string }
  | { action: "none"; reason: "annotation-deleted" };

/** A rejected note: the API maps this to a 400, never a 500. */
export class BudgetAlertNoteError extends Error {}

/** What writing `note` on `event` does to the annotation side. */
export function planBudgetAlertNote(event: NotableBudgetAlert, note: string): BudgetAlertNotePlan {
  const wire = { triggeredAt: event.triggeredAt.toISOString() };
  const problem = budgetAlertNoteError(wire, note);
  if (problem) throw new BudgetAlertNoteError(problem);
  const input = budgetAlertNoteAnnotationInput(wire, note);
  if (event.annotationId !== null) {
    return { action: "update", annotationId: event.annotationId, text: input.text };
  }
  if (event.notedAt === null) return { action: "create", input };
  return { action: "none", reason: "annotation-deleted" };
}

/** Where the alert landed, as stored on its event row. */
export interface BudgetAlertDelivery {
  slackMessages: Array<{ installationId: string; channelId: string; ts: string }> | null;
  msTeamsWebhookIds: string[] | null;
}

/** How many places the follow-up reached, per transport. */
export interface BudgetAlertFollowUpResult {
  slack: number;
  msTeams: number;
}

/**
 * Post `text` after the alert: a thread reply under every Slack message it was
 * posted as, and a follow-up card to every Teams webhook it reached.
 *
 * Never throws. The note is already saved on the alert and on the charts by
 * the time this runs, and a Slack outage must not turn a saved note into an
 * error the person retries (minting nothing, but re-posting to every channel
 * that did work). Failures are logged and counted.
 */
export async function postBudgetAlertNoteFollowUp(
  organizationId: string,
  delivery: BudgetAlertDelivery,
  followUp: { title: string; text: string; url?: string | undefined },
): Promise<BudgetAlertFollowUpResult> {
  const result: BudgetAlertFollowUpResult = { slack: 0, msTeams: 0 };
  const messages = delivery.slackMessages ?? [];
  const webhooks = delivery.msTeamsWebhookIds ?? [];

  const slackLeg = async () => {
    if (messages.length === 0) return;
    try {
      const tokens = await loadOrgSlackTokens(organizationId);
      const settled = await Promise.allSettled(
        messages.map(async (m) => {
          const token = tokens.get(m.installationId);
          // The install was removed or replaced since the alert went out: the
          // thread is unreachable, and that is not worth an error.
          if (!token) throw new Error("no live install");
          await postSlackThreadReply(token, m.channelId, m.ts, followUp.text);
        }),
      );
      for (const s of settled) {
        if (s.status === "rejected") {
          console.warn("[budget-note] slack thread reply failed:", s.reason);
        }
      }
      result.slack = settled.filter((s) => s.status === "fulfilled").length;
    } catch (err) {
      console.error("[budget-note] slack follow-up failed:", err);
    }
  };

  const teamsLeg = async () => {
    if (webhooks.length === 0) return;
    const sent = await sendMsTeamsToWebhooks(organizationId, webhooks, {
      title: followUp.title,
      body: followUp.text,
      ...(followUp.url ? { url: followUp.url } : {}),
    });
    result.msTeams = sent.succeeded;
  };

  await Promise.all([slackLeg(), teamsLeg()]);
  return result;
}
