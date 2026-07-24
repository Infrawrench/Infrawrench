import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { organizations, organizationMembers, subscriptions } from "../../db/schema";
import { platformAdminMiddleware } from "../../auth/platform-admin";

/**
 * Platform-admin routes (mounted at /api/admin). Session-authed and then
 * gated by the INFRAWRENCH_PLATFORM_ADMIN_EMAILS allowlist — these operate
 * across all orgs, so org membership and org roles don't apply here.
 */
const app = new Hono();

app.use("*", platformAdminMiddleware);

/** GET /api/admin/organizations — every org with billing-relevant state. */
app.get("/organizations", async (c) => {
  const rows = await db
    .select({
      id: organizations.id,
      displayName: organizations.displayName,
      complimentary: organizations.complimentary,
      createdAt: organizations.createdAt,
      memberCount: sql<number>`(
        select count(*)::int from ${organizationMembers}
        where ${organizationMembers.organizationId} = ${organizations.id}
      )`,
      subscriptionStatus: subscriptions.status,
    })
    .from(organizations)
    .leftJoin(subscriptions, eq(subscriptions.organizationId, organizations.id))
    .orderBy(organizations.createdAt);
  return c.json(rows);
});

/** PUT /api/admin/organizations/:orgId/complimentary — grant or revoke. */
app.put("/organizations/:orgId/complimentary", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { complimentary?: unknown } | null;
  if (!body || typeof body.complimentary !== "boolean") {
    return c.json({ error: "Body must be { complimentary: boolean }" }, 400);
  }

  const [updated] = await db
    .update(organizations)
    .set({ complimentary: body.complimentary, updatedAt: new Date() })
    .where(eq(organizations.id, c.req.param("orgId")))
    .returning({ id: organizations.id, complimentary: organizations.complimentary });
  if (!updated) return c.json({ error: "Organization not found" }, 404);

  console.log(
    `[admin] ${c.get("session").email} set complimentary=${updated.complimentary} on org ${updated.id}`,
  );
  return c.json(updated);
});

export { app as adminRoutes };
