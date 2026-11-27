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

// ---------------------------------------------------------------------------
// Tokens an OAuth client holds (`mcp/oauth/`)
// ---------------------------------------------------------------------------

/**
 * What an OAuth client was granted is a row of this table like any other
 * token, so it authenticates the same way, shows on the same settings page
 * and is revoked there. Its id says where it came from.
 */
export const OAUTH_GRANT_ID_PREFIX = "mcp_";

export const isOAuthGrantId = (id: string): boolean => id.startsWith(OAUTH_GRANT_ID_PREFIX);

/**
 * Insert the token an authorization code was exchanged for, under the id the
 * code carried. False when the id is taken, which is a code used twice: the
 * primary key is what makes a code single use.
 */
export const insertGrantedToken = async (token: {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly prefix: string;
  readonly hash: string;
  readonly scopes: readonly GitTokenScope[];
  readonly expiresAt: Date;
}): Promise<boolean> => {
  const inserted = await db
    .insert(gitAccessTokens)
    .values({
      id: token.id,
      userId: token.userId,
      name: token.name,
      prefix: token.prefix,
      hashedToken: token.hash,
      scopes: [...token.scopes],
      expiresAt: token.expiresAt,
    })
    .onConflictDoNothing({ target: gitAccessTokens.id })
    .returning({ id: gitAccessTokens.id });
  return inserted.length > 0;
};

export const getAccessTokenById = async (tokenId: string): Promise<AccessTokenRow | null> => {
  const [row] = await db
    .select()
    .from(gitAccessTokens)
    .where(eq(gitAccessTokens.id, tokenId))
    .limit(1);
  return row ?? null;
};

/**
 * Replace a grant's access token: the row keeps its id, its name and its
 * scopes, and from now on only the new token's hash verifies. Compared and
 * swapped on the hash the caller saw, so of two refreshes racing one wins
 * and the other changes nothing (false).
 */
export const rotateGrantedToken = async (rotation: {
  readonly id: string;
  readonly fromHash: string;
  readonly toHash: string;
  readonly prefix: string;
  readonly expiresAt: Date;
}): Promise<boolean> => {
  const rotated = await db
    .update(gitAccessTokens)
    .set({
      hashedToken: rotation.toHash,
      prefix: rotation.prefix,
      expiresAt: rotation.expiresAt,
    })
    .where(
      and(
        eq(gitAccessTokens.id, rotation.id),
        eq(gitAccessTokens.hashedToken, rotation.fromHash),
        isNull(gitAccessTokens.revokedAt),
      ),
    )
    .returning({ id: gitAccessTokens.id });
  return rotated.length > 0;
};

/** Revoke a token by its id alone: its holder asked, or it was presented twice. */
export const revokeAccessTokenById = async (tokenId: string): Promise<void> => {
  await db
    .update(gitAccessTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(gitAccessTokens.id, tokenId), isNull(gitAccessTokens.revokedAt)));
};
