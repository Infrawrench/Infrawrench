/**
 * Anomaly feedback routes, mounted under `/api/org/:orgId/costs` beside the
 * anomaly list (they share the prefix; this file exists so the feedback half
 * can grow without the cost route file importing it).
 *
 * - `POST   /anomalies/:id/feedback`         verdict (+ optional suppression)
 * - `DELETE /anomalies/:id/feedback`         withdraw the verdict
 * - `GET    /anomaly-suppressions`           list
 * - `POST   /anomaly-suppressions`           create by hand
 * - `GET    /anomaly-suppressions/:id`       one
 * - `PUT    /anomaly-suppressions/:id`       edit (whole object)
 * - `DELETE /anomaly-suppressions/:id`       delete
 * - `GET    /anomaly-sensitivity`            keys feedback has moved, and why
 * - `GET    /anomaly-precision?months=`      share of reviewed findings that were real
 *
 * Reads are `costs:read`; writes are `costs:write`, the scope the
 * acknowledgement and the anomaly settings already use: all of it changes
 * what the org's cost feed alerts on.
 */
import { Hono, type Context } from "hono";
import { COST_ANOMALY_FEEDBACK_LIMITS } from "@infrawrench/client-core";
import {
  costAnomalyFeedbackSchema,
  costAnomalySuppressionInputSchema,
} from "@infrawrench/ui/cost/config";
import {
  clearCostAnomalyFeedback,
  createCostAnomalySuppression,
  CostAnomalyFeedbackError,
  deleteCostAnomalySuppression,
  getCostAnomalyPrecision,
  getCostAnomalySensitivity,
  getCostAnomalySuppression,
  listCostAnomalySuppressions,
  submitCostAnomalyFeedback,
  updateCostAnomalySuppression,
} from "../../services/cost-anomaly-feedback";
import { CostAnomalyAcknowledgeError } from "../../services/cost-anomalies";
import { logAudit } from "../../services/audit";
import { requirePermission } from "../../auth/permissions";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

/** Map the two expected failures; anything else is a 500. */
function failure(c: Context, e: unknown) {
  if (e instanceof CostAnomalyFeedbackError) return c.json({ error: e.message }, e.status);
  if (e instanceof CostAnomalyAcknowledgeError) return c.json({ error: e.message }, 400);
  throw e;
}

async function body(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

app.post("/anomalies/:id/feedback", async (c) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const parsed = costAnomalyFeedbackSchema.safeParse(await body(c));
  if (!parsed.success) {
    return c.json({ error: "Invalid feedback", issues: parsed.error.issues }, 400);
  }
  try {
    const result = await submitCostAnomalyFeedback(
      organizationId,
      c.req.param("id"),
      parsed.data,
      session.userId ?? null,
    );
    if (!result) return c.json({ error: "Not found" }, 404);
    void logAudit({
      organizationId,
      userId: session.userId,
      action: "cost_anomaly.feedback",
      entityType: "cost_anomaly",
      entityId: result.anomaly.id,
      metadata: {
        day: result.anomaly.day,
        dimension: result.anomaly.dimension,
        dimensionKey: result.anomaly.dimensionKey,
        verdict: parsed.data.verdict,
        reason: parsed.data.reason ?? null,
        suppressionId: result.suppression?.id ?? null,
      },
    });
    return c.json(result);
  } catch (e) {
    return failure(c, e);
  }
});

app.delete("/anomalies/:id/feedback", async (c) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const anomaly = await clearCostAnomalyFeedback(organizationId, c.req.param("id"));
  if (!anomaly) return c.json({ error: "Not found" }, 404);
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "cost_anomaly.feedback_clear",
    entityType: "cost_anomaly",
    entityId: anomaly.id,
    metadata: {
      day: anomaly.day,
      dimension: anomaly.dimension,
      dimensionKey: anomaly.dimensionKey,
    },
  });
  return c.json(anomaly);
});

app.get("/anomaly-suppressions", async (c) => {
  requirePermission(c, "costs:read");
  return c.json({ suppressions: await listCostAnomalySuppressions(c.get("organizationId")) });
});

app.post("/anomaly-suppressions", async (c) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const parsed = costAnomalySuppressionInputSchema.safeParse(await body(c));
  if (!parsed.success) {
    return c.json({ error: "Invalid suppression", issues: parsed.error.issues }, 400);
  }
  try {
    const created = await createCostAnomalySuppression(
      organizationId,
      parsed.data,
      session.userId ?? null,
    );
    if (!created) return c.json({ error: "Not found" }, 404);
    void logAudit({
      organizationId,
      userId: session.userId,
      action: "cost_anomaly_suppression.create",
      entityType: "cost_anomaly_suppression",
      entityId: created.id,
      metadata: { scope: created.scope, scopeKey: created.scopeKey, expiresOn: created.expiresOn },
    });
    return c.json(created, 201);
  } catch (e) {
    return failure(c, e);
  }
});

app.get("/anomaly-suppressions/:id", async (c) => {
  requirePermission(c, "costs:read");
  const found = await getCostAnomalySuppression(c.get("organizationId"), c.req.param("id"));
  return found ? c.json(found) : c.json({ error: "Not found" }, 404);
});

app.put("/anomaly-suppressions/:id", async (c) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const parsed = costAnomalySuppressionInputSchema.safeParse(await body(c));
  if (!parsed.success) {
    return c.json({ error: "Invalid suppression", issues: parsed.error.issues }, 400);
  }
  try {
    const updated = await updateCostAnomalySuppression(
      organizationId,
      c.req.param("id"),
      parsed.data,
    );
    if (!updated) return c.json({ error: "Not found" }, 404);
    void logAudit({
      organizationId,
      userId: session.userId,
      action: "cost_anomaly_suppression.update",
      entityType: "cost_anomaly_suppression",
      entityId: updated.id,
      metadata: { scope: updated.scope, scopeKey: updated.scopeKey, expiresOn: updated.expiresOn },
    });
    return c.json(updated);
  } catch (e) {
    return failure(c, e);
  }
});

app.delete("/anomaly-suppressions/:id", async (c) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const id = c.req.param("id");
  if (!(await deleteCostAnomalySuppression(organizationId, id))) {
    return c.json({ error: "Not found" }, 404);
  }
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "cost_anomaly_suppression.delete",
    entityType: "cost_anomaly_suppression",
    entityId: id,
  });
  return c.body(null, 204);
});

app.get("/anomaly-sensitivity", async (c) => {
  requirePermission(c, "costs:read");
  return c.json(await getCostAnomalySensitivity(c.get("organizationId")));
});

app.get("/anomaly-precision", async (c) => {
  requirePermission(c, "costs:read");
  const raw = c.req.query("months");
  const months =
    raw === undefined ? COST_ANOMALY_FEEDBACK_LIMITS.precisionDefaultMonths : Number(raw);
  if (
    !Number.isInteger(months) ||
    months < 1 ||
    months > COST_ANOMALY_FEEDBACK_LIMITS.precisionMaxMonths
  ) {
    return c.json(
      {
        error: `months must be an integer between 1 and ${COST_ANOMALY_FEEDBACK_LIMITS.precisionMaxMonths}`,
      },
      400,
    );
  }
  return c.json(await getCostAnomalyPrecision(c.get("organizationId"), months));
});

export { app as costAnomalyFeedbackRoutes };
