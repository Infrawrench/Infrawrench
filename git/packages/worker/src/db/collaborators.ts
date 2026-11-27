/** Per-repository collaborators: access for one person on one repository. */
import { and, asc, eq } from "drizzle-orm";
import { type GitRepoRole, gitCollaborators } from "@infrawrench/server-core/db/schema";
import { db, newId } from "./client";

export type CollaboratorRow = typeof gitCollaborators.$inferSelect;

/** The person's role on the repository, or null. One of the two facts `repoAccess` loads. */
export const collaboratorRole = async (
  repositoryId: string,
  userId: string,
): Promise<GitRepoRole | null> => {
  const [row] = await db
    .select({ role: gitCollaborators.role })
    .from(gitCollaborators)
    .where(
      and(eq(gitCollaborators.repositoryId, repositoryId), eq(gitCollaborators.userId, userId)),
    )
    .limit(1);
  return row?.role ?? null;
};

export const listCollaborators = (repositoryId: string): Promise<CollaboratorRow[]> =>
  db
    .select()
    .from(gitCollaborators)
    .where(eq(gitCollaborators.repositoryId, repositoryId))
    .orderBy(asc(gitCollaborators.createdAt));

/** Add a collaborator, or change the role of one. */
export const setCollaborator = async (
  repositoryId: string,
  userId: string,
  role: GitRepoRole,
  addedByUserId: string | null,
): Promise<CollaboratorRow> => {
  const now = new Date();
  const [row] = await db
    .insert(gitCollaborators)
    .values({ id: newId(), repositoryId, userId, role, addedByUserId })
    .onConflictDoUpdate({
      target: [gitCollaborators.repositoryId, gitCollaborators.userId],
      set: { role, updatedAt: now },
    })
    .returning();
  return row!;
};

/**
 * Give a new fork its parent's collaborators, with their roles, as GitHub
 * does for a fork within the same organisation. A copy at the moment of
 * forking: later changes to either repository's list stay with it.
 */
export const copyCollaborators = async (
  fromRepositoryId: string,
  toRepositoryId: string,
  addedByUserId: string | null,
): Promise<number> => {
  const rows = await listCollaborators(fromRepositoryId);
  if (rows.length === 0) return 0;
  const inserted = await db
    .insert(gitCollaborators)
    .values(
      rows.map((row) => ({
        id: newId(),
        repositoryId: toRepositoryId,
        userId: row.userId,
        role: row.role,
        addedByUserId,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: gitCollaborators.id });
  return inserted.length;
};

export const removeCollaborator = async (
  repositoryId: string,
  userId: string,
): Promise<boolean> => {
  const deleted = await db
    .delete(gitCollaborators)
    .where(
      and(eq(gitCollaborators.repositoryId, repositoryId), eq(gitCollaborators.userId, userId)),
    )
    .returning({ id: gitCollaborators.id });
  return deleted.length > 0;
};
