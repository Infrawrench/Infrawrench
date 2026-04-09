import { Hono } from "hono";
import { v4 as uuid } from "uuid";
import { randomBytes } from "node:crypto";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "../../db/client";
import { users, invitations } from "../../db/schema";
import { logAudit } from "../../services/audit";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

/** GET /api/team/members */
app.get("/members", async (c) => {
  const session = c.get("session");
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      role: users.role,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.organizationId, session.organizationId));
  return c.json(rows);
});

/** GET /api/team/invitations */
app.get("/invitations", async (c) => {
  const session = c.get("session");
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
    .where(eq(invitations.organizationId, session.organizationId));
  return c.json(rows);
});

/** POST /api/team/invitations */
app.post("/invitations", async (c) => {
  const session = c.get("session");
  const { email, role } = await c.req.json<{ email: string; role: string }>();
  const token = randomBytes(32).toString("base64url");
  const id = uuid();

  await db.insert(invitations).values({
    id,
    organizationId: session.organizationId,
    email,
    role,
    invitedByUserId: session.userId,
    token,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  });

  void logAudit({
    organizationId: session.organizationId,
    userId: session.userId,
    action: "member.invite",
    entityType: "member",
    entityId: id,
    metadata: { email, role },
  });

  return c.json({ id, token });
});

/** DELETE /api/team/members/:id */
app.delete("/members/:id", async (c) => {
  const session = c.get("session");
  const userId = c.req.param("id");
  await db.delete(users).where(and(eq(users.id, userId), eq(users.organizationId, session.organizationId)));

  void logAudit({
    organizationId: session.organizationId,
    userId: session.userId,
    action: "member.remove",
    entityType: "member",
    entityId: userId,
  });
  return c.json({ ok: true });
});

/** PATCH /api/team/members/:id/role */
app.patch("/members/:id/role", async (c) => {
  const session = c.get("session");
  const userId = c.req.param("id");
  const { role } = await c.req.json<{ role: string }>();
  await db
    .update(users)
    .set({ role, updatedAt: new Date() })
    .where(and(eq(users.id, userId), eq(users.organizationId, session.organizationId)));

  void logAudit({
    organizationId: session.organizationId,
    userId: session.userId,
    action: "member.role_change",
    entityType: "member",
    entityId: userId,
    metadata: { newRole: role },
  });
  return c.json({ ok: true });
});

/** DELETE /api/team/invitations/:id */
app.delete("/invitations/:id", async (c) => {
  const session = c.get("session");
  const invitationId = c.req.param("id");
  await db
    .delete(invitations)
    .where(and(eq(invitations.id, invitationId), eq(invitations.organizationId, session.organizationId), isNull(invitations.acceptedAt)));
  return c.json({ ok: true });
});

export { app as teamRoutes };
