import { Hono } from "hono";
import {
  COST_EFFICIENCY_LIMITS,
  EFFICIENCY_ALERT_KINDS,
  type EfficiencyAlertKind,
} from "@infrawrench/client-core";
import {
  costAnomalyAcknowledgeSchema,
  costAnomalySettingsSchema,
  costEfficiencySettingsSchema,
  costQueryRequestSchema,
  type CostBasis,
} from "@infrawrench/ui/cost/config";
import {
  getOrgAnomalySettings,
  setOrgAnomalySettings,
} from "@infrawrench/server-core/cost/anomaly-settings";
import {
  getOrgEfficiencySettings,
  setOrgEfficiencySettings,
} from "@infrawrench/server-core/cost/efficiency-settings";
import { listEfficiencyAlerts } from "../../services/efficiency-alerts";
import { isSmsPagingConfigured } from "@infrawrench/server-core/twilio-pager";
import {
  CostQueryError,
  getOrgCostStatus,
  listCostDimensionValues,
  listCostTagKeys,
  runCostQuery,
} from "../../services/cost-query";
import {
  acknowledgeCostAnomaly,
  CostAnomalyAcknowledgeError,
  listRecentCostAnomalies,
} from "../../services/cost-anomalies";
import { logAudit } from "../../services/audit";
import { getUntaggedSpendReport } from "../../services/tag-policy";
import { getShowbackReport } from "../../services/showback";
import type { AuthSession } from "../auth-middleware";
import { requirePermission } from "../../auth/permissions";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

/**
 * POST /api/org/:orgId/costs/query — aggregate cost series for a graph.
 *
 * The filter can be sent either structurally (`filters`) or as text in the cost
 * query language (`query`, e.g. `provider = 'aws' AND tag['env'] != 'dev'`).
 * Both at once is a 400: they are two spellings of one filter, and picking a
 * winner would silently answer a different question than the caller asked.
 *
 * A parse failure comes back as a 400 whose body carries `queryError` — the
 * offset, the span length, and the valid alternatives at that point — so a
 * client can underline the mistake rather than restate the message.
 */
app.post("/query", async (c) => {
  requirePermission(c, "costs:read");
  const organizationId = c.get("organizationId");

  const parsed = costQueryRequestSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid query", issues: parsed.error.issues }, 400);
  }

  try {
    return c.json(await runCostQuery(organizationId, parsed.data));
  } catch (e) {
    if (e instanceof CostQueryError) {
      return c.json(
        { error: e.message, ...(e.queryError ? { queryError: e.queryError } : {}) },
        400,
      );
    }
    throw e;
  }
});

/** GET /api/org/:orgId/costs/dimensions?dimension=service|region|...&tagKey= */
app.get("/dimensions", async (c) => {
  requirePermission(c, "costs:read");
  const organizationId = c.get("organizationId");

  if (c.req.query("dimension") === "tag-keys") {
    return c.json({ values: await listCostTagKeys(organizationId) });
  }

  try {
    const values = await listCostDimensionValues(
      organizationId,
      c.req.query("dimension") ?? "",
      c.req.query("tagKey"),
    );
    return c.json({ values });
  } catch (e) {
    if (e instanceof CostQueryError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

/**
 * GET /api/org/:orgId/costs/anomalies?days=30 — spend anomalies detected by
 * the poller's daily pass, newest day first.
 */
app.get("/anomalies", async (c) => {
  requirePermission(c, "costs:read");
  const organizationId = c.get("organizationId");

  const raw = c.req.query("days");
  const days = raw === undefined ? 30 : Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > 90) {
    return c.json({ error: "days must be an integer between 1 and 90" }, 400);
  }

  return c.json({ anomalies: await listRecentCostAnomalies(organizationId, days) });
});

/**
 * POST /api/org/:orgId/costs/anomalies/:id/acknowledge — explain a finding.
 *
 * Body: `{ "explanation": "Migrated the API fleet to Graviton" }`.
 *
 * Acknowledging records the sentence on the anomaly **and** creates the
 * annotation that says it on every cost chart covering that day — the point of
 * the whole thing being that "we migrated the fleet" is not a fact about
 * whichever chart the reader happened to open. The reply is the updated
 * anomaly, carrying the acknowledgement and the id of the note it made.
 *
 * `costs:write`, matching the annotation it creates. It does not suppress
 * anything: the same key spiking again next month is a new finding, detected
 * and alerted on as normal.
 */
app.post("/anomalies/:id/acknowledge", async (c) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const anomalyId = c.req.param("id");

  const parsed = costAnomalyAcknowledgeSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid acknowledgement", issues: parsed.error.issues }, 400);
  }

  try {
    const anomaly = await acknowledgeCostAnomaly(
      organizationId,
      anomalyId,
      parsed.data.explanation,
      session.userId ?? null,
    );
    if (!anomaly) return c.json({ error: "Not found" }, 404);
    void logAudit({
      organizationId,
      userId: session.userId,
      action: "cost_anomaly.acknowledge",
      entityType: "cost_anomaly",
      entityId: anomaly.id,
      metadata: {
        day: anomaly.day,
        dimension: anomaly.dimension,
        dimensionKey: anomaly.dimensionKey,
        explanation: anomaly.acknowledgement?.explanation ?? null,
        annotationId: anomaly.acknowledgement?.annotationId ?? null,
      },
    });
    return c.json(anomaly);
  } catch (e) {
    // An empty sentence, or one past the annotation ceiling.
    if (e instanceof CostAnomalyAcknowledgeError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

/**
 * GET /api/org/:orgId/costs/anomaly-settings — the org's detection thresholds.
 * An org that has never changed them reads as the shipped defaults.
 *
 * `smsConfigured` rides along because `smsAlerts` alone cannot tell a form the
 * truth: an org can ask for texts while having no Twilio credentials or no
 * recipient opted into SMS, and nothing would be sent. The Twilio routes that
 * hold that fact are `org:settings:write`, which a `costs:read` member does not
 * have — so the answer is derived here rather than fetched by the client.
 */
app.get("/anomaly-settings", async (c) => {
  requirePermission(c, "costs:read");
  const organizationId = c.get("organizationId");
  const [settings, smsConfigured] = await Promise.all([
    getOrgAnomalySettings(organizationId),
    isSmsPagingConfigured(organizationId),
  ]);
  return c.json({ ...settings, smsConfigured });
});

/**
 * PUT /api/org/:orgId/costs/anomaly-settings — retune detection.
 *
 * Gated on `costs:write`, the permission the other mutating cost route
 * (`POST /costs/rows`) uses. It is not a budget, so `budgets:write` would be
 * the wrong family: this changes what the org's whole cost feed alerts on.
 */
app.put("/anomaly-settings", async (c) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId");

  const parsed = costAnomalySettingsSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid anomaly settings", issues: parsed.error.issues }, 400);
  }

  const [settings, smsConfigured] = await Promise.all([
    setOrgAnomalySettings(organizationId, parsed.data),
    isSmsPagingConfigured(organizationId),
  ]);
  return c.json({ ...settings, smsConfigured });
});

/**
 * GET /api/org/:orgId/costs/efficiency-alerts?kind=&limit= — what the three
 * efficiency detectors have fired, newest first.
 *
 * One feed rather than three endpoints: every surface renders them in one
 * list, and three round trips for one section would be three chances for a
 * partial render.
 */
app.get("/efficiency-alerts", async (c) => {
  requirePermission(c, "costs:read");
  const organizationId = c.get("organizationId");

  const rawKind = c.req.query("kind");
  if (rawKind !== undefined && !EFFICIENCY_ALERT_KINDS.includes(rawKind as EfficiencyAlertKind)) {
    return c.json({ error: `kind must be one of ${EFFICIENCY_ALERT_KINDS.join(", ")}` }, 400);
  }

  const rawLimit = c.req.query("limit");
  const limit =
    rawLimit === undefined ? COST_EFFICIENCY_LIMITS.defaultEventsLimit : Number(rawLimit);
  if (
    !Number.isInteger(limit) ||
    limit < COST_EFFICIENCY_LIMITS.minEventsLimit ||
    limit > COST_EFFICIENCY_LIMITS.maxEventsLimit
  ) {
    return c.json(
      {
        error:
          `limit must be an integer between ${COST_EFFICIENCY_LIMITS.minEventsLimit} and ` +
          `${COST_EFFICIENCY_LIMITS.maxEventsLimit}`,
      },
      400,
    );
  }

  const events = await listEfficiencyAlerts(organizationId, {
    kind: rawKind as EfficiencyAlertKind | undefined,
    limit,
  });
  return c.json({ events });
});

/**
 * GET /api/org/:orgId/costs/efficiency-alert-settings — the org's tuning for
 * commitment expiry, idle commitments and unit-cost regression. An org that
 * has never changed one reads back the defaults.
 */
app.get("/efficiency-alert-settings", async (c) => {
  requirePermission(c, "costs:read");
  return c.json(await getOrgEfficiencySettings(c.get("organizationId")));
});

/**
 * PUT /api/org/:orgId/costs/efficiency-alert-settings — retune the three
 * efficiency detectors.
 *
 * `costs:write`, matching `PUT /costs/anomaly-settings` and for the same
 * reason: this is not a budget, and it changes what the org's whole cost feed
 * alerts on rather than one cost object.
 */
app.put("/efficiency-alert-settings", async (c) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId");

  const parsed = costEfficiencySettingsSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid efficiency alert settings", issues: parsed.error.issues }, 400);
  }

  return c.json(await setOrgEfficiencySettings(organizationId, parsed.data));
});

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `?basis=cash|amortized` for the reports that follow one. Anything else — an
 * absent param, or a typo — reads as cash, the basis these reports have always
 * been computed on. A typo silently changing which money is reported would be
 * worse than ignoring it.
 */
function parseBasis(c: {
  req: { query(name: string): string | undefined };
}): CostBasis | undefined {
  return c.req.query("basis") === "amortized" ? "amortized" : undefined;
}

/** Parse `?from&to` (both YYYY-MM-DD); defaults to the trailing 30 days. */
function parseRange(c: {
  req: { query(name: string): string | undefined };
}): { from: string; to: string } | null {
  const today = new Date().toISOString().slice(0, 10);
  const defaultFrom = new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
  const from = c.req.query("from") ?? defaultFrom;
  const to = c.req.query("to") ?? today;
  if (!ISO_DAY.test(from) || !ISO_DAY.test(to) || from > to) return null;
  return { from, to };
}

/**
 * GET /api/org/:orgId/costs/untagged?from&to — spend on rows missing at least
 * one of the org's required tag keys, overall and per key, plus the largest
 * untagged (account, service) buckets. Empty when no tag policy is set.
 */
app.get("/untagged", async (c) => {
  requirePermission(c, "costs:read");
  const range = parseRange(c);
  if (!range) return c.json({ error: "from/to must be YYYY-MM-DD with from <= to" }, 400);
  return c.json(
    await getUntaggedSpendReport(c.get("organizationId"), range.from, range.to, parseBasis(c)),
  );
});

/**
 * GET /api/org/:orgId/costs/showback?from&to&currency= — spend grouped by cost
 * centre through the org's allocation rules; unclaimed spend lands in
 * "Unallocated".
 *
 * `?currency=` is the opt-in conversion. Omitted (and for any org that has not
 * configured that display currency) the report is per-currency exactly as
 * before; present, the response carries a `conversion` block naming the rates
 * used and any currency that had none.
 *
 * `?adjusted=true` is the other opt-in: the org's billing rules applied, with
 * the collected totals returned beside them in `adjustment`. Off by default,
 * like every adjusted surface — a chargeback report that silently showed
 * marked-up numbers is one the receiving team could not reconcile.
 */
app.get("/showback", async (c) => {
  requirePermission(c, "costs:read");
  const range = parseRange(c);
  if (!range) return c.json({ error: "from/to must be YYYY-MM-DD with from <= to" }, 400);
  const currency = c.req.query("currency");
  return c.json(
    await getShowbackReport(
      c.get("organizationId"),
      range.from,
      range.to,
      parseBasis(c),
      currency,
      c.req.query("adjusted") === "true",
    ),
  );
});

/**
 * GET /api/org/:orgId/costs/status — per-account cost capability + collection
 * state. Drives "Backfilling AWS history…" empty states and the config UI.
 */
app.get("/status", async (c) => {
  requirePermission(c, "costs:read");
  const organizationId = c.get("organizationId");
  return c.json({ accounts: await getOrgCostStatus(organizationId) });
});

export { app as costRoutes };
