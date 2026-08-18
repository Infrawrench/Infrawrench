/**
 * Wallboard route (`GET /api/org/:orgId/wallboard`).
 *
 * `resources:read` and a session, deliberately: unlike the calendar feed and
 * the public status pages, this is **not** an unauthenticated surface. A
 * wallboard carries incident titles, probe names and account names — the shape
 * of the organisation's estate — and a television in an office is exactly the
 * screen a visitor photographs. The machine driving the wall signs in once.
 *
 * Purely a read over already-stored state: no provider API calls.
 */
import { Hono } from "hono";
import { getWallboard } from "@infrawrench/server-core/wallboard/feed";

import { requirePermission } from "../../auth/permissions";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

app.get("/", async (c) => {
  requirePermission(c, "resources:read");
  return c.json(await getWallboard(c.get("organizationId")));
});

export { app as wallboardRoutes };
