import { withAuth } from "@workos-inc/authkit-nextjs";
import { db } from "@/db/client";
import { organizations, users } from "@/db/schema";

export interface AuthSession {
  userId: string;
  organizationId: string;
  email: string;
}

/**
 * Get the current session from WorkOS AuthKit and ensure the user/org
 * records exist in our DB (auto-provision on first login).
 *
 * withAuth({ ensureSignedIn: true }) redirects to WorkOS automatically if not
 * signed in, so control only reaches the code below when a user is present.
 */
export async function requireAuth(): Promise<AuthSession> {
  const { user, organizationId: rawOrgId } = await withAuth({ ensureSignedIn: true });

  // WorkOS users not assigned to an organization get a personal synthetic org.
  // This covers solo development accounts and single-user installs.
  const orgId = rawOrgId ?? `personal:${user.id}`;

  // Upsert organization
  await db
    .insert(organizations)
    .values({ id: orgId, displayName: rawOrgId ? orgId : `${user.email}'s workspace` })
    .onConflictDoNothing();

  // Upsert user
  await db
    .insert(users)
    .values({
      id: user.id,
      organizationId: orgId,
      email: user.email,
      displayName: `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() || null,
    })
    .onConflictDoNothing();

  return {
    userId: user.id,
    organizationId: orgId,
    email: user.email,
  };
}
