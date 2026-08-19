/**
 * Alert noise report (`GET /api/org/:orgId/alert-rules/noise`).
 *
 * Mounted beside the alert-rules routes because it is a reading *of* those
 * rules, and takes the same permission they do — the report names rules and
 * their delivery volume, which is the same surface as the rules themselves.
 *
 * Read-only by construction. The report says a rule is noisy; it never disables
 * one, and there is deliberately no endpoint that would.
 */
import { Hono } from "hono";
import { NOISE_LIMITS } from "@infrawrench/client-core";
import { getNoiseReport } from "@infrawrench/server-core/alerts/noise";

import { requirePermission } from "../../auth/permissions";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

app.get("/noise", async (c) => {
  // `org:settings:write`, matching the alert-rules routes this sits beside:
  // there is no read-only settings permission in the catalog, and the report
  // names rules and their delivery volume, which is the same surface as the
  // rules themselves.
  requirePermission(c, "org:settings:write");
  const raw = c.req.query("windowDays");
  const windowDays = raw === undefined ? undefined : Number(raw);
  if (
    windowDays !== undefined &&
    (!Number.isInteger(windowDays) ||
      windowDays < NOISE_LIMITS.minWindowDays ||
      windowDays > NOISE_LIMITS.maxWindowDays)
  ) {
    return c.json(
      {
        error: `windowDays must be a whole number between ${NOISE_LIMITS.minWindowDays} and ${NOISE_LIMITS.maxWindowDays}`,
      },
      400,
    );
  }
  return c.json(
    await getNoiseReport(c.get("organizationId"), windowDays === undefined ? {} : { windowDays }),
  );
});

export { app as alertNoiseRoutes };
