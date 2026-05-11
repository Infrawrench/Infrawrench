import { Hono } from "hono";
import { v4 as uuid } from "uuid";
import { eq, and, isNull, gt } from "drizzle-orm";
import { db } from "../../db/client";
import { invitations, organizations, organizationMembers } from "../../db/schema";
import {
  ensureSystemRoles,
  getSystemRole,
  isSystemRoleKey,
} from "@infrawrench/server-core/permissions";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

/** GET /api/invitations/by-token/:token — get invite details (for the accept page) */
app.get("/by-token/:token", async (c) => {
  const token = c.req.param("token");

  const rows = await db
    .select({
      id: invitations.id,
      email: invitations.email,
      role: invitations.role,
      expiresAt: invitations.expiresAt,
      acceptedAt: invitations.acceptedAt,
      orgId: invitations.organizationId,
      orgName: organizations.displayName,
    })
    .from(invitations)
    .innerJoin(organizations, eq(invitations.organizationId, organizations.id))
    .where(eq(invitations.token, token))
    .limit(1);

  const invite = rows[0];
  if (!invite) {
    return c.json({ error: "Invitation not found" }, 404);
  }

  return c.json({
    id: invite.id,
    email: invite.email,
    role: invite.role,
    expiresAt: invite.expiresAt,
    acceptedAt: invite.acceptedAt,
    organizationId: invite.orgId,
    organizationName: invite.orgName,
  });
});

/** POST /api/invitations/accept — accept an invitation by token */
app.post("/accept", async (c) => {
  const session = c.get("session");
  const { token } = await c.req.json<{ token: string }>();

  const rows = await db
    .select()
    .from(invitations)
    .where(
      and(
        eq(invitations.token, token),
        isNull(invitations.acceptedAt),
        gt(invitations.expiresAt, new Date()),
      ),
    )
    .limit(1);

  const invite = rows[0];
  if (!invite) {
    return c.json({ error: "Invalid or expired invitation" }, 400);
  }

  if (invite.email !== session.email) {
    return c.json({ error: "This invitation was sent to a different email address" }, 403);
  }

  await ensureSystemRoles(invite.organizationId);
  // Resolve roleId: prefer the explicit invitation roleId; otherwise map the
  // legacy text role to the matching system role.
  let assignedRoleId = invite.roleId;
  if (!assignedRoleId) {
    const key = isSystemRoleKey(invite.role) ? invite.role : "member";
    const sys = await getSystemRole(invite.organizationId, key);
    assignedRoleId = sys.id;
  }

  await db
    .insert(organizationMembers)
    .values({
      id: uuid(),
      userId: session.userId,
      organizationId: invite.organizationId,
      role: invite.role,
      roleId: assignedRoleId,
    })
    .onConflictDoNothing();

  await db.update(invitations).set({ acceptedAt: new Date() }).where(eq(invitations.id, invite.id));

  const orgRows = await db
    .select({ id: organizations.id, displayName: organizations.displayName })
    .from(organizations)
    .where(eq(organizations.id, invite.organizationId))
    .limit(1);

  return c.json({ organization: orgRows[0] });
});

export { app as invitationAcceptRoutes };
