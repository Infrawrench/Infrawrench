import { Hono } from "hono";
import { v4 as uuid } from "uuid";
import { db } from "../../db/client";
import { organizations, organizationMembers, dashboards } from "../../db/schema";
import { ensureSystemRoles, getSystemRole } from "@infrawrench/server-core/permissions";
import { ensureDefaultScorecard } from "@infrawrench/server-core/scorecards/store";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

/** POST /api/orgs: create a new organization */
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

  // Seed the default Home dashboard so it's already in the sidebar's
  // dashboard list when the client lands on the new org.
  await db.insert(dashboards).values({
    id: uuid(),
    organizationId: orgId,
    name: "Home",
    isDefault: true,
  });

  // Seed the default scorecard so the first service is graded against
  // something. Best-effort: an org without it seeds lazily on first read.
  await ensureDefaultScorecard(orgId).catch((err: unknown) =>
    console.error("[orgs] default scorecard seed failed:", err),
  );

  return c.json({ id: orgId, displayName: displayName.trim() });
});

export { app as orgManagementRoutes };
