/**
 * Query monitor routes (`/api/org/:orgId/query-monitors*`).
 *
 * Reading takes `resources:read`. **Writing and test-running take
 * `resources:execute`** — the same permission the SQL editor needs — because
 * saving a monitor is arranging for a query to be executed against a customer
 * database on a schedule, forever, and that is a strictly larger act than
 * running one yourself while watching it.
 *
 * The read-only guard on the SQL is enforced in the store, on every execution
 * rather than only on save, so a row that reaches the table by some other route
 * still cannot write.
 */
import { Hono } from "hono";
import type {
  QueryMonitorInput,
  QueryMonitorMode,
  QueryMonitorOperator,
} from "@infrawrench/client-core";
import { foldMonitorRun } from "@infrawrench/client-core";
import {
  QueryMonitorInputError,
  createQueryMonitor,
  deleteQueryMonitor,
  getQueryMonitor,
  listQueryMonitorTargets,
  listQueryMonitors,
  runMonitorQuery,
  updateQueryMonitor,
} from "@infrawrench/server-core/query-monitors/store";

import { requirePermission } from "../../auth/permissions";
import { logAudit } from "../../services/audit";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

const MODES: QueryMonitorMode[] = ["scalar", "rowCount"];
const OPERATORS: QueryMonitorOperator[] = ["gt", "gte", "lt", "lte", "eq", "neq"];

async function readObjectBody(req: {
  json: () => Promise<unknown>;
}): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; error: string }> {
  try {
    const parsed = await req.json();
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false, error: "Request body must be an object" };
    }
    return { ok: true, body: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, error: "Invalid JSON body" };
  }
}

function readMonitorBody(
  body: Record<string, unknown>,
): { ok: true; value: Partial<QueryMonitorInput> } | { ok: false; error: string } {
  const out: Partial<QueryMonitorInput> = {};
  for (const key of ["name", "accountId", "sql"] as const) {
    if (key in body) {
      const raw = body[key];
      if (typeof raw !== "string") return { ok: false, error: `${key} must be a string` };
      out[key] = raw;
    }
  }
  for (const key of ["description", "resourceId", "resourceTypeId"] as const) {
    if (key in body) {
      const raw = body[key];
      if (raw !== null && typeof raw !== "string") {
        return { ok: false, error: `${key} must be a string or null` };
      }
      out[key] = raw;
    }
  }
  if ("mode" in body) {
    const raw = body["mode"];
    if (typeof raw !== "string" || !MODES.includes(raw as QueryMonitorMode)) {
      return { ok: false, error: `mode must be one of ${MODES.join(", ")}` };
    }
    out.mode = raw as QueryMonitorMode;
  }
  if ("operator" in body) {
    const raw = body["operator"];
    if (typeof raw !== "string" || !OPERATORS.includes(raw as QueryMonitorOperator)) {
      return { ok: false, error: `operator must be one of ${OPERATORS.join(", ")}` };
    }
    out.operator = raw as QueryMonitorOperator;
  }
  for (const key of ["threshold", "intervalMinutes", "consecutiveBreaches"] as const) {
    if (key in body) {
      const raw = body[key];
      if (typeof raw !== "number" || !Number.isFinite(raw)) {
        return { ok: false, error: `${key} must be a number` };
      }
      out[key] = raw;
    }
  }
  if ("enabled" in body) {
    const raw = body["enabled"];
    if (typeof raw !== "boolean") return { ok: false, error: "enabled must be a boolean" };
    out.enabled = raw;
  }
  return { ok: true, value: out };
}

/** GET /api/org/:orgId/query-monitors */
app.get("/", async (c) => {
  requirePermission(c, "resources:read");
  return c.json({ monitors: await listQueryMonitors(c.get("organizationId")) });
});

/**
 * GET /api/org/:orgId/query-monitors/targets — what a monitor can run against.
 *
 * Powers the editor's target picker: each account with a SQL driver of its
 * own, plus the SQL-capable resources inside it (a ClickHouse service, a D1 or
 * Turso database, a BigQuery dataset). Registered before `/:monitorId` so
 * "targets" is never read as a monitor id.
 */
app.get("/targets", async (c) => {
  requirePermission(c, "resources:read");
  return c.json({ accounts: await listQueryMonitorTargets(c.get("organizationId")) });
});

/**
 * POST /api/org/:orgId/query-monitors/test — run a query once, without saving.
 *
 * The editor's "try it" button. Takes `resources:execute` like the SQL editor,
 * and goes through the same guard as a scheduled run: a query that could not be
 * *saved* as a monitor must not be runnable through the monitor's own preview.
 */
app.post("/test", async (c) => {
  requirePermission(c, "resources:execute");
  const parsed = await readObjectBody(c.req);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const fields = readMonitorBody(parsed.body);
  if (!fields.ok) return c.json({ error: fields.error }, 400);
  const { accountId, sql, mode = "scalar", resourceId, resourceTypeId } = fields.value;
  if (!accountId || !sql) return c.json({ error: "accountId and sql are required" }, 400);

  const result = await runMonitorQuery(c.get("organizationId"), {
    accountId,
    sql,
    mode,
    resourceId: resourceId ?? null,
    resourceTypeId: resourceTypeId ?? null,
  });

  // The threshold is applied to the preview too, so the editor can say "this
  // would be breaching right now" rather than leaving the reader to compare two
  // numbers themselves.
  const operator = fields.value.operator ?? "gt";
  const threshold = fields.value.threshold ?? 0;
  const outcome = foldMonitorRun({
    previousStreak: 0,
    operator,
    threshold,
    consecutiveBreaches: 1,
    value: result.value,
    error: result.error,
  });

  return c.json({
    value: result.value,
    state: outcome.state,
    error: outcome.error,
    durationMs: result.durationMs,
    rows: result.rows,
  });
});

/** POST /api/org/:orgId/query-monitors */
app.post("/", async (c) => {
  requirePermission(c, "resources:execute");
  const parsed = await readObjectBody(c.req);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const fields = readMonitorBody(parsed.body);
  if (!fields.ok) return c.json({ error: fields.error }, 400);

  const organizationId = c.get("organizationId");
  try {
    const monitor = await createQueryMonitor(
      organizationId,
      fields.value as QueryMonitorInput,
      c.get("session").userId ?? null,
    );
    void logAudit({
      organizationId,
      userId: c.get("session").userId,
      action: "query_monitor.create",
      entityType: "query_monitor",
      entityId: monitor.id,
      // The query text is recorded: a scheduled statement against a customer
      // database is exactly the thing an audit reader wants to see, and the
      // guard means it can only ever be a read.
      metadata: { name: monitor.name, accountId: monitor.accountId, sql: monitor.sql },
    });
    return c.json(monitor);
  } catch (err) {
    if (err instanceof QueryMonitorInputError) return c.json({ error: err.message }, err.status);
    throw err;
  }
});

/** GET /api/org/:orgId/query-monitors/:monitorId */
app.get("/:monitorId", async (c) => {
  requirePermission(c, "resources:read");
  const monitor = await getQueryMonitor(c.get("organizationId"), c.req.param("monitorId"));
  if (!monitor) return c.json({ error: "No such monitor" }, 404);
  return c.json(monitor);
});

/** PATCH /api/org/:orgId/query-monitors/:monitorId */
app.patch("/:monitorId", async (c) => {
  requirePermission(c, "resources:execute");
  const parsed = await readObjectBody(c.req);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const fields = readMonitorBody(parsed.body);
  if (!fields.ok) return c.json({ error: fields.error }, 400);
  if (Object.keys(fields.value).length === 0) {
    return c.json({ error: "No changes supplied" }, 400);
  }

  const organizationId = c.get("organizationId");
  try {
    const monitor = await updateQueryMonitor(
      organizationId,
      c.req.param("monitorId"),
      fields.value,
    );
    void logAudit({
      organizationId,
      userId: c.get("session").userId,
      action: "query_monitor.update",
      entityType: "query_monitor",
      entityId: monitor.id,
      metadata: { name: monitor.name, sql: monitor.sql, enabled: monitor.enabled },
    });
    return c.json(monitor);
  } catch (err) {
    if (err instanceof QueryMonitorInputError) return c.json({ error: err.message }, err.status);
    throw err;
  }
});

/** DELETE /api/org/:orgId/query-monitors/:monitorId */
app.delete("/:monitorId", async (c) => {
  requirePermission(c, "resources:execute");
  const organizationId = c.get("organizationId");
  const monitorId = c.req.param("monitorId");
  const removed = await deleteQueryMonitor(organizationId, monitorId);
  if (!removed) return c.json({ error: "No such monitor" }, 404);
  void logAudit({
    organizationId,
    userId: c.get("session").userId,
    action: "query_monitor.delete",
    entityType: "query_monitor",
    entityId: monitorId,
  });
  return c.body(null, 204);
});

export { app as queryMonitorRoutes };
