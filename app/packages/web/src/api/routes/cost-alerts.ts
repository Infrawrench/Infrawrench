/**
 * Change-based cost alerts — org-scoped CRUD plus the fired-event feed.
 *
 * The third cost-alert family, distinct from the other two on purpose:
 * budgets (`routes/budgets.ts`) fire on an absolute monthly total, anomaly
 * detection (`routes/costs.ts` anomalies) fires on unconfigured statistical
 * outliers, and these fire on a configured relative change on a chosen scope
 * and cadence. Evaluation runs from the poller (`cost/change-eval.ts`);
 * these routes only manage the configuration and read what fired.
 *
 * Reads need `costs:read`, writes `costs:write` — the cost-reports stance.
 * Logic lives in `services/cost-alerts.ts` so the MCP/chat tools share the
 * code path; this file is transport only.
 */
import { Hono } from "hono";
import { costAlertInputSchema } from "@infrawrench/ui/cost/config";
import {
  CostAlertLimitError,
  createCostAlert,
  getCostAlert,
  listCostAlertEventsForOrg,
  listCostAlerts,
  softDeleteCostAlert,
  updateCostAlert,
} from "../../services/cost-alerts";
import { logAudit } from "../../services/audit";
import type { AuthSession } from "../auth-middleware";
import { requirePermission } from "../../auth/permissions";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

app.get("/", async (c) => {
  requirePermission(c, "costs:read");
  const organizationId = c.get("organizationId");
  const alerts = await listCostAlerts(organizationId);
  return c.json({ alerts });
});

// Before "/:id": Hono matches in registration order and "events" is not an id.
app.get("/events", async (c) => {
  requirePermission(c, "costs:read");
  const organizationId = c.get("organizationId");
  const alertId = c.req.query("alertId");
  const rawLimit = c.req.query("limit");
  const limit = rawLimit === undefined ? undefined : Number(rawLimit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    return c.json({ error: "limit must be a positive integer" }, 400);
  }
  const events = await listCostAlertEventsForOrg(organizationId, {
    ...(alertId ? { alertId } : {}),
    ...(limit !== undefined ? { limit } : {}),
  });
  if (events === null) return c.json({ error: "Not found" }, 404);
  return c.json({ events });
});

app.get("/:id", async (c) => {
  requirePermission(c, "costs:read");
  const organizationId = c.get("organizationId");
  const alert = await getCostAlert(organizationId, c.req.param("id"));
  if (!alert) return c.json({ error: "Not found" }, 404);
  return c.json(alert);
});

app.post("/", async (c) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const parsed = costAlertInputSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid cost alert", issues: parsed.error.issues }, 400);
  }
  try {
    const created = await createCostAlert(organizationId, parsed.data, session.userId ?? null);
    void logAudit({
      organizationId,
      userId: session.userId,
      action: "cost_alert.create",
      entityType: "cost_alert",
      entityId: created.id,
      metadata: { name: created.name, cadence: created.cadence },
    });
    return c.json(created);
  } catch (e) {
    if (e instanceof CostAlertLimitError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

app.put("/:id", async (c) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const parsed = costAlertInputSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid cost alert", issues: parsed.error.issues }, 400);
  }
  const updated = await updateCostAlert(organizationId, c.req.param("id"), parsed.data);
  if (!updated) return c.json({ error: "Not found" }, 404);
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "cost_alert.update",
    entityType: "cost_alert",
    entityId: updated.id,
    metadata: { name: updated.name, cadence: updated.cadence },
  });
  return c.json(updated);
});

app.delete("/:id", async (c) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const alertId = c.req.param("id");
  const deleted = await softDeleteCostAlert(organizationId, alertId);
  if (!deleted) return c.json({ error: "Not found" }, 404);
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "cost_alert.delete",
    entityType: "cost_alert",
    entityId: alertId,
    metadata: {},
  });
  return c.json({ ok: true });
});

export { app as costAlertRoutes };
