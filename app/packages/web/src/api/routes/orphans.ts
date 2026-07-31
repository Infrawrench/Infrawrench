import { Hono } from "hono";
import { listOrphans } from "../../services/orphans";
import { requirePermission } from "../../auth/permissions";

const app = new Hono();

/**
 * GET /api/org/:orgId/orphans — likely-wasted resources (unattached volumes,
 * unassigned IPs, …) grouped by account, classified by each resource type's
 * declarative orphanRule over already-synced state. Read-only and cheap: no
 * provider API calls; cost annotation is best-effort from collected cost rows.
 */
app.get("/", async (c) => {
  requirePermission(c, "resources:read");
  const organizationId = c.get("organizationId");
  return c.json(await listOrphans(organizationId));
});

export { app as orphanRoutes };
