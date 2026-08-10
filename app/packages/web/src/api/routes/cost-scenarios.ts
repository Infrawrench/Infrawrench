/**
 * HTTP API for scenario models (org-scoped, mounted at
 * /api/org/:orgId/cost-scenarios).
 *
 * A scenario model is a named, reusable set of adjustments an org overlays on a
 * cost forecast — the known future cost a trend fit cannot see. Charts,
 * reports and budgets reference one by id; the reference is resolved
 * server-side at query time, so editing the model here changes every projection
 * built on it.
 *
 * Reads are `costs:read` and writes `costs:write`, like saved filters and
 * reports: a scenario is a statement about cost data, not dashboard furniture.
 * DELETE is refused with a 409 (body carries `referents`) while anything still
 * points at the model — see services/cost-scenarios.ts for the rationale. The
 * logic lives in that service so the MCP tools drive exactly the same code
 * path; this file is transport only.
 */
import { Hono, type Context } from "hono";

import { costScenarioModelInputSchema } from "@infrawrench/ui/cost/config";
import {
  CostScenarioInUseError,
  CostScenarioLimitError,
  CostScenarioNameConflictError,
  createCostScenarioModel,
  getCostScenarioModel,
  listCostScenarioModels,
  listCostScenarioReferents,
  softDeleteCostScenarioModel,
  updateCostScenarioModel,
} from "../../services/cost-scenarios";
import { logAudit } from "../../services/audit";
import type { AuthSession } from "../auth-middleware";
import { requirePermission } from "../../auth/permissions";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

function writeError(c: Context, e: unknown) {
  if (e instanceof CostScenarioNameConflictError) return c.json({ error: e.message }, 409);
  if (e instanceof CostScenarioLimitError) return c.json({ error: e.message }, 400);
  if (e instanceof Error) return c.json({ error: e.message }, 400);
  throw e;
}

/** GET /api/org/:orgId/cost-scenarios — list, alphabetically. */
app.get("/", async (c) => {
  requirePermission(c, "costs:read");
  return c.json({ models: await listCostScenarioModels(c.get("organizationId")) });
});

/** POST /api/org/:orgId/cost-scenarios — create. */
app.post("/", async (c) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");

  const parsed = costScenarioModelInputSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid scenario model", issues: parsed.error.issues }, 400);
  }

  try {
    const created = await createCostScenarioModel(
      organizationId,
      parsed.data,
      session.userId ?? null,
    );
    void logAudit({
      organizationId,
      userId: session.userId,
      action: "cost_scenario.create",
      entityType: "cost_scenario",
      entityId: created.id,
      metadata: { name: created.name, adjustments: created.adjustments.length },
    });
    return c.json(created);
  } catch (e) {
    return writeError(c, e);
  }
});

/** GET /api/org/:orgId/cost-scenarios/:id */
app.get("/:id", async (c) => {
  requirePermission(c, "costs:read");
  const model = await getCostScenarioModel(c.get("organizationId"), c.req.param("id"));
  if (!model) return c.json({ error: "Not found" }, 404);
  return c.json(model);
});

/**
 * PUT /api/org/:orgId/cost-scenarios/:id — replace the whole model.
 *
 * The high-leverage write: every chart drawing this model and every budget
 * measuring its forecast thresholds against it uses the new numbers on its next
 * evaluation. The audit entry records the adjustment count and the currency for
 * that reason — "who changed the assumptions the prod budget pages on" has to
 * be answerable.
 */
app.put("/:id", async (c) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");

  const parsed = costScenarioModelInputSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid scenario model", issues: parsed.error.issues }, 400);
  }

  try {
    const updated = await updateCostScenarioModel(organizationId, c.req.param("id"), parsed.data);
    if (!updated) return c.json({ error: "Not found" }, 404);
    void logAudit({
      organizationId,
      userId: session.userId,
      action: "cost_scenario.update",
      entityType: "cost_scenario",
      entityId: updated.id,
      metadata: {
        name: updated.name,
        currency: updated.currency,
        adjustments: updated.adjustments.length,
      },
    });
    return c.json(updated);
  } catch (e) {
    return writeError(c, e);
  }
});

/**
 * DELETE /api/org/:orgId/cost-scenarios/:id — soft delete.
 *
 * Refused with a 409 while any budget, report or dashboard graph references the
 * model; the body lists the referents. For a chart, deleting would silently
 * drop the assumptions from a projection somebody is reading; for a budget it
 * would move the forecast thresholds back to the bare trend, changing when
 * people get paged. Neither is ever a side effect of a delete.
 */
app.delete("/:id", async (c) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const modelId = c.req.param("id");

  try {
    const deleted = await softDeleteCostScenarioModel(organizationId, modelId);
    if (!deleted) return c.json({ error: "Not found" }, 404);
  } catch (e) {
    if (e instanceof CostScenarioInUseError) {
      return c.json({ error: e.message, referents: e.referents }, 409);
    }
    throw e;
  }
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "cost_scenario.delete",
    entityType: "cost_scenario",
    entityId: modelId,
    metadata: {},
  });
  return c.json({ ok: true });
});

/**
 * GET /api/org/:orgId/cost-scenarios/:id/referents — every budget, report and
 * dashboard graph referencing this model. What a delete would be refused over,
 * and what an editor names before letting somebody change the assumptions.
 */
app.get("/:id/referents", async (c) => {
  requirePermission(c, "costs:read");
  const organizationId = c.get("organizationId");
  const modelId = c.req.param("id");

  const model = await getCostScenarioModel(organizationId, modelId);
  if (!model) return c.json({ error: "Not found" }, 404);
  return c.json({ referents: await listCostScenarioReferents(organizationId, modelId) });
});

export { app as costScenarioRoutes };
