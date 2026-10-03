/**
 * Which GitHub App installations an org owns, and recording a new one.
 *
 * An installation id is a bare integer GitHub hands out sequentially, so any
 * place that accepts one from a caller (the setup callback, a workflow's git
 * trigger, an org-config document) must check it against the org's own rows
 * here before acting on it. An installation token minted for a foreign id
 * reads someone else's private repositories.
 */
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";

import { db } from "../db/client";
import { githubInstallations } from "../db/schema";

/** The installation ids connected (and not disconnected) to `organizationId`. */
export async function orgGithubInstallationIds(organizationId: string): Promise<Set<number>> {
  const rows = await db
    .select({ installationId: githubInstallations.installationId })
    .from(githubInstallations)
    .where(
      and(
        eq(githubInstallations.organizationId, organizationId),
        isNull(githubInstallations.deletedAt),
      ),
    );
  return new Set(rows.map((r) => r.installationId));
}

export type LinkGithubInstallationResult = "linked" | "owned-elsewhere";

/**
 * Record `installationId` for `organizationId`. The caller must already have
 * proven the signed-in user can access the installation on GitHub.
 *
 * Re-installs reuse the same installation id, so an existing row for this org
 * is revived in place. A row belonging to a different org is only taken over
 * once that org has disconnected it; while it is live it is refused, because
 * moving it would silently cut the other org off from its repositories.
 */
export async function linkGithubInstallation(input: {
  organizationId: string;
  userId: string;
  installationId: number;
  account: { accountLogin: string | null; accountType: string | null } | null;
}): Promise<LinkGithubInstallationResult> {
  const { organizationId, userId, installationId, account } = input;
  const [existing] = await db
    .select({
      organizationId: githubInstallations.organizationId,
      deletedAt: githubInstallations.deletedAt,
    })
    .from(githubInstallations)
    .where(eq(githubInstallations.installationId, installationId))
    .limit(1);

  if (!existing) {
    await db.insert(githubInstallations).values({
      id: uuidv4(),
      organizationId,
      installationId,
      accountLogin: account?.accountLogin ?? null,
      accountType: account?.accountType ?? null,
      createdByUserId: userId,
    });
    return "linked";
  }

  if (existing.organizationId !== organizationId && existing.deletedAt === null) {
    return "owned-elsewhere";
  }

  // Conditional on what was just read, so a concurrent link from another org
  // cannot slip in between the read and the write.
  const updated = await db
    .update(githubInstallations)
    .set({
      organizationId,
      accountLogin: account?.accountLogin ?? null,
      accountType: account?.accountType ?? null,
      ...(existing.organizationId !== organizationId ? { createdByUserId: userId } : {}),
      deletedAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(githubInstallations.installationId, installationId),
        eq(githubInstallations.organizationId, existing.organizationId),
        existing.organizationId === organizationId
          ? undefined
          : isNotNull(githubInstallations.deletedAt),
      ),
    )
    .returning({ id: githubInstallations.id });
  return updated.length > 0 ? "linked" : "owned-elsewhere";
}
