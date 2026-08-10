/**
 * Commitments (org-scoped, mounted at /api/org/:orgId/commitments).
 *
 * Reserved instances, savings plans and committed-use discounts: the
 * holdings themselves, coverage of usage spend (as a range — there is no
 * single honest denominator), derived utilization, and the savings planner's
 * recommendations. Read-only, and deliberately so: this API describes and
 * recommends, it never purchases.
 *
 * Gated on `costs:read` — a commitment is spend information, and the
 * permission that governs "what is this costing us" governs "what did we
 * commit to spending".
 */
import { Hono, type Context } from "hono";

import { getCommitmentsFeed } from "@infrawrench/server-core/commitments/feed";

import { requirePermission } from "../../auth/permissions";

const app = new Hono();

/** GET / — holdings, coverage range, utilization, and recommendations. */
app.get("/", async (c: Context) => {
  requirePermission(c, "costs:read");
  return c.json(await getCommitmentsFeed(c.get("organizationId") as string));
});

export default app;
