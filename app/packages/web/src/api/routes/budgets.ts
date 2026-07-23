import { Hono } from "hono";
import { budgetInputSchema } from "@infrawrench/ui/cost/config";
import {
  createBudget,
  getBudgetWithStatus,
  listBudgetEvents,
  listBudgetsWithStatus,
  softDeleteBudget,
  updateBudget,
} from "../../services/budgets";
import type { AuthSession } from "../auth-middleware";
import { requirePermission } from "../../auth/permissions";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

/** GET /api/org/:orgId/budgets — list budgets with current-month status. */
app.get("/", async (c) => {
  requirePermission(c, "budgets:read");
  const organizationId = c.get("organizationId");
  return c.json(await listBudgetsWithStatus(organizationId));
});

/** POST /api/org/:orgId/budgets — create a budget. */
app.post("/", async (c) => {
  requirePermission(c, "budgets:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");

  const parsed = budgetInputSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid budget", issues: parsed.error.issues }, 400);
  }

  return c.json(await createBudget(organizationId, parsed.data, session.userId ?? null));
});

/** GET /api/org/:orgId/budgets/:id */
app.get("/:id", async (c) => {
  requirePermission(c, "budgets:read");
  const organizationId = c.get("organizationId");

  const budget = await getBudgetWithStatus(organizationId, c.req.param("id"));
  if (!budget) return c.json({ error: "Not found" }, 404);
  return c.json(budget);
});

/** PUT /api/org/:orgId/budgets/:id */
app.put("/:id", async (c) => {
  requirePermission(c, "budgets:write");
  const organizationId = c.get("organizationId");

  const parsed = budgetInputSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid budget", issues: parsed.error.issues }, 400);
  }

  const updated = await updateBudget(organizationId, c.req.param("id"), parsed.data);
  if (!updated) return c.json({ error: "Not found" }, 404);
  return c.json(updated);
});

/** DELETE /api/org/:orgId/budgets/:id — soft delete. */
app.delete("/:id", async (c) => {
  requirePermission(c, "budgets:write");
  const organizationId = c.get("organizationId");

  const deleted = await softDeleteBudget(organizationId, c.req.param("id"));
  if (!deleted) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

/** GET /api/org/:orgId/budgets/:id/events — alert history. */
app.get("/:id/events", async (c) => {
  requirePermission(c, "budgets:read");
  const organizationId = c.get("organizationId");

  const events = await listBudgetEvents(organizationId, c.req.param("id"));
  if (!events) return c.json({ error: "Not found" }, 404);
  return c.json(events);
});

export { app as budgetRoutes };
