/**
 * Infrastructure scorecard routes (`/api/org/:orgId/scorecard*`).
 *
 * The pillars are assembled in server-core (`scorecard/compute.ts`) so this
 * route, the daily poller snapshot and any future digest section share one
 * computation. Purely a read over already-computed feeds: no provider API
 * calls, and no finding is re-derived here.
 *
 * `resources:read` is the whole permission surface. Every underlying feed is
 * readable with it or less, and gating the summary more tightly than its parts
 * would be a lock on a door with no walls. There is deliberately no write
 * endpoint: the weights are not configurable in this version, so there is
 * nothing to set.
 */
import { Hono } from "hono";
import { getScorecard, listScorecardTrend } from "@infrawrench/server-core/scorecard/snapshots";

import { requirePermission } from "../../auth/permissions";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

const MAX_TREND_DAYS = 400;

/**
 * GET /api/org/:orgId/scorecard — the six pillars, the weighted overall, and
 * the stored history.
 */
app.get("/", async (c) => {
  requirePermission(c, "resources:read");
  return c.json(await getScorecard(c.get("organizationId")));
});

/**
 * GET /api/org/:orgId/scorecard/trend?days=… — history alone.
 *
 * Split from the main read because it is the cheap half: a dashboard tile that
 * only wants the sparkline should not pay for six feed computations.
 */
app.get("/trend", async (c) => {
  requirePermission(c, "resources:read");
  const raw = c.req.query("days");
  const days = raw === undefined ? undefined : Number(raw);
  if (days !== undefined && (!Number.isInteger(days) || days < 1 || days > MAX_TREND_DAYS)) {
    return c.json({ error: `days must be a whole number between 1 and ${MAX_TREND_DAYS}` }, 400);
  }
  const trend = await listScorecardTrend(
    c.get("organizationId"),
    days === undefined ? {} : { days },
  );
  return c.json({ trend });
});

export { app as scorecardRoutes };
