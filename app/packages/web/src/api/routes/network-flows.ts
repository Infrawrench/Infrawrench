import { Hono, type Context } from "hono";

import { getNetworkFlowFeed } from "@infrawrench/server-core/network-flow/feed";
import {
  getKubernetesNetworkReport,
  getKubernetesNetworkSettings,
  KubernetesNetworkError,
  setKubernetesNetworkSettings,
} from "@infrawrench/server-core/network-flow/kubernetes";
import {
  getNetworkFlowSettings,
  setNetworkFlowSettings,
  NetworkFlowSettingsError,
} from "@infrawrench/server-core/network-flow/settings";
import {
  getNetworkFlowReportOptions,
  NetworkFlowReportError,
  runNetworkFlowReportConfig,
} from "@infrawrench/server-core/network-flow/report";
import {
  normalizeNetworkFlowReportConfig,
  normalizeNetworkFlowReportInput,
} from "@infrawrench/client-core";
import { logAudit } from "../../services/audit";
import { CostReportFolderError } from "../../services/cost-report-folders";
import {
  createNetworkFlowReport,
  getNetworkFlowReport,
  listNetworkFlowReports,
  runSavedNetworkFlowReport,
  softDeleteNetworkFlowReport,
  updateNetworkFlowReport,
} from "../../services/network-flow-reports";
import { NETWORK_FLOW_SCOPES } from "@infrawrench/plugin-base";

import type { AuthSession } from "../auth-middleware";
import { requirePermission } from "../../auth/permissions";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Default window: the last 14 days.
 *
 * Shorter than the cost surface's 30 because flow retention is shorter (AWS
 * CloudWatch log groups commonly keep 7 or 30 days and the plugin will not ask
 * beyond 14) so a 30-day default would open on a chart that is empty for the
 * first half and look broken.
 */
function parseRange(c: Context): { from: string; to: string } | null {
  const today = new Date().toISOString().slice(0, 10);
  const defaultFrom = new Date(Date.now() - 13 * 86_400_000).toISOString().slice(0, 10);
  const from = c.req.query("from") ?? defaultFrom;
  const to = c.req.query("to") ?? today;
  if (!ISO_DAY.test(from) || !ISO_DAY.test(to) || from > to) return null;
  return { from, to };
}

/**
 * GET /; the whole network-costs screen: boundary summary, top pairs,
 * per-account collection state and the rate cards the money came from.
 *
 * `costs:read`, not a permission of its own. This is spend information (the
 * same class of fact as "what did EC2 cost") and splitting it behind a second
 * read permission would mean an org could grant someone the bill without the
 * explanation of it, which is the pairing nobody wants.
 */
app.get("/", async (c: Context) => {
  requirePermission(c, "costs:read");
  const range = parseRange(c);
  if (!range) return c.json({ error: "from/to must be YYYY-MM-DD with from <= to" }, 400);

  const scope = c.req.query("scope");
  if (scope !== undefined && !NETWORK_FLOW_SCOPES.includes(scope as never)) {
    return c.json({ error: `scope must be one of ${NETWORK_FLOW_SCOPES.join(", ")}` }, 400);
  }

  const rawLimit = c.req.query("limit");
  const limit = rawLimit === undefined ? 50 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    return c.json({ error: "limit must be an integer between 1 and 200" }, 400);
  }

  return c.json(
    await getNetworkFlowFeed(c.get("organizationId") as string, {
      from: range.from,
      to: range.to,
      limit,
      ...(scope ? { scope } : {}),
      ...(c.req.query("accountId") ? { accountId: c.req.query("accountId") } : {}),
    }),
  );
});

function kubernetesError(c: Context, e: unknown) {
  if (e instanceof KubernetesNetworkError) return c.json({ error: e.message }, e.status);
  throw e;
}

/**
 * GET /kubernetes/:accountId; one cluster's network costs by namespace,
 * workload and boundary. `costs:read`, like the org-wide screen.
 */
app.get("/kubernetes/:accountId", async (c: Context) => {
  requirePermission(c, "costs:read");
  const range = parseRange(c);
  if (!range) return c.json({ error: "from/to must be YYYY-MM-DD with from <= to" }, 400);
  const rawLimit = c.req.query("limit");
  const limit = rawLimit === undefined ? 25 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    return c.json({ error: "limit must be an integer between 1 and 200" }, 400);
  }
  try {
    return c.json(
      await getKubernetesNetworkReport(
        c.get("organizationId") as string,
        c.req.param("accountId") as string,
        { ...range, limit },
      ),
    );
  } catch (e) {
    return kubernetesError(c, e);
  }
});

app.get("/kubernetes/:accountId/settings", async (c: Context) => {
  requirePermission(c, "costs:read");
  try {
    return c.json(
      await getKubernetesNetworkSettings(
        c.get("organizationId") as string,
        c.req.param("accountId") as string,
      ),
    );
  } catch (e) {
    return kubernetesError(c, e);
  }
});

/**
 * PUT /kubernetes/:accountId/settings; the cluster's billed data-transfer
 * source. `costs:write`: it changes how collected money is apportioned on
 * screen, never what is collected or spent. Audit-logged because it moves
 * money between teams' views.
 */
app.put("/kubernetes/:accountId/settings", async (c: Context) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId") as string;
  const accountId = c.req.param("accountId") as string;
  const session = c.get("session");
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const billedQuery = body?.["billedQuery"];
  if (billedQuery !== null && typeof billedQuery !== "string") {
    return c.json({ error: "billedQuery must be a string or null" }, 400);
  }
  try {
    const settings = await setKubernetesNetworkSettings(
      organizationId,
      accountId,
      { billedQuery },
      session.userId,
    );
    void logAudit({
      organizationId,
      userId: session.userId,
      action: "network_flows.kubernetes_settings.update",
      entityType: "account",
      entityId: accountId,
      metadata: { billedQuery: settings.billedQuery },
    });
    return c.json(settings);
  } catch (e) {
    return kubernetesError(c, e);
  }
});

/** GET /settings: the org's collection switch, without the data. */
app.get("/settings", async (c: Context) => {
  requirePermission(c, "costs:read");
  return c.json(await getNetworkFlowSettings(c.get("organizationId") as string));
});

/**
 * PUT /settings: turn collection on or off.
 *
 * `org:settings:write`, deliberately not `costs:write`. Turning this on does
 * not edit a cost object; it authorizes Infrawrench to run queries that the
 * *provider bills to the organization's own cloud account* every day, in
 * perpetuity, until somebody turns it off. That is a governance decision of the
 * same kind as a billing rule or an exchange rate, and it is audit-logged for
 * the same reason: when the line shows up on a bill review, somebody needs to
 * be able to find out who agreed to it.
 */
app.put("/settings", async (c: Context) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId") as string;
  const session = c.get("session");

  const body = (await c.req.json()) as Record<string, unknown>;
  if (typeof body["enabled"] !== "boolean") {
    return c.json({ error: "enabled must be a boolean" }, 400);
  }
  const lookback = body["initialLookbackDays"];
  if (lookback !== undefined && typeof lookback !== "number") {
    return c.json({ error: "initialLookbackDays must be a number" }, 400);
  }

  try {
    const current = await getNetworkFlowSettings(organizationId);
    const settings = await setNetworkFlowSettings(
      organizationId,
      {
        enabled: body["enabled"],
        initialLookbackDays: (lookback as number | undefined) ?? current.initialLookbackDays,
      },
      session.userId,
    );
    void logAudit({
      organizationId,
      userId: session.userId,
      action: settings.enabled ? "network_flows.enable" : "network_flows.disable",
      entityType: "organization",
      entityId: organizationId,
      metadata: { initialLookbackDays: settings.initialLookbackDays },
    });
    return c.json(settings);
  } catch (e) {
    if (e instanceof NetworkFlowSettingsError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

/* ------------------------------------------------------------------ *
 * Saved network flow reports
 *
 * CRUD follows the cost reports' rules (report folders, per-object sharing,
 * soft delete): `costs:read` to list and run, `costs:write` to change, each
 * write audit-logged as `network_flow_report.*`. The storage and access rules
 * are in `services/network-flow-reports.ts`, the reads in server-core, the
 * assembly and validation in client-core.
 * ------------------------------------------------------------------ */

async function readJson(c: Context): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    return { ok: true, body: await c.req.json() };
  } catch {
    return { ok: false };
  }
}

function reportError(c: Context, e: unknown) {
  if (e instanceof NetworkFlowReportError || e instanceof CostReportFolderError) {
    return c.json({ error: e.message }, 400);
  }
  throw e;
}

/** GET /report-options: picker values for the report editor. */
app.get("/report-options", async (c: Context) => {
  requirePermission(c, "costs:read");
  return c.json(await getNetworkFlowReportOptions(c.get("organizationId") as string));
});

/**
 * POST /report-query: run an unsaved config (the editor's preview, and ad-hoc
 * runs from the API and CLI). A read despite the method, like `/costs/query`.
 */
app.post("/report-query", async (c: Context) => {
  requirePermission(c, "costs:read");
  const json = await readJson(c);
  if (!json.ok) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = normalizeNetworkFlowReportConfig(json.body);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  try {
    return c.json(
      await runNetworkFlowReportConfig(c.get("organizationId") as string, parsed.value),
    );
  } catch (e) {
    return reportError(c, e);
  }
});

/** GET /reports: saved reports the caller may open. */
app.get("/reports", async (c: Context) => {
  requirePermission(c, "costs:read");
  return c.json(await listNetworkFlowReports(c.get("organizationId") as string));
});

/** POST /reports: create a saved report. */
app.post("/reports", async (c: Context) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId") as string;
  const session = c.get("session");
  const json = await readJson(c);
  if (!json.ok) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = normalizeNetworkFlowReportInput(json.body);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  try {
    const created = await createNetworkFlowReport(
      organizationId,
      parsed.value,
      session.userId ?? null,
    );
    void logAudit({
      organizationId,
      userId: session.userId,
      action: "network_flow_report.create",
      entityType: "network_flow_report",
      entityId: created.id,
      metadata: { name: created.name },
    });
    return c.json(created);
  } catch (e) {
    return reportError(c, e);
  }
});

/** GET /reports/:id */
app.get("/reports/:id", async (c: Context) => {
  requirePermission(c, "costs:read");
  const report = await getNetworkFlowReport(
    c.get("organizationId") as string,
    c.req.param("id") as string,
  );
  if (!report) return c.json({ error: "Not found" }, 404);
  return c.json(report);
});

/** PUT /reports/:id: replace name, description, config and folder. */
app.put("/reports/:id", async (c: Context) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId") as string;
  const session = c.get("session");
  const json = await readJson(c);
  if (!json.ok) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = normalizeNetworkFlowReportInput(json.body);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  try {
    const updated = await updateNetworkFlowReport(
      organizationId,
      c.req.param("id") as string,
      parsed.value,
    );
    if (!updated) return c.json({ error: "Not found" }, 404);
    void logAudit({
      organizationId,
      userId: session.userId,
      action: "network_flow_report.update",
      entityType: "network_flow_report",
      entityId: updated.id,
      metadata: { name: updated.name },
    });
    return c.json(updated);
  } catch (e) {
    return reportError(c, e);
  }
});

/** DELETE /reports/:id: soft delete. */
app.delete("/reports/:id", async (c: Context) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId") as string;
  const session = c.get("session");
  const reportId = c.req.param("id") as string;
  if (!(await softDeleteNetworkFlowReport(organizationId, reportId))) {
    return c.json({ error: "Not found" }, 404);
  }
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "network_flow_report.delete",
    entityType: "network_flow_report",
    entityId: reportId,
    metadata: {},
  });
  return c.json({ ok: true });
});

/** POST /reports/:id/run: execute a saved report. A read despite the method. */
app.post("/reports/:id/run", async (c: Context) => {
  requirePermission(c, "costs:read");
  try {
    const result = await runSavedNetworkFlowReport(
      c.get("organizationId") as string,
      c.req.param("id") as string,
    );
    if (!result) return c.json({ error: "Not found" }, 404);
    return c.json(result);
  } catch (e) {
    return reportError(c, e);
  }
});

export { app as networkFlowRoutes };
