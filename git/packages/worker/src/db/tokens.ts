/** Personal access tokens' rows. Minting and checking are `auth/tokens.ts`. */
import { and, desc, eq, isNull } from "drizzle-orm";
import { type GitTokenScope, gitAccessTokens } from "@infrawrench/server-core/db/schema";
import type { StoredAccessToken } from "../auth/tokens";
import { db, newId } from "./client";

export type AccessTokenRow = typeof gitAccessTokens.$inferSelect;

/** Look a token up by its digest: the `find` that `verifyAccessToken` takes. */
export const findAccessTokenByHash = async (hash: string): Promise<StoredAccessToken | null> => {
  const [row] = await db
    .select({
      id: gitAccessTokens.id,
      userId: gitAccessTokens.userId,
      hashedToken: gitAccessTokens.hashedToken,
      scopes: gitAccessTokens.scopes,
      expiresAt: gitAccessTokens.expiresAt,
      revokedAt: gitAccessTokens.revokedAt,
    })
    .from(gitAccessTokens)
    .where(eq(gitAccessTokens.hashedToken, hash))
    .limit(1);
  return row ?? null;
};

export const insertAccessToken = async (token: {
  readonly userId: string;
  readonly name: string;
  readonly prefix: string;
  readonly hash: string;
  readonly scopes: readonly GitTokenScope[];
  readonly expiresAt: Date | null;
}): Promise<AccessTokenRow> => {
  const [row] = await db
    .insert(gitAccessTokens)
    .values({
      id: newId(),
      userId: token.userId,
      name: token.name,
      prefix: token.prefix,
      hashedToken: token.hash,
      scopes: [...token.scopes],
      expiresAt: token.expiresAt,
    })
    .returning();
  return row!;
};

/** A person's live tokens, newest first. Revoked ones are not listed. */
export const listAccessTokens = (userId: string): Promise<AccessTokenRow[]> =>
  db
    .select()
    .from(gitAccessTokens)
    .where(and(eq(gitAccessTokens.userId, userId), isNull(gitAccessTokens.revokedAt)))
    .orderBy(desc(gitAccessTokens.createdAt));

export const revokeAccessToken = async (userId: string, tokenId: string): Promise<boolean> => {
  const revoked = await db
    .update(gitAccessTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(gitAccessTokens.id, tokenId),
        eq(gitAccessTokens.userId, userId),
        isNull(gitAccessTokens.revokedAt),
      ),
    )
    .returning({ id: gitAccessTokens.id });
  return revoked.length > 0;
};

/** Note that a token just authenticated. Fire-and-forget: wrap in `keepAlive`. */
export const touchAccessToken = async (tokenId: string, at: Date = new Date()): Promise<void> => {
  await db.update(gitAccessTokens).set({ lastUsedAt: at }).where(eq(gitAccessTokens.id, tokenId));
};
