import { Hono } from "hono";

import { loadDependencyGraph } from "../../services/dependency-graph";
import { requirePermission } from "../../auth/permissions";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

/**
 * GET /api/org/:orgId/dependency-graph — the org's resource dependency graph.
 *
 * `?resourceId=` narrows it to one resource's direct neighbourhood. The
 * assembly itself lives in `services/dependency-graph.ts`, shared with the
 * blast-radius endpoint.
 */
app.get("/", async (c) => {
  requirePermission(c, "resources:read");
  const focusId = c.req.query("resourceId")?.trim() || null;
  return c.json(await loadDependencyGraph(c.get("organizationId"), focusId));
});

export { app as dependencyGraphRoutes };
