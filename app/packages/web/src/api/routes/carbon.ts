/**
 * Carbon estimate route (`GET /api/org/:orgId/carbon`).
 *
 * `costs:read`, not `resources:read`: this is a figure people put beside spend
 * and into reports, it is grouped by account the way cost is, and the surface
 * it appears on is the Costs screen. Gating it with the cost permission keeps
 * "who may see the organization's reporting figures" one answer rather than two.
 *
 * The estimate is assembled in `services/carbon.ts`, which needs plugin clients
 * to resolve instance types to vCPU counts.
 */
import { Hono } from "hono";
import { CARBON_LIMITS } from "@infrawrench/client-core";

import { getCarbonEstimate } from "../../services/carbon";
import { requirePermission } from "../../auth/permissions";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

app.get("/", async (c) => {
  requirePermission(c, "costs:read");
  const raw = c.req.query("windowDays");
  const windowDays = raw === undefined ? undefined : Number(raw);
  if (
    windowDays !== undefined &&
    (!Number.isInteger(windowDays) ||
      windowDays < CARBON_LIMITS.minWindowDays ||
      windowDays > CARBON_LIMITS.maxWindowDays)
  ) {
    return c.json(
      {
        error: `windowDays must be a whole number between ${CARBON_LIMITS.minWindowDays} and ${CARBON_LIMITS.maxWindowDays}`,
      },
      400,
    );
  }
  return c.json(
    await getCarbonEstimate(
      c.get("organizationId"),
      windowDays === undefined ? {} : { windowDays },
    ),
  );
});

export { app as carbonRoutes };
