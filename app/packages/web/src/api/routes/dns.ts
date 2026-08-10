/**
 * DNS inventory route (`/api/org/:orgId/dns`).
 *
 * The inventory is assembled in server-core (`dns/feed.ts`) so the web API,
 * the MCP tool and the posture pass share one computation. Purely a read over
 * already-synced state: no provider API calls, and no DNS resolution — a
 * record's target is judged against what we synced, never against what the
 * internet currently answers.
 *
 * There is no settings sibling here on purpose. Dangling records alert as
 * posture findings, so the on/off switch is `/posture/settings`.
 */
import { Hono } from "hono";
import { listDns } from "@infrawrench/server-core/dns/feed";
import { requirePermission } from "../../auth/permissions";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

/**
 * GET /api/org/:orgId/dns — every zone and record across every connected
 * provider, with each record target classified as owned, dangling, external or
 * not analysed.
 */
app.get("/", async (c) => {
  requirePermission(c, "resources:read");
  return c.json(await listDns(c.get("organizationId")));
});

export { app as dnsRoutes };
