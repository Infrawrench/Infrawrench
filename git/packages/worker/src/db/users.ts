/**
 * People: the app's `users` row, provisioned the way the app provisions it,
 * and the forge's own `git_users` row beside it.
 */
import { eq, inArray, sql } from "drizzle-orm";
import { gitNamespaces, gitUsers, users } from "@infrawrench/server-core/db/schema";
import type { WorkosUser } from "../auth/workos";
import { db } from "./client";

/**
 * Create the `users` row on first sight of a WorkOS user. The same statement
 * as the app's `provisionUser` (`web/src/http/auth.ts`): insert the id, the
 * email and a display name from the first and last name, and do nothing when
 * the row exists. Whichever site a person signs in to first, the row is the
 * same.
 */
export const provisionUser = async (user: {
  readonly id: string;
  readonly email: string;
  readonly firstName?: string | null;
  readonly lastName?: string | null;
}): Promise<void> => {
  await db
    .insert(users)
    .values({
      id: user.id,
      email: user.email,
      displayName: `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() || null,
    })
    .onConflictDoNothing();
};

/**
 * What sign-in and a session refresh do with the user WorkOS returns: the
 * `users` row as above, then the `git_users` row, whose absence of
 * `onboardedAt` is the "needs a username" state.
 */
export const provisionSignedInUser = async (user: WorkosUser): Promise<void> => {
  await provisionUser(user);
  const now = new Date();
  await db
    .insert(gitUsers)
    .values({ userId: user.id, avatarUrl: user.profilePictureUrl, lastSeenAt: now })
    .onConflictDoUpdate({
      target: gitUsers.userId,
      set: { avatarUrl: user.profilePictureUrl, lastSeenAt: now, updatedAt: now },
    });
};

export interface UserRow {
  readonly id: string;
  readonly email: string;
  readonly displayName: string | null;
}

export const getUser = async (userId: string): Promise<UserRow | null> => {
  const [row] = await db
    .select({ id: users.id, email: users.email, displayName: users.displayName })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row ?? null;
};

/** A person as the API names them (`UserRef` in the contract). */
export interface UserRefRow {
  readonly id: string;
  readonly username: string | null;
  readonly displayName: string | null;
  readonly avatarUrl: string | null;
}

const userRefColumns = {
  id: users.id,
  username: gitNamespaces.slug,
  displayName: sql<string | null>`coalesce(${gitNamespaces.displayName}, ${users.displayName})`,
  avatarUrl: sql<string | null>`coalesce(${gitNamespaces.avatarUrl}, ${gitUsers.avatarUrl})`,
};

/** The people with these ids, by id. Ids with no `users` row are simply absent. */
export const userRefs = async (userIds: readonly string[]): Promise<Map<string, UserRefRow>> => {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select(userRefColumns)
    .from(users)
    .leftJoin(gitNamespaces, eq(gitNamespaces.userId, users.id))
    .leftJoin(gitUsers, eq(gitUsers.userId, users.id))
    .where(inArray(users.id, unique));
  return new Map(rows.map((row) => [row.id, row]));
};

/** The person behind a username, or null: usernames compare lowercased. */
export const userByUsername = async (username: string): Promise<UserRefRow | null> => {
  const [row] = await db
    .select(userRefColumns)
    .from(gitNamespaces)
    .innerJoin(users, eq(users.id, gitNamespaces.userId))
    .leftJoin(gitUsers, eq(gitUsers.userId, users.id))
    .where(eq(gitNamespaces.slugLower, username.toLowerCase()))
    .limit(1);
  return row ?? null;
};

/** The onboarding state `session.me` reports. Null for someone who has never signed in here. */
export const getGitUser = async (
  userId: string,
): Promise<{
  readonly onboardedAt: Date | null;
  readonly suggestedSlug: string | null;
  readonly avatarUrl: string | null;
} | null> => {
  const [row] = await db
    .select({
      onboardedAt: gitUsers.onboardedAt,
      suggestedSlug: gitUsers.suggestedSlug,
      avatarUrl: gitUsers.avatarUrl,
    })
    .from(gitUsers)
    .where(eq(gitUsers.userId, userId))
    .limit(1);
  return row ?? null;
};

export const setSuggestedSlug = async (userId: string, slug: string | null): Promise<void> => {
  await db
    .update(gitUsers)
    .set({ suggestedSlug: slug, updatedAt: new Date() })
    .where(eq(gitUsers.userId, userId));
};
