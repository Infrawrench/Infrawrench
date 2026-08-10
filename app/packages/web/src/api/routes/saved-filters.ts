/**
 * HTTP API for saved cost filters (org-scoped, mounted at
 * /api/org/:orgId/saved-cost-filters).
 *
 * A saved filter is a named, reusable `CostFilter[]` that graphs, reports and
 * budgets reference by id; the reference is resolved server-side at query
 * time, so editing the filter here changes every referent at once. CRUD plus
 * `GET /:id/referents`, which answers "what would break if I deleted this".
 *
 * Reads are `costs:read` and writes `costs:write`, like cost reports: a saved
 * filter is a statement about cost data, not dashboard furniture. DELETE is
 * refused with a 409 (body carries `referents`) while anything still points at
 * the filter — see services/saved-cost-filters.ts for the policy rationale.
 * The logic lives in that service so the MCP/chat tools drive exactly the same
 * code path; this file is transport only.
 */
import { Hono, type Context } from "hono";

import { savedCostFilterInputSchema } from "@infrawrench/ui/cost/config";
import { CostQueryParseError } from "@infrawrench/client-core";
import {
  SavedCostFilterInUseError,
  SavedCostFilterNameConflictError,
  createSavedCostFilter,
  getSavedCostFilter,
  listSavedCostFilterReferents,
  listSavedCostFilters,
  softDeleteSavedCostFilter,
  updateSavedCostFilter,
} from "../../services/saved-cost-filters";
import { logAudit } from "../../services/audit";
import type { AuthSession } from "../auth-middleware";
import { requirePermission } from "../../auth/permissions";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

/**
 * Map the write-path failures to responses. Parse errors carry the offset the
 * same way `POST /costs/query` does, so a client can underline the mistake.
 */
function writeError(c: Context, e: unknown) {
  if (e instanceof SavedCostFilterNameConflictError) return c.json({ error: e.message }, 409);
  if (e instanceof CostQueryParseError) {
    return c.json(
      {
        error: `Invalid query at offset ${e.offset}: ${e.message}`,
        queryError: { offset: e.offset, length: e.length, expected: [...e.expected] },
      },
      400,
    );
  }
  if (e instanceof Error) return c.json({ error: e.message }, 400);
  throw e;
}

/** GET /api/org/:orgId/saved-cost-filters — list, alphabetically. */
app.get("/", async (c) => {
  requirePermission(c, "costs:read");
  return c.json(await listSavedCostFilters(c.get("organizationId")));
});

/** POST /api/org/:orgId/saved-cost-filters — create. */
app.post("/", async (c) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");

  const parsed = savedCostFilterInputSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid saved filter", issues: parsed.error.issues }, 400);
  }

  try {
    const created = await createSavedCostFilter(
      organizationId,
      parsed.data,
      session.userId ?? null,
    );
    void logAudit({
      organizationId,
      userId: session.userId,
      action: "saved_cost_filter.create",
      entityType: "saved_cost_filter",
      entityId: created.id,
      metadata: { name: created.name, query: created.query },
    });
    return c.json(created);
  } catch (e) {
    return writeError(c, e);
  }
});

/** GET /api/org/:orgId/saved-cost-filters/:id */
app.get("/:id", async (c) => {
  requirePermission(c, "costs:read");
  const filter = await getSavedCostFilter(c.get("organizationId"), c.req.param("id"));
  if (!filter) return c.json({ error: "Not found" }, 404);
  return c.json(filter);
});

/**
 * PUT /api/org/:orgId/saved-cost-filters/:id — replace name, description and
 * filters. This is the high-leverage write: every graph, report and budget
 * referencing the filter runs the new terms on its next query. The audit entry
 * records the new query text for that reason — "who re-scoped every prod
 * budget" must be answerable.
 */
app.put("/:id", async (c) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");

  const parsed = savedCostFilterInputSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid saved filter", issues: parsed.error.issues }, 400);
  }

  try {
    const updated = await updateSavedCostFilter(organizationId, c.req.param("id"), parsed.data);
    if (!updated) return c.json({ error: "Not found" }, 404);
    void logAudit({
      organizationId,
      userId: session.userId,
      action: "saved_cost_filter.update",
      entityType: "saved_cost_filter",
      entityId: updated.id,
      metadata: { name: updated.name, query: updated.query },
    });
    return c.json(updated);
  } catch (e) {
    return writeError(c, e);
  }
});

/**
 * DELETE /api/org/:orgId/saved-cost-filters/:id — soft delete.
 *
 * Refused with a 409 while any budget, report or dashboard graph references
 * the filter; the body lists the referents so the client can name them.
 * Deleting a referenced filter would silently widen every referent to all
 * spend — for a budget, an alert-firing change — so detachment is deliberate,
 * never a side effect of deletion.
 */
app.delete("/:id", async (c) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const savedFilterId = c.req.param("id");

  try {
    const deleted = await softDeleteSavedCostFilter(organizationId, savedFilterId);
    if (!deleted) return c.json({ error: "Not found" }, 404);
  } catch (e) {
    if (e instanceof SavedCostFilterInUseError) {
      return c.json({ error: e.message, referents: e.referents }, 409);
    }
    throw e;
  }
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "saved_cost_filter.delete",
    entityType: "saved_cost_filter",
    entityId: savedFilterId,
    metadata: {},
  });
  return c.json({ ok: true });
});

/**
 * GET /api/org/:orgId/saved-cost-filters/:id/referents — every budget, report
 * and dashboard graph referencing this filter. What a delete would be refused
 * over, and what an editor shows before letting someone re-scope the filter.
 */
app.get("/:id/referents", async (c) => {
  requirePermission(c, "costs:read");
  const organizationId = c.get("organizationId");
  const savedFilterId = c.req.param("id");

  const filter = await getSavedCostFilter(organizationId, savedFilterId);
  if (!filter) return c.json({ error: "Not found" }, 404);
  return c.json({ referents: await listSavedCostFilterReferents(organizationId, savedFilterId) });
});

export { app as savedFilterRoutes };
