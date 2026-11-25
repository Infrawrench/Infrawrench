/**
 * SSH keys: a person's (`git_user_keys`) and a repository's deploy keys
 * (`git_deploy_keys`).
 *
 * A key names exactly one principal. SSH authenticates the key before the
 * client says which repository it wants, so a key that were both someone's
 * and a deploy key, or two repositories' deploy key, could not be resolved.
 * Each table has a unique index on the fingerprint; the pair of them is kept
 * disjoint here, by checking the other table inside the transaction that
 * inserts.
 */
import { and, asc, eq } from "drizzle-orm";
import { gitDeployKeys, gitUserKeys } from "@infrawrench/server-core/db/schema";
import { db, isUniqueViolation, newId } from "./client";

export type UserKeyRow = typeof gitUserKeys.$inferSelect;
export type DeployKeyRow = typeof gitDeployKeys.$inferSelect;

export interface NewKey {
  readonly title: string;
  readonly algorithm: string;
  /** The key blob, base64. */
  readonly publicKey: string;
  readonly fingerprint: string;
}

/** Whose key a fingerprint is: what SSH authentication asks. */
export type KeyOwner =
  | { readonly kind: "user"; readonly key: UserKeyRow }
  | { readonly kind: "deploy"; readonly key: DeployKeyRow };

export const findKeyByFingerprint = async (fingerprint: string): Promise<KeyOwner | null> => {
  const [[userKey], [deployKey]] = await Promise.all([
    db.select().from(gitUserKeys).where(eq(gitUserKeys.fingerprint, fingerprint)).limit(1),
    db.select().from(gitDeployKeys).where(eq(gitDeployKeys.fingerprint, fingerprint)).limit(1),
  ]);
  if (userKey) return { kind: "user", key: userKey };
  if (deployKey) return { kind: "deploy", key: deployKey };
  return null;
};

export const listUserKeys = (userId: string): Promise<UserKeyRow[]> =>
  db
    .select()
    .from(gitUserKeys)
    .where(eq(gitUserKeys.userId, userId))
    .orderBy(asc(gitUserKeys.createdAt));

/** Add a person's key. Null when the key is already somebody's, or a deploy key. */
export const addUserKey = async (userId: string, key: NewKey): Promise<UserKeyRow | null> => {
  try {
    return await db.transaction(async (tx) => {
      const [taken] = await tx
        .select({ id: gitDeployKeys.id })
        .from(gitDeployKeys)
        .where(eq(gitDeployKeys.fingerprint, key.fingerprint))
        .limit(1);
      if (taken) return null;
      const [row] = await tx
        .insert(gitUserKeys)
        .values({ id: newId(), userId, ...key })
        .returning();
      return row!;
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return null;
  }
};

export const deleteUserKey = async (userId: string, keyId: string): Promise<boolean> => {
  const deleted = await db
    .delete(gitUserKeys)
    .where(and(eq(gitUserKeys.id, keyId), eq(gitUserKeys.userId, userId)))
    .returning({ id: gitUserKeys.id });
  return deleted.length > 0;
};

export const listDeployKeys = (repositoryId: string): Promise<DeployKeyRow[]> =>
  db
    .select()
    .from(gitDeployKeys)
    .where(eq(gitDeployKeys.repositoryId, repositoryId))
    .orderBy(asc(gitDeployKeys.createdAt));

/** Add a deploy key. Null when the key is already in use anywhere. */
export const addDeployKey = async (
  repositoryId: string,
  key: NewKey & { readonly readOnly: boolean; readonly addedByUserId: string | null },
): Promise<DeployKeyRow | null> => {
  try {
    return await db.transaction(async (tx) => {
      const [taken] = await tx
        .select({ id: gitUserKeys.id })
        .from(gitUserKeys)
        .where(eq(gitUserKeys.fingerprint, key.fingerprint))
        .limit(1);
      if (taken) return null;
      const [row] = await tx
        .insert(gitDeployKeys)
        .values({ id: newId(), repositoryId, ...key })
        .returning();
      return row!;
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return null;
  }
};

export const deleteDeployKey = async (repositoryId: string, keyId: string): Promise<boolean> => {
  const deleted = await db
    .delete(gitDeployKeys)
    .where(and(eq(gitDeployKeys.id, keyId), eq(gitDeployKeys.repositoryId, repositoryId)))
    .returning({ id: gitDeployKeys.id });
  return deleted.length > 0;
};

/** Note that a key just authenticated. Fire-and-forget: wrap in `keepAlive`. */
export const touchKey = async (owner: KeyOwner, at: Date = new Date()): Promise<void> => {
  if (owner.kind === "user") {
    await db.update(gitUserKeys).set({ lastUsedAt: at }).where(eq(gitUserKeys.id, owner.key.id));
  } else {
    await db
      .update(gitDeployKeys)
      .set({ lastUsedAt: at })
      .where(eq(gitDeployKeys.id, owner.key.id));
  }
};
