/**
 * HTTP API for resource reports (org-scoped, mounted at
 * /api/org/:orgId/resource-reports): saved inventory tables with cost.
 *
 * Reads are `resources:read` and writes `resources:write`, the probes and SLO
 * precedent: a report is a view over the inventory. Cost and virtual tag
 * columns additionally need `costs:read`; without it a run still answers, with
 * those cells empty and `cost.reason` saying why, and the caller's cost
 * visibility scope applies to every figure that does come back.
 *
 * The logic lives in services/resource-reports.ts; this file is transport.
 */
import { Hono, type Context } from "hono";
import {
  RESOURCE_REPORT_LIMITS,
  parseResourceReportColumn,
  resourceReportCsvFilename,
  type ResourceReportConfig,
  type ResourceReportSort,
} from "@infrawrench/client-core";
import {
  resourceReportConfigSchema,
  resourceReportInputSchema,
  resourceReportQueryRequestSchema,
} from "@infrawrench/ui/cost/config";
import { hasPermission } from "@infrawrench/server-core/permissions/catalog";
import { requirePermission } from "../../auth/permissions";
import { logAudit } from "../../services/audit";
import { CostReportFolderError } from "../../services/cost-report-folders";
import {
  ResourceReportError,
  VirtualTagUnresolvedError,
  createResourceReport,
  getResourceReport,
  getResourceReportOptions,
  getResourceReportTagValues,
  listResourceReportFolders,
  listResourceReports,
  resourceReportCsv,
  runResourceReport,
  softDeleteResourceReport,
  updateResourceReport,
} from "../../services/resource-reports";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

function canReadCosts(c: Context): boolean {
  return hasPermission(c.get("permissions") ?? [], "costs:read");
}

/** A run error the caller can fix, as a 400; anything else rethrows. */
function runError(c: Context, e: unknown) {
  if (e instanceof ResourceReportError || e instanceof VirtualTagUnresolvedError) {
    return c.json({ error: e.message }, 400);
  }
  throw e;
}

function csvResponse(c: Context, name: string, body: string) {
  return c.body(body, 200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${resourceReportCsvFilename(name)}"`,
  });
}

function intParam(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** GET /resource-reports: the reports the caller can open. */
app.get("/", async (c) => {
  requirePermission(c, "resources:read");
  return c.json(await listResourceReports(c.get("organizationId")));
});

/** GET /resource-reports/folders: the report folders (shared with cost reports) the caller can see. */
app.get("/folders", async (c) => {
  requirePermission(c, "resources:read");
  return c.json(await listResourceReportFolders(c.get("organizationId")));
});

/**
 * GET /resource-reports/options?types=plugin/type,...: what the pickers offer.
 * `types` narrows the metadata fields to what those resource types expose.
 */
app.get("/options", async (c) => {
  requirePermission(c, "resources:read");
  const types = (c.req.query("types") ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, RESOURCE_REPORT_LIMITS.maxFilterValues)
    .flatMap((t) => {
      const idx = t.indexOf("/");
      return idx > 0 ? [{ pluginId: t.slice(0, idx), resourceTypeId: t.slice(idx + 1) }] : [];
    });
  return c.json(
    await getResourceReportOptions(c.get("organizationId"), {
      types,
      includeCosts: canReadCosts(c),
    }),
  );
});

/** GET /resource-reports/tag-values?source=tag|virtual_tag&key=env: values for a tag condition. */
app.get("/tag-values", async (c) => {
  requirePermission(c, "resources:read");
  const source = c.req.query("source") === "virtual_tag" ? "virtual_tag" : "tag";
  const key = (c.req.query("key") ?? "").trim();
  if (!key || key.length > RESOURCE_REPORT_LIMITS.maxKeyLength) {
    return c.json({ error: "key is required" }, 400);
  }
  try {
    return c.json({
      values: await getResourceReportTagValues(
        c.get("organizationId"),
        source,
        key,
        canReadCosts(c),
      ),
    });
  } catch (e) {
    return runError(c, e);
  }
});

/** POST /resource-reports/query: run an unsaved config (the editor's live preview). */
app.post("/query", async (c) => {
  requirePermission(c, "resources:read");
  const parsed = resourceReportQueryRequestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "Invalid resource report query", issues: parsed.error.issues }, 400);
  }
  try {
    return c.json(
      await runResourceReport(c.get("organizationId"), parsed.data.config, {
        offset: parsed.data.offset,
        limit: parsed.data.limit,
        includeCosts: canReadCosts(c),
      }),
    );
  } catch (e) {
    return runError(c, e);
  }
});

/** POST /resource-reports/csv: an unsaved config's rows as CSV. */
app.post("/csv", async (c) => {
  requirePermission(c, "resources:read");
  const body = (await c.req.json().catch(() => null)) as {
    config?: unknown;
    name?: unknown;
  } | null;
  const config = resourceReportConfigSchema.safeParse(body?.config);
  if (!config.success) {
    return c.json({ error: "Invalid resource report config", issues: config.error.issues }, 400);
  }
  const name = typeof body?.name === "string" && body.name.trim() ? body.name : "resource-report";
  try {
    const csv = await resourceReportCsv(c.get("organizationId"), config.data, {
      includeCosts: canReadCosts(c),
    });
    return csvResponse(c, name, csv);
  } catch (e) {
    return runError(c, e);
  }
});

/** POST /resource-reports: create. */
app.post("/", async (c) => {
  requirePermission(c, "resources:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const parsed = resourceReportInputSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "Invalid resource report", issues: parsed.error.issues }, 400);
  }
  try {
    const created = await createResourceReport(organizationId, parsed.data, session.userId ?? null);
    void logAudit({
      organizationId,
      userId: session.userId,
      action: "resource_report.create",
      entityType: "resource_report",
      entityId: created.id,
      metadata: { name: created.name },
    });
    return c.json(created, 201);
  } catch (e) {
    if (e instanceof CostReportFolderError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

/** GET /resource-reports/:id */
app.get("/:id", async (c) => {
  requirePermission(c, "resources:read");
  const report = await getResourceReport(c.get("organizationId"), c.req.param("id"));
  if (!report) return c.json({ error: "Not found" }, 404);
  return c.json(report);
});

/** PUT /resource-reports/:id: replace name, description, config and folder. */
app.put("/:id", async (c) => {
  requirePermission(c, "resources:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const parsed = resourceReportInputSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "Invalid resource report", issues: parsed.error.issues }, 400);
  }
  try {
    const updated = await updateResourceReport(organizationId, c.req.param("id"), parsed.data);
    if (!updated) return c.json({ error: "Not found" }, 404);
    void logAudit({
      organizationId,
      userId: session.userId,
      action: "resource_report.update",
      entityType: "resource_report",
      entityId: updated.id,
      metadata: { name: updated.name },
    });
    return c.json(updated);
  } catch (e) {
    if (e instanceof CostReportFolderError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

/** DELETE /resource-reports/:id: soft delete. */
app.delete("/:id", async (c) => {
  requirePermission(c, "resources:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const reportId = c.req.param("id");
  const deleted = await softDeleteResourceReport(organizationId, reportId);
  if (!deleted) return c.json({ error: "Not found" }, 404);
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "resource_report.delete",
    entityType: "resource_report",
    entityId: reportId,
    metadata: {},
  });
  return c.json({ ok: true });
});

/** Parse the `sort`/`direction` query overrides; null when absent, an error string when bad. */
function sortOverride(c: Context): ResourceReportSort | null | string {
  const column = c.req.query("sort");
  if (!column) return null;
  if (!parseResourceReportColumn(column)) return `"${column}" is not a column to sort by.`;
  const direction = c.req.query("direction") === "desc" ? "desc" : "asc";
  return { column, direction };
}

/**
 * GET /resource-reports/:id/rows?offset=&limit=&sort=&direction=: run a saved
 * report. `sort`/`direction` override the saved sort for this request only.
 */
app.get("/:id/rows", async (c) => {
  requirePermission(c, "resources:read");
  const organizationId = c.get("organizationId");
  const report = await getResourceReport(organizationId, c.req.param("id"));
  if (!report) return c.json({ error: "Not found" }, 404);
  const sort = sortOverride(c);
  if (typeof sort === "string") return c.json({ error: sort }, 400);
  const config: ResourceReportConfig = report.config;
  try {
    return c.json(
      await runResourceReport(organizationId, config, {
        offset: intParam(c.req.query("offset"), 0, 0, Number.MAX_SAFE_INTEGER),
        limit: intParam(
          c.req.query("limit"),
          config.pageSize,
          1,
          RESOURCE_REPORT_LIMITS.maxPageSize,
        ),
        sort: sort ?? undefined,
        includeCosts: canReadCosts(c),
      }),
    );
  } catch (e) {
    return runError(c, e);
  }
});

/** GET /resource-reports/:id/csv: a saved report's rows as CSV. */
app.get("/:id/csv", async (c) => {
  requirePermission(c, "resources:read");
  const organizationId = c.get("organizationId");
  const report = await getResourceReport(organizationId, c.req.param("id"));
  if (!report) return c.json({ error: "Not found" }, 404);
  try {
    const csv = await resourceReportCsv(organizationId, report.config, {
      includeCosts: canReadCosts(c),
    });
    return csvResponse(c, report.name, csv);
  } catch (e) {
    return runError(c, e);
  }
});

export { app as resourceReportRoutes };
