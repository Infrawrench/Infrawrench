import { Hono } from "hono";
import {
  metricAlertRuleInputSchema,
  metricAlertSelectorSchema,
} from "@infrawrench/ui/metric-alerts/config";
import { listMetricSeriesKeys } from "@infrawrench/server-core/clickhouse/readers";
import {
  createRule,
  getRule,
  listEvents,
  listRulesWithStatus,
  listSelectorOptions,
  previewSelector,
  softDeleteRule,
  updateRule,
} from "../../services/metric-alerts";
import type { AuthSession } from "../auth-middleware";
import { requirePermission } from "../../auth/permissions";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

/** GET /api/org/:orgId/metric-alerts — list rules with live firing status. */
app.get("/", async (c) => {
  requirePermission(c, "metric-alerts:read");
  const organizationId = c.get("organizationId");
  return c.json(await listRulesWithStatus(organizationId));
});

/** POST /api/org/:orgId/metric-alerts — create a rule. */
app.post("/", async (c) => {
  requirePermission(c, "metric-alerts:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");

  // The `.catch(() => null)` turns malformed JSON into a schema failure and
  // the documented 400, instead of an unhandled parse error (pages.ts stance).
  const parsed = metricAlertRuleInputSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "Invalid metric alert rule", issues: parsed.error.issues }, 400);
  }
  return c.json(await createRule(organizationId, parsed.data, session.userId ?? null));
});

/**
 * GET /api/org/:orgId/metric-alerts/metric-keys — the series labels that
 * actually exist for the org (optionally narrowed to plugin/type), so the
 * rule builder offers real metrics rather than asking for internal names.
 */
app.get("/metric-keys", async (c) => {
  requirePermission(c, "metric-alerts:read");
  const organizationId = c.get("organizationId");
  const pluginId = c.req.query("pluginId") || undefined;
  const resourceTypeId = c.req.query("resourceTypeId") || undefined;
  return c.json(await listMetricSeriesKeys(organizationId, { pluginId, resourceTypeId }));
});

/** GET /api/org/:orgId/metric-alerts/selector-options — what there is to select on. */
app.get("/selector-options", async (c) => {
  requirePermission(c, "metric-alerts:read");
  const organizationId = c.get("organizationId");
  return c.json(await listSelectorOptions(organizationId));
});

/** GET /api/org/:orgId/metric-alerts/selector-preview — what a selector matches now. */
app.get("/selector-preview", async (c) => {
  requirePermission(c, "metric-alerts:read");
  const organizationId = c.get("organizationId");
  const parsed = metricAlertSelectorSchema.safeParse({
    pluginId: c.req.query("pluginId") || null,
    resourceTypeId: c.req.query("resourceTypeId") || null,
    tagKey: c.req.query("tagKey") || null,
    tagValue: c.req.query("tagValue") || null,
  });
  if (!parsed.success) {
    return c.json({ error: "Invalid selector", issues: parsed.error.issues }, 400);
  }
  return c.json(await previewSelector(organizationId, parsed.data));
});

/** GET /api/org/:orgId/metric-alerts/events — recent firings, org-wide or per rule. */
app.get("/events", async (c) => {
  requirePermission(c, "metric-alerts:read");
  const organizationId = c.get("organizationId");
  const ruleId = c.req.query("ruleId") || undefined;
  const limitRaw = Number(c.req.query("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : undefined;
  return c.json(await listEvents(organizationId, { ruleId, limit }));
});

/** GET /api/org/:orgId/metric-alerts/:id */
app.get("/:id", async (c) => {
  requirePermission(c, "metric-alerts:read");
  const organizationId = c.get("organizationId");
  const rule = await getRule(organizationId, c.req.param("id"));
  if (!rule) return c.json({ error: "Not found" }, 404);
  return c.json(rule);
});

/** PUT /api/org/:orgId/metric-alerts/:id */
app.put("/:id", async (c) => {
  requirePermission(c, "metric-alerts:write");
  const organizationId = c.get("organizationId");

  const parsed = metricAlertRuleInputSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "Invalid metric alert rule", issues: parsed.error.issues }, 400);
  }
  const updated = await updateRule(organizationId, c.req.param("id"), parsed.data);
  if (!updated) return c.json({ error: "Not found" }, 404);
  return c.json(updated);
});

/** DELETE /api/org/:orgId/metric-alerts/:id — soft delete; history stays. */
app.delete("/:id", async (c) => {
  requirePermission(c, "metric-alerts:write");
  const organizationId = c.get("organizationId");
  const deleted = await softDeleteRule(organizationId, c.req.param("id"));
  if (!deleted) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

export { app as metricAlertRoutes };
