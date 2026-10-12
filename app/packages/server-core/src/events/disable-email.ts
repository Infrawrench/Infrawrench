/**
 * The email an org's owners and admins get when an event subscription is
 * turned off automatically. Sent once per disable (the caller's conditional
 * UPDATE is the claim). Never throws.
 */
import { and, eq, inArray, or, sql } from "drizzle-orm";

import { db } from "../db/client";
import { organizationMembers, organizations, roles, users } from "../db/schema";
import { sendEmails } from "../email";
import { emailButton, emailDocument, escapeHtml } from "../email-html";
import { orgAppUrl } from "../app-url";
import type { SubscriptionRow } from "./store";

/** Owners and admins: by their role row's system key, or the legacy text role. */
async function adminEmails(organizationId: string): Promise<string[]> {
  const rows = await db
    .select({ email: users.email })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .leftJoin(roles, eq(roles.id, organizationMembers.roleId))
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        or(
          inArray(roles.systemKey, ["owner", "admin"]),
          and(
            sql`${organizationMembers.roleId} IS NULL`,
            inArray(organizationMembers.role, ["owner", "admin"]),
          ),
        ),
      ),
    );
  return [...new Set(rows.map((r) => r.email).filter(Boolean))];
}

export async function notifySubscriptionDisabled(
  sub: SubscriptionRow,
  reason: string,
): Promise<void> {
  try {
    const [org] = await db
      .select({ name: organizations.displayName })
      .from(organizations)
      .where(eq(organizations.id, sub.organizationId))
      .limit(1);
    const to = await adminEmails(sub.organizationId);
    if (to.length === 0) return;
    const url = orgAppUrl(sub.organizationId, "settings/paging");
    const orgName = org?.name ?? "your organization";
    const subject = `[${orgName}] Event subscription "${sub.name}" was turned off`;
    const text =
      `The event subscription "${sub.name}" (${sub.destinationLabel}) in ${orgName} kept failing, ` +
      `so Infrawrench turned it off.\n\n${reason}\n\n` +
      `Events raised while it is off are not queued for it. Fix the receiver, use Send test event ` +
      `to check it, then turn the subscription back on under Settings > Notifications > Event subscriptions.` +
      (url ? `\n\n${url}` : "");
    const html = emailDocument([
      `<p>The event subscription <strong>${escapeHtml(sub.name)}</strong> (${escapeHtml(sub.destinationLabel)}) in ${escapeHtml(orgName)} kept failing, so Infrawrench turned it off.</p>`,
      `<p>${escapeHtml(reason)}</p>`,
      `<p>Events raised while it is off are not queued for it. Fix the receiver, use <em>Send test event</em> to check it, then turn the subscription back on.</p>`,
      emailButton(url, "Open event subscriptions"),
    ]);
    await sendEmails(
      to.map((address) => ({
        to: address,
        subject,
        text,
        html,
        traceKey: `event-sub-disabled:${sub.id}`,
      })),
      "event subscription disabled",
    );
  } catch (err) {
    console.error(`[events] disable email for subscription ${sub.id} failed:`, err);
  }
}
