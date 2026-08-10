import { Hono } from "hono";
import { allocationRuleInputSchema, costCentreInputSchema } from "@infrawrench/ui/cost/config";
import { z } from "zod";
import {
  createAllocationRule,
  createCostCentre,
  deleteAllocationRule,
  deleteCostCentre,
  listAllocationRules,
  listCostCentres,
  swapAllocationRulePriorities,
  updateAllocationRule,
  updateCostCentre,
} from "@infrawrench/server-core/cost/allocation";
import { requirePermission } from "../../auth/permissions";
import { logAudit } from "../../services/audit";
import type { AuthSession } from "../auth-middleware";

const swapRulesBodySchema = z.object({
  aId: z.string().min(1),
  bId: z.string().min(1),
});

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

/**
 * Cost centres and the allocation rules that map spend onto them for
 * showback. Reads ride `costs:read` like the rest of the cost surface;
 * mutations ride `costs:write` (this shapes what the whole org's spend
 * reports say, the same reasoning as anomaly settings).
 */
const app = new Hono();

/** GET /api/org/:orgId/cost-centres — centres, name-sorted. */
app.get("/", async (c) => {
  requirePermission(c, "costs:read");
  return c.json(await listCostCentres(c.get("organizationId")));
});

/** POST /api/org/:orgId/cost-centres — create a centre. */
app.post("/", async (c) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");

  const parsed = costCentreInputSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid cost centre", issues: parsed.error.issues }, 400);
  }

  const centre = await createCostCentre(organizationId, parsed.data);
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "cost_centre.create",
    entityType: "cost_centre",
    entityId: centre.id,
    metadata: { name: centre.name },
  });
  return c.json(centre);
});

/** PUT /api/org/:orgId/cost-centres/:id — rename / redescribe a centre. */
app.put("/:id", async (c) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");

  const parsed = costCentreInputSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid cost centre", issues: parsed.error.issues }, 400);
  }

  const centre = await updateCostCentre(organizationId, c.req.param("id"), parsed.data);
  if (!centre) return c.json({ error: "Not found" }, 404);
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "cost_centre.update",
    entityType: "cost_centre",
    entityId: centre.id,
    metadata: { name: centre.name },
  });
  return c.json(centre);
});

/** DELETE /api/org/:orgId/cost-centres/:id — delete a centre and its rules. */
app.delete("/:id", async (c) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const id = c.req.param("id");

  const deleted = await deleteCostCentre(organizationId, id);
  if (!deleted) return c.json({ error: "Not found" }, 404);
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "cost_centre.delete",
    entityType: "cost_centre",
    entityId: id,
  });
  return c.json({ ok: true });
});

/** GET /api/org/:orgId/cost-centres/rules — rules in evaluation order. */
app.get("/rules", async (c) => {
  requirePermission(c, "costs:read");
  return c.json(await listAllocationRules(c.get("organizationId")));
});

/**
 * POST /api/org/:orgId/cost-centres/rules/swap — atomically swap two rules'
 * priorities. Registered before `/rules/:id` so "swap" is not captured as an id.
 */
app.post("/rules/swap", async (c) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");

  const parsed = swapRulesBodySchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid swap request", issues: parsed.error.issues }, 400);
  }
  if (parsed.data.aId === parsed.data.bId) {
    return c.json({ error: "Cannot swap a rule with itself" }, 400);
  }

  const rules = await swapAllocationRulePriorities(
    organizationId,
    parsed.data.aId,
    parsed.data.bId,
  );
  if (!rules) return c.json({ error: "One or both rules not found" }, 404);
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "cost_allocation_rule.swap",
    entityType: "cost_allocation_rule",
    entityId: parsed.data.aId,
    metadata: { aId: parsed.data.aId, bId: parsed.data.bId },
  });
  return c.json(rules);
});

/** POST /api/org/:orgId/cost-centres/rules — add an allocation rule. */
app.post("/rules", async (c) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");

  const parsed = allocationRuleInputSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid allocation rule", issues: parsed.error.issues }, 400);
  }

  let rule;
  try {
    rule = await createAllocationRule(organizationId, parsed.data);
  } catch (e) {
    console.error("[cost-centres] Failed to create allocation rule:", e);
    return c.json({ error: "Failed to create allocation rule" }, 400);
  }
  if (!rule) return c.json({ error: "Cost centre not found" }, 404);
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "cost_allocation_rule.create",
    entityType: "cost_allocation_rule",
    entityId: rule.id,
    metadata: { costCentreId: rule.costCentreId, match: rule.match },
  });
  return c.json(rule);
});

/** PUT /api/org/:orgId/cost-centres/rules/:id — update an allocation rule. */
app.put("/rules/:id", async (c) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");

  const parsed = allocationRuleInputSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid allocation rule", issues: parsed.error.issues }, 400);
  }

  const rule = await updateAllocationRule(organizationId, c.req.param("id"), parsed.data);
  if (!rule) return c.json({ error: "Not found" }, 404);
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "cost_allocation_rule.update",
    entityType: "cost_allocation_rule",
    entityId: rule.id,
    metadata: { costCentreId: rule.costCentreId, match: rule.match },
  });
  return c.json(rule);
});

/** DELETE /api/org/:orgId/cost-centres/rules/:id — remove a rule. */
app.delete("/rules/:id", async (c) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const id = c.req.param("id");

  const deleted = await deleteAllocationRule(organizationId, id);
  if (!deleted) return c.json({ error: "Not found" }, 404);
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "cost_allocation_rule.delete",
    entityType: "cost_allocation_rule",
    entityId: id,
  });
  return c.json({ ok: true });
});

export { app as costCentreRoutes };
