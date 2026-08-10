import { Hono } from "hono";
import { hasPermission } from "@infrawrench/server-core/permissions/catalog";
import { listOrphans } from "../../services/orphans";
import { requirePermission } from "../../auth/permissions";

const app = new Hono();

/**
 * GET /api/org/:orgId/orphans — likely-wasted resources (unattached volumes,
 * unassigned IPs, …) grouped by account, classified by each resource type's
 * declarative orphanRule over already-synced state. Read-only and cheap: no
 * provider API calls; cost annotation is best-effort from collected cost rows.
 *
 * Listing needs `resources:read`. The trailing-spend annotation is the same
 * data the cost routes guard with `costs:read`, so callers without that
 * permission get the flagged resources with `cost: null` instead of a 403.
 */
app.get("/", async (c) => {
  requirePermission(c, "resources:read");
  const organizationId = c.get("organizationId");
  const includeCosts = hasPermission(c.get("permissions") ?? [], "costs:read");
  return c.json(await listOrphans(organizationId, { includeCosts }));
});

export { app as orphanRoutes };
