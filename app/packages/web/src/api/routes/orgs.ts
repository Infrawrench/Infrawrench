import { Hono } from "hono";
import { v4 as uuid } from "uuid";
import { db } from "../../db/client";
import { organizations, organizationMembers } from "../../db/schema";
import { ensureSystemRoles, getSystemRole } from "@infrawrench/server-core/permissions";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

/** POST /api/orgs — create a new organization */
app.post("/", async (c) => {
  const session = c.get("session");
  const { displayName } = await c.req.json<{ displayName: string }>();

  if (!displayName?.trim()) {
    return c.json({ error: "Organization name is required" }, 400);
  }

  const orgId = uuid();

  await db.insert(organizations).values({
    id: orgId,
    displayName: displayName.trim(),
  });

  await ensureSystemRoles(orgId);
  const ownerRole = await getSystemRole(orgId, "owner");

  await db.insert(organizationMembers).values({
    id: uuid(),
    userId: session.userId,
    organizationId: orgId,
    role: "owner",
    roleId: ownerRole.id,
  });

  return c.json({ id: orgId, displayName: displayName.trim() });
});

export { app as orgManagementRoutes };
