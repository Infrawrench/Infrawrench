/**
 * Creating an organization: the row, its system roles, its owner, its default
 * Home dashboard and its default scorecard. The one place that does it for a
 * person, whoever asks: `POST /api/orgs` (the app's own onboarding) and a
 * workspace paid for from git.infrawrench.com (`git/workspace-checkout.ts`).
 * Trial organizations for agents are made by `trials/create.ts`, which has
 * no owner to add.
 *
 * Safe to repeat for one id: every step only adds what is missing, so a call
 * that stopped part way (or two reports of one payment racing) ends with one
 * organization, one owner and one dashboard.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import { db } from "../db/client";
import { dashboards, organizationMembers, organizations } from "../db/schema";
import { getSystemRole } from "../permissions";
import { ensureDefaultScorecard } from "../scorecards/store";

export interface CreateOrganizationInput {
  /** The id it will have. Left out, a new one. */
  readonly id?: string;
  readonly displayName: string;
  /** Who becomes its owner (`users.id`). */
  readonly ownerUserId: string;
}

export type CreateOrganizationResult =
  | {
      readonly ok: true;
      readonly id: string;
      readonly displayName: string;
      /** False when the organization was already there from an earlier call. */
      readonly created: boolean;
    }
  /** The id is an organization this person is not in: nothing was written. */
  | { readonly ok: false; readonly reason: "taken" };

export async function createOrganization(
  input: CreateOrganizationInput,
): Promise<CreateOrganizationResult> {
  const id = input.id ?? randomUUID();

  // The dashboard with the row, so an organization never exists without the
  // Home it opens on, and a repeat never adds a second.
  const created = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(organizations)
      .values({ id, displayName: input.displayName })
      .onConflictDoNothing()
      .returning({ id: organizations.id });
    if (!row) return false;
    await tx.insert(dashboards).values({
      id: randomUUID(),
      organizationId: id,
      name: "Home",
      isDefault: true,
    });
    return true;
  });

  let displayName = input.displayName;
  if (!created) {
    // Ours from an earlier call that stopped before the owner was added, or
    // already complete. Anything with members and without this person is
    // someone else's, and a repeat must never add an owner to it.
    const [existing] = await db
      .select({ displayName: organizations.displayName })
      .from(organizations)
      .where(eq(organizations.id, id))
      .limit(1);
    const members = await db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(eq(organizationMembers.organizationId, id));
    if (
      !existing ||
      (members.length > 0 && !members.some((member) => member.userId === input.ownerUserId))
    ) {
      return { ok: false, reason: "taken" };
    }
    displayName = existing.displayName;
  }

  // Ensures the three system roles first.
  const ownerRole = await getSystemRole(id, "owner");
  await db
    .insert(organizationMembers)
    .values({
      id: randomUUID(),
      userId: input.ownerUserId,
      organizationId: id,
      role: "owner",
      roleId: ownerRole.id,
    })
    .onConflictDoNothing();

  // So the first service is graded against something. Best-effort: an
  // organization without it seeds lazily on first read.
  await ensureDefaultScorecard(id).catch((err: unknown) =>
    console.error(
      "[orgs] default scorecard seed failed:",
      err instanceof Error ? err.name : "unknown error",
    ),
  );

  return { ok: true, id, displayName, created };
}
