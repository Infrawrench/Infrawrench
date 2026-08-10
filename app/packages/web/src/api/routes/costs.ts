import { Hono } from "hono";
import {
  costAnomalySettingsSchema,
  costQueryRequestSchema,
  type CostBasis,
} from "@infrawrench/ui/cost/config";
import {
  getOrgAnomalySettings,
  setOrgAnomalySettings,
} from "@infrawrench/server-core/cost/anomaly-settings";
import { isSmsPagingConfigured } from "@infrawrench/server-core/twilio-pager";
import {
  CostQueryError,
  getOrgCostStatus,
  listCostDimensionValues,
  listCostTagKeys,
  runCostQuery,
} from "../../services/cost-query";
import { listRecentCostAnomalies } from "../../services/cost-anomalies";
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
