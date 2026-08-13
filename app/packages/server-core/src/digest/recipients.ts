/**
 * The weekly digest's email recipient list.
 *
 * Recipients are an org-level address list rather than a per-member opt-in.
 * The reasoning is in `db/schema.ts` above `digestEmailRecipients`, and short:
 * the digest is a channel-only trigger, so its destinations are things an admin
 * configures (a Slack channel, a Teams webhook, a mailing list), not things
 * each user opts into on their own phone the way `push_preferences` works for
 * the four alert triggers.
 */
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { DigestEmailRecipient } from "@infrawrench/client-core";

import { db } from "../db/client";
import { digestEmailRecipients } from "../db/schema";
import { normalizeEmailAddress } from "../email";

// The wire shape is the client contract; client-core (`digest.ts`) owns it.
export type { DigestEmailRecipient };

/** Every address the org routes its digest to, alphabetically. */
export async function listDigestEmailRecipients(
  organizationId: string,
): Promise<DigestEmailRecipient[]> {
  const rows = await db
    .select({ id: digestEmailRecipients.id, email: digestEmailRecipients.email })
    .from(digestEmailRecipients)
    .where(eq(digestEmailRecipients.organizationId, organizationId))
    .orderBy(digestEmailRecipients.email);
  return rows;
}

/**
 * Add an address. Re-adding one the org already has is a no-op that returns the
 * existing row, so a double-submit doesn't double-deliver.
 */
export async function addDigestEmailRecipient(
  organizationId: string,
  rawEmail: string,
  userId: string | null,
): Promise<DigestEmailRecipient> {
  const email = normalizeEmailAddress(rawEmail);
  const [row] = await db
    .insert(digestEmailRecipients)
    .values({ id: randomUUID(), organizationId, email, createdByUserId: userId })
    .onConflictDoUpdate({
      target: [digestEmailRecipients.organizationId, digestEmailRecipients.email],
      set: { email },
    })
    .returning({ id: digestEmailRecipients.id, email: digestEmailRecipients.email });
  if (!row) throw new Error("Failed to save the digest recipient");
  return row;
}

/** Remove an address. Returns false when the id isn't this org's. */
export async function removeDigestEmailRecipient(
  organizationId: string,
  id: string,
): Promise<boolean> {
  const rows = await db
    .delete(digestEmailRecipients)
    .where(
      and(
        eq(digestEmailRecipients.organizationId, organizationId),
        eq(digestEmailRecipients.id, id),
      ),
    )
    .returning({ id: digestEmailRecipients.id });
  return rows.length > 0;
}
