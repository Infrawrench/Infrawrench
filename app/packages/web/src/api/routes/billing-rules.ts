import { Hono } from "hono";
import type { Context } from "hono";
import { billingRuleInputSchema } from "@infrawrench/ui/cost/config";
import {
  BillingRuleError,
  BillingRuleNameConflictError,
  createBillingRule,
  deleteBillingRule,
  getBillingRule,
  listBillingRules,
  updateBillingRule,
} from "@infrawrench/server-core/cost/billing-rules";
import { requirePermission } from "../../auth/permissions";
import { logAudit } from "../../services/audit";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

/**
 * Billing rules — the org's own adjustments to collected spend.
 *
 * ## The permission split, and why it is not `costs:write`
 *
 * Reads ride `costs:read` like every other cost surface: a rule is part of the
 * explanation for a number, and hiding it from the people who read the number
 * would make every adjusted figure unauditable.
 *
 * Writes ride **`org:settings:write`**, not `costs:write`, and that is the
 * deliberate part. `costs:write` is the "name a report, define a cost centre,
 * save a filter" scope — acts that add a view of the org's spend. A billing
 * rule is not a view: it changes what every internal figure in the
 * organisation says, in the Costs panel, in an opted-in budget's thresholds, in
 * a chargeback statement a finance team sends to another department. Somebody
 * who can build cost reports should not thereby be able to add 15% to every
 * number the org reports about itself.
 *
 * This is the same reasoning `PUT /currency` and `POST /cost-exports` already
 * follow — stating an exchange rate restates every total, and creating an
 * export ships the billing history somewhere — and it puts all three of the
 * "this changes the org's money story" acts behind one scope.
 *
 * Every mutation is audit-logged. A markup nobody can trace back to a person
 * and a date is the failure mode this feature would otherwise introduce.
 */
const app = new Hono();

function writeError(c: Context, e: unknown) {
  if (e instanceof BillingRuleNameConflictError) return c.json({ error: e.message }, 409);
  if (e instanceof BillingRuleError) return c.json({ error: e.message }, 400);
  throw e;
}

/** GET /api/org/:orgId/billing-rules — rules in evaluation order. */
app.get("/", async (c) => {
  requirePermission(c, "costs:read");
  return c.json(await listBillingRules(c.get("organizationId")));
});

/** GET /api/org/:orgId/billing-rules/:id — one rule. */
app.get("/:id", async (c) => {
  requirePermission(c, "costs:read");
  const rule = await getBillingRule(c.get("organizationId"), c.req.param("id"));
  if (!rule) return c.json({ error: "Not found" }, 404);
  return c.json(rule);
});

/** POST /api/org/:orgId/billing-rules — create a rule. */
app.post("/", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");

  const parsed = billingRuleInputSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid billing rule", issues: parsed.error.issues }, 400);
  }

  let rule;
  try {
    rule = await createBillingRule(organizationId, parsed.data, session.userId);
  } catch (e) {
    return writeError(c, e);
  }
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "billing_rule.create",
    entityType: "billing_rule",
    entityId: rule.id,
    metadata: { name: rule.name, match: rule.match, adjustment: rule.adjustment },
  });
  return c.json(rule);
});

/**
 * PUT /api/org/:orgId/billing-rules/:id — full replace.
 *
 * The whole rule, including `enabled`: switching a markup off for a quarter is
 * an edit of the rule, not a separate verb, so there is one audited action for
 * "this rule changed" rather than two that a reader has to correlate.
 */
app.put("/:id", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");

  const parsed = billingRuleInputSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid billing rule", issues: parsed.error.issues }, 400);
  }

  let rule;
  try {
    rule = await updateBillingRule(organizationId, c.req.param("id"), parsed.data);
  } catch (e) {
    return writeError(c, e);
  }
  if (!rule) return c.json({ error: "Not found" }, 404);
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "billing_rule.update",
    entityType: "billing_rule",
    entityId: rule.id,
    metadata: {
      name: rule.name,
      enabled: rule.enabled,
      match: rule.match,
      adjustment: rule.adjustment,
    },
  });
  return c.json(rule);
});

/**
 * DELETE /api/org/:orgId/billing-rules/:id.
 *
 * Nothing cascades and nothing is restated: no adjustment was ever written into
 * `cost_daily`, so deleting a rule simply means the next read computes without
 * it. A budget measuring adjusted spend keeps working with one fewer rule.
 */
app.delete("/:id", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const id = c.req.param("id");

  const deleted = await deleteBillingRule(organizationId, id);
  if (!deleted) return c.json({ error: "Not found" }, 404);
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "billing_rule.delete",
    entityType: "billing_rule",
    entityId: id,
  });
  return c.json({ ok: true });
});

export { app as billingRuleRoutes };
