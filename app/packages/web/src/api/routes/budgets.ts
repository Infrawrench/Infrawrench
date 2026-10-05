import { Hono } from "hono";
import { budgetAlertNoteSchema, budgetInputSchema } from "@infrawrench/ui/cost/config";
import { BudgetAlertNoteError, noteBudgetAlertEvent } from "../../services/budget-alert-notes";
import { logAudit } from "../../services/audit";
import {
  BudgetValidationError,
  createBudget,
  getBudgetWithStatus,
  listBudgetEvents,
  listBudgetsWithStatus,
  softDeleteBudget,
  updateBudget,
} from "../../services/budgets";
import { SavedCostFilterResolutionError } from "@infrawrench/server-core/cost/saved-filters";
import { AlertEmailRecipientsError } from "@infrawrench/server-core/alerts/email-errors";
import type { AuthSession } from "../auth-middleware";
import { requirePermission } from "../../auth/permissions";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

/** GET /api/org/:orgId/budgets: list budgets with current-month status. */
app.get("/", async (c) => {
  requirePermission(c, "budgets:read");
  const organizationId = c.get("organizationId");
  return c.json(await listBudgetsWithStatus(organizationId));
});

/** POST /api/org/:orgId/budgets: create a budget. */
app.post("/", async (c) => {
  requirePermission(c, "budgets:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");

  const parsed = budgetInputSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid budget", issues: parsed.error.issues }, 400);
  }

  try {
    return c.json(await createBudget(organizationId, parsed.data, session.userId ?? null));
  } catch (e) {
    // A budget must not be born pointing at a saved filter that doesn't
    // resolve: it would error every evaluation from day one.
    if (e instanceof SavedCostFilterResolutionError) return c.json({ error: e.message }, 400);
    if (e instanceof BudgetValidationError) return c.json({ error: e.message }, 400);
    if (e instanceof AlertEmailRecipientsError) return c.json({ error: e.message }, 400);
    throw e;
  }
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

  try {
    const updated = await updateBudget(organizationId, c.req.param("id"), parsed.data);
    if (!updated) return c.json({ error: "Not found" }, 404);
    return c.json(updated);
  } catch (e) {
    if (e instanceof SavedCostFilterResolutionError) return c.json({ error: e.message }, 400);
    if (e instanceof BudgetValidationError) return c.json({ error: e.message }, 400);
    if (e instanceof AlertEmailRecipientsError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

/** DELETE /api/org/:orgId/budgets/:id: soft delete. */
app.delete("/:id", async (c) => {
  requirePermission(c, "budgets:write");
  const organizationId = c.get("organizationId");

  const deleted = await softDeleteBudget(organizationId, c.req.param("id"));
  if (!deleted) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

/**
 * POST /api/org/:orgId/budgets/:id/events/:eventId/note: explain a firing.
 *
 * Saves the note on the alert, draws it on every cost chart as an org-wide
 * annotation at the day the alert fired (in one transaction), then posts it
 * after the alert: a reply in each Slack message's thread, and a follow-up to
 * the Teams webhooks it reached. Sending again rewrites the note and rewords
 * the same marker. The reply carries the event and the follow-up counts.
 *
 * `budgets:read` to address the budget and `costs:write` for the annotation it
 * creates, the permission anomaly explanations and hand-written notes need.
 */
app.post("/:id/events/:eventId/note", async (c) => {
  requirePermission(c, "budgets:read");
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");

  const parsed = budgetAlertNoteSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid note", issues: parsed.error.issues }, 400);
  }
  try {
    const result = await noteBudgetAlertEvent(
      organizationId,
      c.req.param("id"),
      c.req.param("eventId"),
      parsed.data.note,
      session.userId ?? null,
    );
    if (!result) return c.json({ error: "Not found" }, 404);
    void logAudit({
      organizationId,
      userId: session.userId,
      action: "budget_alert.note",
      entityType: "budget",
      entityId: c.req.param("id"),
      metadata: {
        eventId: result.id,
        month: result.month,
        thresholdType: result.thresholdType,
        thresholdPercent: result.thresholdPercent,
        note: result.note?.text ?? null,
        annotationId: result.note?.annotationId ?? null,
      },
    });
    return c.json(result);
  } catch (e) {
    if (e instanceof BudgetAlertNoteError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

/** GET /api/org/:orgId/budgets/:id/events: alert history. */
app.get("/:id/events", async (c) => {
  requirePermission(c, "budgets:read");
  const organizationId = c.get("organizationId");

  const events = await listBudgetEvents(organizationId, c.req.param("id"));
  if (!events) return c.json({ error: "Not found" }, 404);
  return c.json(events);
});

export { app as budgetRoutes };
