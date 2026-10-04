import { Hono } from "hono";
import { z } from "zod";
import { CUSTOM_COST_LIMITS } from "@infrawrench/client-core";
import {
  appendCustomCostRows,
  completeCustomCostUpload,
  CostIngestError,
  createCustomCostSource,
  createCustomCostUpload,
  CustomCostError,
  CustomCostOverlapError,
  deleteCustomCostSource,
  deleteCustomCostUpload,
  getCustomCostSource,
  listCustomCostSources,
  listCustomCostUploads,
  updateCustomCostSource,
} from "@infrawrench/server-core/cost/custom-costs";
import { requirePermission } from "../../auth/permissions";
import { logAudit } from "../../services/audit";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

/**
 * Custom cost sources and their uploads: spend from files (CSV or FOCUS),
 * parsed on the client into daily rows. See `server-core/src/cost/custom-costs.ts`
 * for the model; this file is transport only.
 *
 * Reads ride `costs:read`. Every write rides `costs:write`, the permission
 * `POST /costs/rows` already uses: an upload is the same act as a push, and a
 * source is only a name for where pushed spend goes.
 */
const app = new Hono();

const sourceBody = z.object({
  name: z.string().min(1).max(CUSTOM_COST_LIMITS.maxNameLength),
  description: z.string().max(CUSTOM_COST_LIMITS.maxDescriptionLength).nullish(),
  defaultCurrency: z.string().nullish(),
});

const uploadBody = z.object({
  fileName: z.string().max(CUSTOM_COST_LIMITS.maxFileNameLength).nullish(),
  format: z.string(),
  mode: z.string().optional(),
  via: z.string().optional(),
  fromDate: z.string(),
  toDate: z.string(),
});

/** Envelope only; per-row validation is the shared ingest module's. */
const rowsBody = z.object({
  rows: z.array(z.record(z.unknown())).max(CUSTOM_COST_LIMITS.maxRowsPerChunk),
});

/** Map the service's caller-fixable errors onto 400s. */
function badRequest(e: unknown): string | null {
  if (e instanceof CustomCostError || e instanceof CostIngestError) return e.message;
  return null;
}

/** GET /api/org/:orgId/custom-cost-sources: every source, name-sorted. */
app.get("/", async (c) => {
  requirePermission(c, "costs:read");
  return c.json(await listCustomCostSources(c.get("organizationId")));
});

/** POST /api/org/:orgId/custom-cost-sources: create a source. */
app.post("/", async (c) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const parsed = sourceBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "Invalid custom cost source", issues: parsed.error.issues }, 400);
  }
  try {
    const source = await createCustomCostSource(organizationId, parsed.data, session.userId);
    void logAudit({
      organizationId,
      userId: session.userId,
      action: "custom_cost_source.create",
      entityType: "custom_cost_source",
      entityId: source.id,
      metadata: { name: source.name },
    });
    return c.json(source);
  } catch (e) {
    const message = badRequest(e);
    if (message) return c.json({ error: message }, 400);
    throw e;
  }
});

/** GET /api/org/:orgId/custom-cost-sources/:id */
app.get("/:id", async (c) => {
  requirePermission(c, "costs:read");
  const source = await getCustomCostSource(c.get("organizationId"), c.req.param("id"));
  if (!source) return c.json({ error: "Not found" }, 404);
  return c.json(source);
});

/** PUT /api/org/:orgId/custom-cost-sources/:id: rename, redescribe, change default currency. */
app.put("/:id", async (c) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const parsed = sourceBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "Invalid custom cost source", issues: parsed.error.issues }, 400);
  }
  try {
    const source = await updateCustomCostSource(organizationId, c.req.param("id"), parsed.data);
    if (!source) return c.json({ error: "Not found" }, 404);
    void logAudit({
      organizationId,
      userId: session.userId,
      action: "custom_cost_source.update",
      entityType: "custom_cost_source",
      entityId: source.id,
      metadata: { name: source.name },
    });
    return c.json(source);
  } catch (e) {
    const message = badRequest(e);
    if (message) return c.json({ error: message }, 400);
    throw e;
  }
});

/** DELETE /api/org/:orgId/custom-cost-sources/:id: delete a source and all of its spend. */
app.delete("/:id", async (c) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const id = c.req.param("id");
  const result = await deleteCustomCostSource(organizationId, id);
  if (!result.deleted) return c.json({ error: "Not found" }, 404);
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "custom_cost_source.delete",
    entityType: "custom_cost_source",
    entityId: id,
    metadata: { zeroedRows: result.zeroedRows },
  });
  return c.json({ ok: true, zeroedRows: result.zeroedRows });
});

/** GET /api/org/:orgId/custom-cost-sources/:id/uploads: upload history, newest first. */
app.get("/:id/uploads", async (c) => {
  requirePermission(c, "costs:read");
  const organizationId = c.get("organizationId");
  const id = c.req.param("id");
  if (!(await getCustomCostSource(organizationId, id))) {
    return c.json({ error: "Not found" }, 404);
  }
  return c.json(await listCustomCostUploads(organizationId, id));
});

/**
 * POST /api/org/:orgId/custom-cost-sources/:id/uploads: open an upload.
 * 409 with `overlapping` when the range overlaps earlier uploads and no `mode`
 * was given.
 */
app.post("/:id/uploads", async (c) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const parsed = uploadBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "Invalid upload", issues: parsed.error.issues }, 400);
  }
  try {
    const upload = await createCustomCostUpload(
      organizationId,
      c.req.param("id"),
      parsed.data,
      session.userId,
    );
    if (!upload) return c.json({ error: "Not found" }, 404);
    return c.json(upload);
  } catch (e) {
    if (e instanceof CustomCostOverlapError) {
      return c.json({ error: e.message, code: "overlap", overlapping: e.overlapping }, 409);
    }
    const message = badRequest(e);
    if (message) return c.json({ error: message }, 400);
    throw e;
  }
});

/** POST /api/org/:orgId/custom-cost-sources/:id/uploads/:uploadId/rows: append a chunk. */
app.post("/:id/uploads/:uploadId/rows", async (c) => {
  requirePermission(c, "costs:write");
  const parsed = rowsBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "Invalid body", issues: parsed.error.issues }, 400);
  }
  try {
    const result = await appendCustomCostRows(
      c.get("organizationId"),
      c.req.param("id"),
      c.req.param("uploadId"),
      parsed.data.rows as never,
    );
    if (!result) return c.json({ error: "Not found" }, 404);
    return c.json(result);
  } catch (e) {
    const message = badRequest(e);
    if (message) return c.json({ error: message }, 400);
    throw e;
  }
});

/** POST /api/org/:orgId/custom-cost-sources/:id/uploads/:uploadId/complete: finish (and apply replace). */
app.post("/:id/uploads/:uploadId/complete", async (c) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  try {
    const result = await completeCustomCostUpload(
      organizationId,
      c.req.param("id"),
      c.req.param("uploadId"),
    );
    if (!result) return c.json({ error: "Not found" }, 404);
    void logAudit({
      organizationId,
      userId: session.userId,
      action: "custom_cost_upload.complete",
      entityType: "custom_cost_source",
      entityId: c.req.param("id"),
      metadata: {
        uploadId: result.upload.id,
        fileName: result.upload.fileName,
        rows: result.upload.rowCount,
        mode: result.upload.mode,
        replacedRows: result.replacedRows,
      },
    });
    return c.json(result.upload);
  } catch (e) {
    const message = badRequest(e);
    if (message) return c.json({ error: message }, 400);
    throw e;
  }
});

/** DELETE /api/org/:orgId/custom-cost-sources/:id/uploads/:uploadId: delete an upload and its rows. */
app.delete("/:id/uploads/:uploadId", async (c) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const result = await deleteCustomCostUpload(
    organizationId,
    c.req.param("id"),
    c.req.param("uploadId"),
  );
  if (!result.deleted) return c.json({ error: "Not found" }, 404);
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "custom_cost_upload.delete",
    entityType: "custom_cost_source",
    entityId: c.req.param("id"),
    metadata: { uploadId: c.req.param("uploadId"), zeroedRows: result.zeroedRows },
  });
  return c.json({ ok: true, zeroedRows: result.zeroedRows });
});

export { app as customCostSourceRoutes };
