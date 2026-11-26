/**
 * Infrawrench organisations as the forge reads them: membership, a person's
 * effective permissions, and `iwk_` API keys. All of it is the app's data and
 * the app's rules. The key hash is server-core's `keyedHash` and the scope
 * ceiling its `intersectPermissions`; the role and break-glass rule is
 * `./org-permissions.ts`, which says why it is restated there rather than
 * imported.
 */
import { and, eq, gt, isNull } from "drizzle-orm";
import {
  accessRequests,
  apiKeys,
  gitNamespaces,
  organizationMembers,
  organizations,
  roles,
} from "@infrawrench/server-core/db/schema";
import { keyedHash, legacySha256Hex } from "@infrawrench/server-core/encryption";
import { intersectPermissions } from "@infrawrench/server-core/permissions/catalog";
import { db } from "./client";
import { type GrantFacts, effectivePermissions } from "./org-permissions";

/** As the app's `hasMembership`: a row in `organization_members`, nothing created. */
export const isMember = async (userId: string, organizationId: string): Promise<boolean> => {
  const [row] = await db
    .select({ id: organizationMembers.id })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.organizationId, organizationId),
      ),
    )
    .limit(1);
  return row !== undefined;
};

/** A member's live break-glass grants. Fails closed: a grant that cannot be read is not held. */
const approvedGrants = async (
  organizationId: string,
  userId: string,
  now: Date,
): Promise<GrantFacts[]> => {
  try {
    return await db
      .select({
        status: accessRequests.status,
        revokedAt: accessRequests.revokedAt,
        grantedAt: accessRequests.grantedAt,
        grantExpiresAt: accessRequests.grantExpiresAt,
        permissions: accessRequests.permissions,
      })
      .from(accessRequests)
      .where(
        and(
          eq(accessRequests.organizationId, organizationId),
          eq(accessRequests.userId, userId),
          eq(accessRequests.status, "approved"),
          isNull(accessRequests.revokedAt),
          gt(accessRequests.grantExpiresAt, now),
        ),
      );
  } catch (error) {
    console.error(`[git] reading elevations for ${userId} in ${organizationId}:`, error);
    return [];
  }
};

/**
 * A person's effective permissions in an organisation: their role's, plus any
 * live break-glass grant when `withElevation`. Empty for a non-member. One of
 * the two facts `repoAccess` loads.
 */
export const orgPermissions = async (
  organizationId: string,
  userId: string,
  options: { readonly withElevation: boolean },
  now: Date = new Date(),
): Promise<readonly string[]> => {
  // Independent reads, so not serialised: the grants do not wait on the role.
  const grants = options.withElevation
    ? approvedGrants(organizationId, userId, now)
    : Promise.resolve<GrantFacts[]>([]);
  const [membership] = await db
    .select({ roleId: organizationMembers.roleId, legacyRole: organizationMembers.role })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!membership) {
    await grants;
    return [];
  }
  const [role] = membership.roleId
    ? await db
        .select({
          isSystem: roles.isSystem,
          systemKey: roles.systemKey,
          permissions: roles.permissions,
        })
        .from(roles)
        .where(eq(roles.id, membership.roleId))
        .limit(1)
    : [];
  return effectivePermissions(membership, role ?? null, await grants, now);
};

export interface UserOrganization {
  readonly id: string;
  readonly name: string;
  /** Its namespace's slug, or null while unclaimed. */
  readonly namespace: string | null;
  readonly namespaceId: string | null;
  /** What a new repository in its namespace starts as. Null while unclaimed. */
  readonly defaultVisibility: "public" | "private" | null;
}

/** The organisations a person belongs to, oldest membership first, with each one's namespace. */
export const listUserOrganizations = (userId: string): Promise<UserOrganization[]> =>
  db
    .select({
      id: organizations.id,
      name: organizations.displayName,
      namespace: gitNamespaces.slug,
      namespaceId: gitNamespaces.id,
      defaultVisibility: gitNamespaces.defaultVisibility,
    })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
    .leftJoin(gitNamespaces, eq(gitNamespaces.organizationId, organizations.id))
    .where(eq(organizationMembers.userId, userId))
    .orderBy(organizationMembers.createdAt);

export const getOrganization = async (
  organizationId: string,
): Promise<{ readonly id: string; readonly name: string } | null> => {
  const [row] = await db
    .select({ id: organizations.id, name: organizations.displayName })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  return row ?? null;
};

/** Domain label of the app's API key hash. Must match `web/src/auth/api-auth.ts`. */
const API_KEY_HASH_DOMAIN = "api-key";

export interface VerifiedApiKey {
  readonly apiKeyId: string;
  readonly organizationId: string;
  /** The key's owner. */
  readonly userId: string;
  /** The key's scopes intersected with its owner's current role: what it may do, in full. */
  readonly permissions: readonly string[];
}

/**
 * Check an `iwk_` key the way the app does (`authenticateApiRequest` and
 * `effectivePermissions` in web): by its keyed hash, not revoked, not
 * expired, its owner still a member, and never more than the owner's role
 * allows. Break-glass grants never reach a key.
 *
 * A key still on the legacy SHA-256 hash is accepted until its sunset, as
 * there, but not rehashed here: the app does that on the key's next use
 * against it, and one writer is enough.
 */
export const verifyApiKey = async (
  token: string,
  now: Date = new Date(),
): Promise<VerifiedApiKey | null> => {
  const live = (hash: string) =>
    db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.hashedKey, hash), isNull(apiKeys.revokedAt)))
      .limit(1);

  let [key] = await live(await keyedHash(token, API_KEY_HASH_DOMAIN));
  if (!key) {
    [key] = await live(await legacySha256Hex(token));
    if (key?.legacyHashSunsetAt && key.legacyHashSunsetAt < now) return null;
  }
  if (!key) return null;
  if (key.expiresAt && key.expiresAt < now) return null;
  if (!(await isMember(key.userId, key.organizationId))) return null;

  const scopes = Array.isArray(key.scopes)
    ? key.scopes.filter((scope): scope is string => typeof scope === "string")
    : [];
  const role = await orgPermissions(key.organizationId, key.userId, { withElevation: false });
  return {
    apiKeyId: key.id,
    organizationId: key.organizationId,
    userId: key.userId,
    permissions: intersectPermissions(role, scopes),
  };
};

/** Note that a key just authenticated. Fire-and-forget: wrap in `keepAlive`. */
export const touchApiKey = async (apiKeyId: string, at: Date = new Date()): Promise<void> => {
  await db.update(apiKeys).set({ lastUsedAt: at }).where(eq(apiKeys.id, apiKeyId));
};
