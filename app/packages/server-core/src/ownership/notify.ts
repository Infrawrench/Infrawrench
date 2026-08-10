/**
 * Owner-routed alerts — "tell the person whose resource this is", in one place.
 *
 * Resource-scoped alerts already fan out to the org (push, Slack, Teams). This
 * module adds the second delivery: when the resource carries a routable owner,
 * that person also gets the alert on their own devices, with the message
 * rewritten in the second person. It is deliberately *additive* — an outage
 * must not become invisible to the team because one owner is unreachable, so
 * nothing here suppresses the org fan-out.
 *
 * Three properties every caller inherits:
 *
 * - **Never throws.** Callers are poller passes; a delivery failure must cost
 *   a notification, not a pass. Failures log with an `[ownership]` prefix and
 *   are never silent.
 * - **Never routes to a label.** A free-text owner ("Platform team") is a
 *   display string with no device behind it; `lookupResourceOwner` marks those
 *   `isLabel` and this module skips them rather than pretending.
 * - **Never bypasses preferences or membership.** Delivery goes through
 *   `sendPushToOrgUser`, so the owner's own opt-out for that trigger still
 *   wins, and an ex-member is not reachable at all.
 */
import type { ResourceOwnerAnnotation } from "@infrawrench/client-core";
import { sendPushToOrgUser } from "../push/dispatch";
import type { PushData, PushResult, PushTrigger } from "../push/types";
import { lookupResourceOwner } from "./store";

export interface OwnerAlert {
  /** Title for the owner's copy — usually prefixed "Your …". */
  title: string;
  body: string;
  data: PushData;
}

/**
 * Deliver an alert to a resource's owner, if it has a routable one.
 *
 * Returns the delivery counts (`{ attempted: 0, succeeded: 0 }` when there is
 * no owner to reach), so a caller that already records "did anyone hear this"
 * can add them to the org fan-out's.
 */
export async function notifyResourceOwner(
  organizationId: string,
  resourceId: string | null | undefined,
  trigger: PushTrigger,
  build: (owner: ResourceOwnerAnnotation) => OwnerAlert,
): Promise<PushResult> {
  const none: PushResult = { attempted: 0, succeeded: 0 };
  if (!resourceId) return none;
  try {
    const owner = await lookupResourceOwner(organizationId, resourceId);
    // No owner, or an owner that is only a name on a page — nothing to route.
    if (!owner?.userId) return none;
    const alert = build(owner);
    return await sendPushToOrgUser(organizationId, owner.userId, trigger, {
      title: alert.title,
      body: alert.body,
      data: alert.data,
    });
  } catch (err) {
    console.error("[ownership] owner notification failed:", err);
    return none;
  }
}

/**
 * The trailing sentence that puts a resource's ownership context into an alert
 * body — "Owner: Sam Reyes · Purpose: staging load tests · ENG-482".
 *
 * Returns an empty string when nothing is recorded, so callers can append it
 * unconditionally. Used for the *org-wide* copy of an alert, which is where
 * naming the owner turns "something is down" into "and here is who knows about
 * it"; the owner's own copy addresses them directly instead.
 */
export function ownerContextLine(owner: ResourceOwnerAnnotation | null): string {
  if (!owner) return "";
  const parts = [`Owner: ${owner.displayName}`];
  if (owner.purpose) parts.push(`Purpose: ${owner.purpose}`);
  if (owner.ticketUrl) parts.push(owner.ticketUrl);
  return parts.join(" · ");
}
