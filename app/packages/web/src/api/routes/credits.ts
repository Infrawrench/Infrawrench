/**
 * Cloud-credit burndown (org-scoped, mounted at /api/org/:orgId/credits).
 *
 * Prepaid balances with a measured burn rate and a runway. Gated on
 * `costs:read` — a credit balance is spend information, and the permission
 * that already governs "what is this costing us" is the one that should
 * govern "how much is left".
 */
import { Hono, type Context } from "hono";

import { getCreditBurndown } from "@infrawrench/server-core/credits/feed";

import { requirePermission } from "../../auth/permissions";

const app = new Hono();

/** GET / — every prepaid pot the org holds, most urgent first. */
app.get("/", async (c: Context) => {
  requirePermission(c, "costs:read");
  return c.json(await getCreditBurndown(c.get("organizationId") as string));
});

export default app;
