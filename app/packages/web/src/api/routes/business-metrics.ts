/**
 * HTTP API for business metrics and unit costs (org-scoped, mounted at
 * /api/org/:orgId/business-metrics).
 *
 * A business metric is the denominator a unit cost divides by — customers,
 * requests, GB, revenue — reported by the org itself. CRUD on the definition,
 * a batch write for the values, and the unit-cost query that puts the two
 * together.
 *
 * Reads are `costs:read` and writes `costs:write`, matching saved cost filters
 * and the cost-push endpoint: a business metric is a statement about cost data,
 * not dashboard furniture. The logic lives in `services/business-metrics.ts` and
 * `services/unit-cost-query.ts` so the MCP tools and the CLI drive exactly the
 * same code path; this file is transport only.
 */
import { Hono, type Context } from "hono";

import {
  BUSINESS_METRIC_LIMITS,
  businessMetricInputSchema,
  businessMetricValuesBodySchema,
  unitCostQueryRequestSchema,
} from "@infrawrench/ui/cost/config";
import {
  BusinessMetricIngestError,
  ingestMetricValues,
} from "@infrawrench/server-core/cost/metric-ingest";

import {
  BusinessMetricInputError,
  BusinessMetricKeyConflictError,
  createBusinessMetric,
  getBusinessMetric,
  listBusinessMetricValues,
  listBusinessMetrics,
  softDeleteBusinessMetric,
  updateBusinessMetric,
} from "../../services/business-metrics";
import {
  BusinessMetricNotFoundError,
  CostQueryError,
  runUnitCostQuery,
} from "../../services/unit-cost-query";
import { logAudit } from "../../services/audit";
import type { AuthSession } from "../auth-middleware";
import { requirePermission } from "../../auth/permissions";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

/** Map the write-path failures onto responses. */
function writeError(c: Context, e: unknown) {
  if (e instanceof BusinessMetricKeyConflictError) return c.json({ error: e.message }, 409);
  if (e instanceof BusinessMetricInputError) return c.json({ error: e.message }, 400);
  if (e instanceof BusinessMetricIngestError) return c.json({ error: e.message }, 400);
  throw e;
}

/** GET /api/org/:orgId/business-metrics — list, by key, with coverage. */
app.get("/", async (c) => {
  requirePermission(c, "costs:read");
  return c.json({ metrics: await listBusinessMetrics(c.get("organizationId")) });
});

/** POST /api/org/:orgId/business-metrics — create. */
app.post("/", async (c) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");

  const parsed = businessMetricInputSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid business metric", issues: parsed.error.issues }, 400);
  }

  try {
    const created = await createBusinessMetric(organizationId, parsed.data, session.userId ?? null);
    void logAudit({
      organizationId,
      userId: session.userId,
      action: "business_metric.create",
      entityType: "business_metric",
      entityId: created.id,
      metadata: { key: created.key, kind: created.kind, unit: created.unit },
    });
    return c.json(created);
  } catch (e) {
    return writeError(c, e);
  }
});

/** GET /api/org/:orgId/business-metrics/:id — by id **or** key. */
app.get("/:id", async (c) => {
  requirePermission(c, "costs:read");
  const metric = await getBusinessMetric(c.get("organizationId"), c.req.param("id"));
  if (!metric) return c.json({ error: "Not found" }, 404);
  return c.json(metric);
});

/**
 * PUT /api/org/:orgId/business-metrics/:id — replace the definition.
 *
 * A full replace, matching budgets and saved filters. Changing `key` is allowed
 * and never orphans history (values are keyed on the metric's id), but it does
 * break a workflow still writing to the old key — which is the honest outcome,
 * and why the key is separate from the display name.
 */
app.put("/:id", async (c) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");

  const parsed = businessMetricInputSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid business metric", issues: parsed.error.issues }, 400);
  }

  try {
    const updated = await updateBusinessMetric(organizationId, c.req.param("id"), parsed.data);
    if (!updated) return c.json({ error: "Not found" }, 404);
    void logAudit({
      organizationId,
      userId: session.userId,
      action: "business_metric.update",
      entityType: "business_metric",
      entityId: updated.id,
      metadata: { key: updated.key, kind: updated.kind, unit: updated.unit },
    });
    return c.json(updated);
  } catch (e) {
    return writeError(c, e);
  }
});

/**
 * DELETE /api/org/:orgId/business-metrics/:id — soft delete.
 *
 * Not refused when a graph references it, unlike a saved filter. The failure
 * modes are opposite: an unresolvable saved filter would silently *widen* a
 * budget to all spend, while a unit-cost card whose metric is gone fails its
 * query loudly and says so. A chart that quietly reverted to plain spend would
 * be the bad outcome here, and nothing does that.
 */
app.delete("/:id", async (c) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const metricId = c.req.param("id");

  const metric = await getBusinessMetric(organizationId, metricId);
  if (!metric) return c.json({ error: "Not found" }, 404);
  const deleted = await softDeleteBusinessMetric(organizationId, metric.id);
  if (!deleted) return c.json({ error: "Not found" }, 404);

  void logAudit({
    organizationId,
    userId: session.userId,
    action: "business_metric.delete",
    entityType: "business_metric",
    entityId: metric.id,
    metadata: { key: metric.key },
  });
  return c.json({ ok: true });
});

/**
 * GET /api/org/:orgId/business-metrics/:id/values?limit= — reported values,
 * newest day first.
 */
app.get("/:id/values", async (c) => {
  requirePermission(c, "costs:read");
  const metric = await getBusinessMetric(c.get("organizationId"), c.req.param("id"));
  if (!metric) return c.json({ error: "Not found" }, 404);

  const raw = c.req.query("limit");
  const limit = raw === undefined ? 90 : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > BUSINESS_METRIC_LIMITS.maxValuesPageSize) {
    return c.json(
      {
        error: `limit must be an integer between 1 and ${BUSINESS_METRIC_LIMITS.maxValuesPageSize}`,
      },
      400,
    );
  }
  return c.json({ values: await listBusinessMetricValues(metric.id, limit) });
});

/**
 * POST /api/org/:orgId/business-metrics/:id/values — report a batch of days.
 *
 * **Re-reporting a day restates it rather than adding to it**, so a nightly job
 * is safe to retry — an accumulating write would double every number the first
 * time the job re-ran, and nothing about the resulting chart would look wrong.
 * The audit entry records how many days were written, because "who restated
 * March" has to be answerable.
 */
app.post("/:id/values", async (c) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");

  const metric = await getBusinessMetric(organizationId, c.req.param("id"));
  if (!metric) return c.json({ error: "Not found" }, 404);

  const parsed = businessMetricValuesBodySchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid values", issues: parsed.error.issues }, 400);
  }

  try {
    const result = await ingestMetricValues({
      organizationId,
      metricId: metric.id,
      values: parsed.data.values,
      source: {
        errorPrefix: "business-metrics/values",
        source: "api",
        userId: session.userId ?? null,
        maxValues: BUSINESS_METRIC_LIMITS.maxValuesPerCall,
      },
    });
    void logAudit({
      organizationId,
      userId: session.userId,
      action: "business_metric.values.write",
      entityType: "business_metric",
      entityId: metric.id,
      metadata: { key: metric.key, days: result.written },
    });
    return c.json(result);
  } catch (e) {
    return writeError(c, e);
  }
});

/**
 * POST /api/org/:orgId/business-metrics/:id/unit-costs — spend ÷ metric, or
 * margin, bucketed the way the caller asked.
 *
 * A read, so `costs:read` — it computes nothing that is stored. A bucket with
 * no metric value comes back with `value: null` and a `gap` reason rather than
 * a zero; see `server-core/cost/unit-costs.ts` for why that distinction is the
 * one this endpoint exists to preserve.
 */
app.post("/:id/unit-costs", async (c) => {
  requirePermission(c, "costs:read");
  const organizationId = c.get("organizationId");

  const parsed = unitCostQueryRequestSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid unit-cost query", issues: parsed.error.issues }, 400);
  }

  try {
    return c.json(await runUnitCostQuery(organizationId, c.req.param("id"), parsed.data));
  } catch (e) {
    if (e instanceof BusinessMetricNotFoundError) return c.json({ error: e.message }, 404);
    if (e instanceof CostQueryError) {
      return c.json(
        { error: e.message, ...(e.queryError ? { queryError: e.queryError } : {}) },
        400,
      );
    }
    throw e;
  }
});

export { app as businessMetricRoutes };
