import { Hono } from "hono";
import { costQueryRequestSchema } from "@infrawrench/ui/cost/config";
import {
  CostQueryError,
  getOrgCostStatus,
  listCostDimensionValues,
  listCostTagKeys,
  runCostQuery,
} from "../../services/cost-query";
import { listRecentCostAnomalies } from "../../services/cost-anomalies";
import type { AuthSession } from "../auth-middleware";
import { requirePermission } from "../../auth/permissions";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

/** POST /api/org/:orgId/costs/query — aggregate cost series for a graph. */
app.post("/query", async (c) => {
  requirePermission(c, "costs:read");
  const organizationId = c.get("organizationId");

  const parsed = costQueryRequestSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid query", issues: parsed.error.issues }, 400);
  }

  try {
    return c.json(await runCostQuery(organizationId, parsed.data));
  } catch (e) {
    if (e instanceof CostQueryError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

/** GET /api/org/:orgId/costs/dimensions?dimension=service|region|...&tagKey= */
app.get("/dimensions", async (c) => {
  requirePermission(c, "costs:read");
  const organizationId = c.get("organizationId");

  if (c.req.query("dimension") === "tag-keys") {
    return c.json({ values: await listCostTagKeys(organizationId) });
  }

  try {
    const values = await listCostDimensionValues(
      organizationId,
      c.req.query("dimension") ?? "",
      c.req.query("tagKey"),
    );
    return c.json({ values });
  } catch (e) {
    if (e instanceof CostQueryError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

/**
 * GET /api/org/:orgId/costs/anomalies?days=30 — spend anomalies detected by
 * the poller's daily pass, newest day first.
 */
app.get("/anomalies", async (c) => {
  requirePermission(c, "costs:read");
  const organizationId = c.get("organizationId");

  const raw = c.req.query("days");
  const days = raw === undefined ? 30 : Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > 90) {
    return c.json({ error: "days must be an integer between 1 and 90" }, 400);
  }

  return c.json({ anomalies: await listRecentCostAnomalies(organizationId, days) });
});

/**
 * GET /api/org/:orgId/costs/status — per-account cost capability + collection
 * state. Drives "Backfilling AWS history…" empty states and the config UI.
 */
app.get("/status", async (c) => {
  requirePermission(c, "costs:read");
  const organizationId = c.get("organizationId");
  return c.json({ accounts: await getOrgCostStatus(organizationId) });
});

export { app as costRoutes };
