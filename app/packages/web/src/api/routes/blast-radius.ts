import { Hono } from "hono";

import { getBlastRadius } from "../../services/blast-radius";
import { requirePermission } from "../../auth/permissions";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

/**
 * GET /api/org/:orgId/blast-radius?resourceId=… — what breaks if this is
 * deleted.
 *
 * `resourceId` is a query parameter, not a path segment: composite resource
 * ids contain slashes and colons, which is why the ownership and lease routes
 * take it the same way.
 *
 * `resources:read`, not `resources:delete`. The report is a read over the
 * dependency graph, the flow warehouse and a dozen org objects the caller can
 * already list — gating it on the delete permission would mean the people who
 * *cannot* delete a resource also cannot find out what would break, which is
 * exactly backwards for the person writing the change request.
 *
 * The handler never fails for a partial answer; the service turns each
 * unavailable source into an entry in the report's `unchecked` list instead.
 */
app.get("/", async (c) => {
  requirePermission(c, "resources:read");
  const resourceId = c.req.query("resourceId")?.trim();
  if (!resourceId) return c.json({ error: "Missing resourceId" }, 400);
  return c.json(await getBlastRadius(c.get("organizationId"), resourceId));
});

export { app as blastRadiusRoutes };
