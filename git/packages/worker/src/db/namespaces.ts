/**
 * Namespaces: a user's username, an organisation's name.
 *
 * The slug's shape and the reserved list are the contract's `names.ts`; the
 * callers check those first. What only the database can say is whether a slug
 * is taken, and it says so through the unique index: the claim functions
 * insert and report a conflict, never check-then-insert.
 */
import { eq, sql } from "drizzle-orm";
import { gitNamespaces, gitUsers } from "@infrawrench/server-core/db/schema";
import { db, isUniqueViolation, newId } from "./client";

export type NamespaceRow = typeof gitNamespaces.$inferSelect;

/**
 * The picture a namespace shows: its own, or for a person who has not set
 * one, the picture they signed in with (`git_users.avatar_url`), which is what
 * the header shows them. Every view of a namespace's picture reads this, so
 * a person looks the same in the header, on their page and beside their
 * repositories. Stored rows keep only what was set.
 */
export const namespaceAvatarUrl = sql<
  string | null
>`coalesce(${gitNamespaces.avatarUrl}, (select ${gitUsers.avatarUrl} from ${gitUsers} where ${gitUsers.userId} = ${gitNamespaces.userId}))`;

/** {@link namespaceAvatarUrl} for a row already read. */
export const avatarOfNamespace = async (namespace: NamespaceRow): Promise<string | null> => {
  if (namespace.avatarUrl !== null || namespace.userId === null) return namespace.avatarUrl;
  const [row] = await db
    .select({ avatarUrl: gitUsers.avatarUrl })
    .from(gitUsers)
    .where(eq(gitUsers.userId, namespace.userId))
    .limit(1);
  return row?.avatarUrl ?? null;
};

export const getNamespaceBySlug = async (slug: string): Promise<NamespaceRow | null> => {
  const [row] = await db
    .select()
    .from(gitNamespaces)
    .where(eq(gitNamespaces.slugLower, slug.toLowerCase()))
    .limit(1);
  return row ?? null;
};

export const getNamespaceById = async (id: string): Promise<NamespaceRow | null> => {
  const [row] = await db.select().from(gitNamespaces).where(eq(gitNamespaces.id, id)).limit(1);
  return row ?? null;
};

export const getNamespaceForUser = async (userId: string): Promise<NamespaceRow | null> => {
  const [row] = await db
    .select()
    .from(gitNamespaces)
    .where(eq(gitNamespaces.userId, userId))
    .limit(1);
  return row ?? null;
};

export const getNamespaceForOrganization = async (
  organizationId: string,
): Promise<NamespaceRow | null> => {
  const [row] = await db
    .select()
    .from(gitNamespaces)
    .where(eq(gitNamespaces.organizationId, organizationId))
    .limit(1);
  return row ?? null;
};

export const isSlugTaken = async (slug: string): Promise<boolean> => {
  const [row] = await db
    .select({ id: gitNamespaces.id })
    .from(gitNamespaces)
    .where(eq(gitNamespaces.slugLower, slug.toLowerCase()))
    .limit(1);
  return row !== undefined;
};

export type ClaimResult =
  | { readonly ok: true; readonly namespace: NamespaceRow }
  /** `slug_taken`: someone has the slug. `already_claimed`: this owner has a namespace. */
  | { readonly ok: false; readonly reason: "slug_taken" | "already_claimed" };

/** Which unique index refused the insert decides which of the two conflicts it was. */
const claimConflict = async (
  owner: { userId: string } | { organizationId: string },
): Promise<ClaimResult> => {
  const existing =
    "userId" in owner
      ? await getNamespaceForUser(owner.userId)
      : await getNamespaceForOrganization(owner.organizationId);
  return { ok: false, reason: existing ? "already_claimed" : "slug_taken" };
};

/** A person claims their username: the namespace row, and `onboardedAt` on their `git_users` row. */
export const claimUserNamespace = async (
  userId: string,
  slug: string,
  profile: { readonly displayName?: string | null } = {},
): Promise<ClaimResult> => {
  try {
    const namespace = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(gitNamespaces)
        .values({
          id: newId(),
          slug,
          slugLower: slug.toLowerCase(),
          kind: "user",
          userId,
          displayName: profile.displayName ?? null,
          claimedByUserId: userId,
        })
        .returning();
      const now = new Date();
      await tx
        .insert(gitUsers)
        .values({ userId, onboardedAt: now })
        .onConflictDoUpdate({
          target: gitUsers.userId,
          set: { onboardedAt: now, suggestedSlug: null, updatedAt: now },
        });
      return row!;
    });
    return { ok: true, namespace };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return claimConflict({ userId });
  }
};

/** Someone with `git:admin` claims their organisation's namespace. */
export const claimOrganizationNamespace = async (
  organizationId: string,
  slug: string,
  claimedByUserId: string,
  profile: { readonly displayName?: string | null } = {},
): Promise<ClaimResult> => {
  try {
    const [row] = await db
      .insert(gitNamespaces)
      .values({
        id: newId(),
        slug,
        slugLower: slug.toLowerCase(),
        kind: "org",
        organizationId,
        displayName: profile.displayName ?? null,
        claimedByUserId,
      })
      .returning();
    return { ok: true, namespace: row! };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return claimConflict({ organizationId });
  }
};

/**
 * Change a namespace's slug. Repositories are keyed by id, so nothing moves;
 * old URLs stop resolving. Null when the new slug is taken.
 */
export const renameNamespace = async (
  namespaceId: string,
  slug: string,
): Promise<NamespaceRow | null> => {
  const now = new Date();
  try {
    const [row] = await db
      .update(gitNamespaces)
      .set({ slug, slugLower: slug.toLowerCase(), renamedAt: now, updatedAt: now })
      .where(eq(gitNamespaces.id, namespaceId))
      .returning();
    return row ?? null;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return null;
  }
};

export const updateNamespaceProfile = async (
  namespaceId: string,
  profile: {
    readonly displayName?: string | null;
    readonly description?: string | null;
    readonly websiteUrl?: string | null;
    readonly location?: string | null;
    readonly avatarUrl?: string | null;
  },
): Promise<NamespaceRow | null> => {
  const [row] = await db
    .update(gitNamespaces)
    .set({ ...profile, updatedAt: new Date() })
    .where(eq(gitNamespaces.id, namespaceId))
    .returning();
  return row ?? null;
};
