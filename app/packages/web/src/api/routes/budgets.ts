import { Hono } from "hono";
import { and, desc, eq, isNull } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { budgetInputSchema, type CostFilter } from "@infrawrench/ui/cost/config";
import { budgetMonthStatus } from "@infrawrench/server-core/cost/budget-eval";
import { db } from "../../db/client";
import { budgetAlertEvents, budgets } from "../../db/schema";
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

  const rows = await db
    .select()
    .from(budgets)
    .where(and(eq(budgets.organizationId, organizationId), isNull(budgets.deletedAt)))
    .orderBy(budgets.createdAt);

  const result = await Promise.all(
    rows.map(async (b) => {
      const status = await budgetMonthStatus(
        organizationId,
        (b.filters ?? []) as CostFilter[],
        b.currency,
      );
      const events = await db
        .select()
        .from(budgetAlertEvents)
        .where(and(eq(budgetAlertEvents.budgetId, b.id), eq(budgetAlertEvents.month, status.month)))
        .orderBy(desc(budgetAlertEvents.triggeredAt));
      return {
        id: b.id,
        name: b.name,
        amountCents: b.amountCents,
        currency: b.currency,
        filters: b.filters,
        thresholds: b.thresholds,
        month: status.month,
        actualCents: status.actualCents,
        forecastCents: status.forecastCents,
        currentMonthEvents: events.map((e) => ({
          id: e.id,
          thresholdType: e.thresholdType,
          thresholdPercent: e.thresholdPercent,
          triggeredAt: e.triggeredAt.toISOString(),
        })),
      };
    }),
  );
  return c.json(result);
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

  const [created] = await db
    .insert(budgets)
    .values({
      id: uuidv4(),
      organizationId,
      name: parsed.data.name,
      amountCents: parsed.data.amountCents,
      currency: parsed.data.currency,
      filters: parsed.data.filters,
      thresholds: parsed.data.thresholds,
      createdByUserId: session.userId ?? null,
    })
    .returning();
  return c.json(created);
});

/** GET /api/org/:orgId/budgets/:id */
app.get("/:id", async (c) => {
  requirePermission(c, "budgets:read");
  const organizationId = c.get("organizationId");

  const [budget] = await db
    .select()
    .from(budgets)
    .where(
      and(
        eq(budgets.id, c.req.param("id")),
        eq(budgets.organizationId, organizationId),
        isNull(budgets.deletedAt),
      ),
    )
    .limit(1);
  if (!budget) return c.json({ error: "Not found" }, 404);

  const status = await budgetMonthStatus(
    organizationId,
    (budget.filters ?? []) as CostFilter[],
    budget.currency,
  );
  return c.json({ ...budget, ...status });
});

/** PUT /api/org/:orgId/budgets/:id */
app.put("/:id", async (c) => {
  requirePermission(c, "budgets:write");
  const organizationId = c.get("organizationId");

  const parsed = budgetInputSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid budget", issues: parsed.error.issues }, 400);
  }

  const [updated] = await db
    .update(budgets)
    .set({
      name: parsed.data.name,
      amountCents: parsed.data.amountCents,
      currency: parsed.data.currency,
      filters: parsed.data.filters,
      thresholds: parsed.data.thresholds,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(budgets.id, c.req.param("id")),
        eq(budgets.organizationId, organizationId),
        isNull(budgets.deletedAt),
      ),
    )
    .returning();
  if (!updated) return c.json({ error: "Not found" }, 404);
  return c.json(updated);
});

/** DELETE /api/org/:orgId/budgets/:id — soft delete. */
app.delete("/:id", async (c) => {
  requirePermission(c, "budgets:write");
  const organizationId = c.get("organizationId");

  const [deleted] = await db
    .update(budgets)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(budgets.id, c.req.param("id")),
        eq(budgets.organizationId, organizationId),
        isNull(budgets.deletedAt),
      ),
    )
    .returning({ id: budgets.id });
  if (!deleted) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

/** GET /api/org/:orgId/budgets/:id/events — alert history. */
app.get("/:id/events", async (c) => {
  requirePermission(c, "budgets:read");
  const organizationId = c.get("organizationId");

  const [budget] = await db
    .select({ id: budgets.id })
    .from(budgets)
    .where(and(eq(budgets.id, c.req.param("id")), eq(budgets.organizationId, organizationId)))
    .limit(1);
  if (!budget) return c.json({ error: "Not found" }, 404);

  const events = await db
    .select()
    .from(budgetAlertEvents)
    .where(eq(budgetAlertEvents.budgetId, budget.id))
    .orderBy(desc(budgetAlertEvents.triggeredAt))
    .limit(100);
  return c.json(
    events.map((e) => ({
      id: e.id,
      month: e.month,
      thresholdType: e.thresholdType,
      thresholdPercent: e.thresholdPercent,
      actualAmountCents: e.actualAmountCents,
      forecastAmountCents: e.forecastAmountCents,
      triggeredAt: e.triggeredAt.toISOString(),
    })),
  );
});

export { app as budgetRoutes };
