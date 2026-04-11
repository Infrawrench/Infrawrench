import { Hono } from "hono";
import { v4 as uuid } from "uuid";
import { randomBytes } from "node:crypto";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "../../db/client";
import { users, invitations, organizationMembers } from "../../db/schema";
import { logAudit } from "../../services/audit";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
    organizationId: string;
  }
}

const app = new Hono();

/** GET /api/org/:orgId/team/members */
app.get("/members", async (c) => {
  const organizationId = c.get("organizationId");
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      role: organizationMembers.role,
      createdAt: organizationMembers.createdAt,
    })
    .from(organizationMembers)
    .innerJoin(users, eq(organizationMembers.userId, users.id))
    .where(eq(organizationMembers.organizationId, organizationId));
  return c.json(rows);
});

/** GET /api/org/:orgId/team/invitations */
app.get("/invitations", async (c) => {
  const organizationId = c.get("organizationId");
  const rows = await db
    .select({
      id: invitations.id,
      email: invitations.email,
      role: invitations.role,
      acceptedAt: invitations.acceptedAt,
      expiresAt: invitations.expiresAt,
      createdAt: invitations.createdAt,
    })
    .from(invitations)
    .where(eq(invitations.organizationId, organizationId));
  return c.json(rows);
});

/** POST /api/org/:orgId/team/invitations */
app.post("/invitations", async (c) => {
  const session = c.get("session");
  const organizationId = c.get("organizationId");
  const { email, role } = await c.req.json<{ email: string; role: string }>();
  const token = randomBytes(32).toString("base64url");
  const id = uuid();

  await db.insert(invitations).values({
    id,
    organizationId,
    email,
    role,
    invitedByUserId: session.userId,
    token,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  });

  void logAudit({
    organizationId,
    userId: session.userId,
    action: "member.invite",
    entityType: "member",
    entityId: id,
    metadata: { email, role },
  });

  return c.json({ id, token });
});

/** DELETE /api/org/:orgId/team/members/:id */
app.delete("/members/:id", async (c) => {
  const session = c.get("session");
  const organizationId = c.get("organizationId");
  const userId = c.req.param("id");

  await db
    .delete(organizationMembers)
    .where(
      and(
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.organizationId, organizationId),
      ),
    );

  void logAudit({
    organizationId,
    userId: session.userId,
    action: "member.remove",
    entityType: "member",
    entityId: userId,
  });
  return c.json({ ok: true });
});

/** PATCH /api/org/:orgId/team/members/:id/role */
app.patch("/members/:id/role", async (c) => {
  const session = c.get("session");
  const organizationId = c.get("organizationId");
  const userId = c.req.param("id");
  const { role } = await c.req.json<{ role: string }>();

  await db
    .update(organizationMembers)
    .set({ role })
    .where(
      and(
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.organizationId, organizationId),
      ),
    );

  void logAudit({
    organizationId,
    userId: session.userId,
    action: "member.role_change",
    entityType: "member",
    entityId: userId,
    metadata: { newRole: role },
  });
  return c.json({ ok: true });
});

/** DELETE /api/org/:orgId/team/invitations/:id */
app.delete("/invitations/:id", async (c) => {
  const organizationId = c.get("organizationId");
  const invitationId = c.req.param("id");
  await db
    .delete(invitations)
    .where(and(eq(invitations.id, invitationId), eq(invitations.organizationId, organizationId), isNull(invitations.acceptedAt)));
  return c.json({ ok: true });
});

export { app as teamRoutes };
