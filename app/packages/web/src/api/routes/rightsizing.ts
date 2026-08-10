import { Hono } from "hono";
import { listRightsizing } from "../../services/rightsizing";
import { requirePermission } from "../../auth/permissions";

const app = new Hono();

/**
 * GET /api/org/:orgId/rightsizing — "Oversized" recommendations: resources
 * whose plugin declares `rightsizing`, whose stored p95 CPU/memory over the
 * last 14 days sits under the thresholds, each matched with the cheapest
 * catalog size that still clears headroom and a live-priced monthly saving.
 *
 * `resources:read`, like orphans — the list is derived from the org's
 * resource set (prices are catalog rates, not the org's billing data).
 * Recomputed on demand with a short in-memory cache; `?refresh=true`
 * bypasses it (the section's Refresh button).
 *
 * Applying a recommendation is NOT a route here: the UI submits the size
 * field through the ordinary `POST /resources/update` path, which is what
 * carries change-freeze enforcement and audit logging.
 */
app.get("/", async (c) => {
  requirePermission(c, "resources:read");
  const organizationId = c.get("organizationId");
  const refresh = c.req.query("refresh") === "true";
  return c.json(await listRightsizing(organizationId, { refresh }));
});

export { app as rightsizingRoutes };
