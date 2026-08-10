/**
 * Provider status correlation — `GET /api/org/{orgId}/status-incidents`.
 *
 * Thin route: all the work (matching cached provider incidents against the
 * org's resources, counting overlapping changes) lives in server-core
 * `status/match.ts` so the poller's notifier, the MCP tool, and this route
 * share one implementation.
 */
import { Hono } from "hono";
import { getOrgStatusIncidents } from "@infrawrench/server-core/status/match";
import { requirePermission } from "../../auth/permissions";

const app = new Hono();

app.get("/", async (c) => {
  requirePermission(c, "resources:read");
  const organizationId = c.get("organizationId");
  const incidents = await getOrgStatusIncidents(organizationId);
  return c.json({ incidents });
});

export { app as statusIncidentRoutes };
