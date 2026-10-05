/**
 * HTTP API for cost canvases (org-scoped, /api/org/:orgId/cost-canvases).
 *
 * A canvas is a saved, structured report spec the chat agent writes from a
 * natural-language description. CRUD, `POST /draft` (start a canvas and its
 * conversation from a prompt), `POST /:id/run` (re-run every query; no model
 * call), `POST /preview` (run an unsaved spec, for previewing a proposed
 * edit), `GET /:id/pdf`, and delivery schedules under `/:id/notifications`.
 *
 * Reads are `costs:read`, writes `costs:write`, like reports. Starting a
 * conversation additionally needs `chat:write`. Schedule writes, targets and
 * "Send now" are `org:settings:write`, as for every other delivery schedule.
 * Per-object sharing (`cost_canvas`) narrows all of it; logic lives in
 * services/cost-canvases.ts so the MCP/chat tools share the code path.
 */
import { Hono, type Context } from "hono";
import { pdfFileName, type CostCanvasNotificationInput } from "@infrawrench/client-core";
import {
  costCanvasDraftInputSchema,
  costCanvasInputSchema,
  costCanvasSpecSchema,
  formatCostCanvasSpecIssues,
} from "@infrawrench/ui/cost/config";
import {
  ReportNotificationInputError,
  listReportDeliveryTargets,
} from "@infrawrench/server-core/report-delivery/store";
import {
  createCanvasNotification,
  deleteCanvasNotification,
  listCanvasNotifications,
  requireLiveCanvas,
  sendCanvasNotificationNow,
  updateCanvasNotification,
} from "@infrawrench/server-core/report-delivery/canvas";
import {
  CostCanvasInputError,
  createCostCanvas,
  draftCostCanvas,
  ensureCanvasConversation,
  getCostCanvas,
  listCostCanvases,
  runCostCanvas,
  runCostCanvasSpec,
  softDeleteCostCanvas,
  updateCostCanvas,
} from "../../services/cost-canvases";
import { renderCanvasForDelivery, renderCostCanvasPdf } from "../../services/cost-canvas-pdf";
import { attachmentDisposition } from "../../lib/content-disposition";
import { logAudit } from "../../services/audit";
import type { AuthSession } from "../auth-middleware";
import { requirePermission } from "../../auth/permissions";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

function granted(c: Context): readonly string[] {
  return (c.get("permissions") as string[] | undefined) ?? [];
}

function asError(e: unknown): { message: string; status: 400 | 404 } | null {
  if (e instanceof ReportNotificationInputError) return { message: e.message, status: e.status };
  if (e instanceof CostCanvasInputError) return { message: e.message, status: e.status };
  return null;
}

function requestTimezone(c: Context): string | undefined {
  const tz = c.req.query("tz");
  if (!tz) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return undefined;
  }
}

/** GET /cost-canvases */
app.get("/", async (c) => {
  requirePermission(c, "costs:read");
  return c.json(await listCostCanvases(c.get("organizationId"), c.get("session").userId ?? null));
});

/** POST /cost-canvases: create from a full spec (no model involved). */
app.post("/", async (c) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const parsed = costCanvasInputSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: `Invalid canvas: ${formatCostCanvasSpecIssues(parsed.error)}` }, 400);
  }
  const created = await createCostCanvas(organizationId, parsed.data, session.userId ?? null);
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "cost_canvas.create",
    entityType: "cost_canvas",
    entityId: created.id,
    metadata: { name: created.name },
  });
  return c.json(created);
});

/** POST /cost-canvases/draft: an empty canvas plus a conversation, from a prompt. */
app.post("/draft", async (c) => {
  requirePermission(c, "costs:write");
  requirePermission(c, "chat:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  if (!session.userId) return c.json({ error: "A user is required to start a canvas" }, 400);
  const parsed = costCanvasDraftInputSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "Invalid draft", issues: parsed.error.issues }, 400);
  }
  try {
    const created = await draftCostCanvas(organizationId, parsed.data, session.userId);
    void logAudit({
      organizationId,
      userId: session.userId,
      action: "cost_canvas.create",
      entityType: "cost_canvas",
      entityId: created.id,
      metadata: { name: created.name, draft: true },
    });
    return c.json(created);
  } catch (e) {
    const err = asError(e);
    if (err) return c.json({ error: err.message }, err.status);
    throw e;
  }
});

/** POST /cost-canvases/preview: run an unsaved spec. */
app.post("/preview", async (c) => {
  requirePermission(c, "costs:read");
  const body = (await c.req.json().catch(() => null)) as {
    spec?: unknown;
    name?: unknown;
    includeChartData?: unknown;
  } | null;
  const parsed = costCanvasSpecSchema.safeParse(body?.spec);
  if (!parsed.success) {
    return c.json({ error: `Invalid canvas: ${formatCostCanvasSpecIssues(parsed.error)}` }, 400);
  }
  return c.json(
    await runCostCanvasSpec(
      c.get("organizationId"),
      {
        id: null,
        name: typeof body?.name === "string" ? body.name : "Preview",
        spec: parsed.data,
      },
      { granted: granted(c), includeChartData: body?.includeChartData !== false },
    ),
  );
});

/** GET /cost-canvases/:id */
app.get("/:id", async (c) => {
  requirePermission(c, "costs:read");
  const canvas = await getCostCanvas(
    c.get("organizationId"),
    c.req.param("id"),
    c.get("session").userId ?? null,
  );
  if (!canvas) return c.json({ error: "Not found" }, 404);
  return c.json(canvas);
});

/** PUT /cost-canvases/:id: full replace (the manual editor, rename). */
app.put("/:id", async (c) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const parsed = costCanvasInputSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: `Invalid canvas: ${formatCostCanvasSpecIssues(parsed.error)}` }, 400);
  }
  const updated = await updateCostCanvas(
    organizationId,
    c.req.param("id"),
    parsed.data,
    session.userId ?? null,
  );
  if (!updated) return c.json({ error: "Not found" }, 404);
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "cost_canvas.update",
    entityType: "cost_canvas",
    entityId: updated.id,
    metadata: { name: updated.name },
  });
  return c.json(updated);
});

/** DELETE /cost-canvases/:id: soft delete, with its cards and schedules. */
app.delete("/:id", async (c) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const canvasId = c.req.param("id");
  if (!(await softDeleteCostCanvas(organizationId, canvasId))) {
    return c.json({ error: "Not found" }, 404);
  }
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "cost_canvas.delete",
    entityType: "cost_canvas",
    entityId: canvasId,
    metadata: {},
  });
  return c.json({ ok: true });
});

/** POST /cost-canvases/:id/run: re-run every block's query. */
app.post("/:id/run", async (c) => {
  requirePermission(c, "costs:read");
  const body = (await c.req.json().catch(() => ({}))) as { includeChartData?: unknown } | null;
  const result = await runCostCanvas(c.get("organizationId"), c.req.param("id"), {
    granted: granted(c),
    includeChartData: body?.includeChartData !== false,
  });
  if (!result) return c.json({ error: "Not found" }, 404);
  return c.json(result);
});

/** POST /cost-canvases/:id/conversation: the caller's conversation for editing. */
app.post("/:id/conversation", async (c) => {
  requirePermission(c, "costs:write");
  requirePermission(c, "chat:write");
  const session = c.get("session");
  if (!session.userId) return c.json({ error: "A user is required" }, 400);
  const body = (await c.req.json().catch(() => ({}))) as {
    model?: string;
    fresh?: boolean;
  } | null;
  try {
    const conversationId = await ensureCanvasConversation(
      c.get("organizationId"),
      c.req.param("id"),
      session.userId,
      { model: body?.model, fresh: body?.fresh === true },
    );
    return c.json({ conversationId });
  } catch (e) {
    const err = asError(e);
    if (err) return c.json({ error: err.message }, err.status);
    throw e;
  }
});

/** GET /cost-canvases/:id/pdf */
app.get("/:id/pdf", async (c) => {
  requirePermission(c, "costs:read");
  const rendered = await renderCostCanvasPdf(c.get("organizationId"), c.req.param("id"), {
    granted: granted(c),
    timezone: requestTimezone(c),
  });
  if (!rendered) return c.json({ error: "Not found" }, 404);
  return new Response(new Uint8Array(rendered.pdf), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": attachmentDisposition(pdfFileName(rendered.name, "canvas")),
      "Content-Length": String(rendered.pdf.byteLength),
      "Cache-Control": "private, no-store",
    },
  });
});

/* ------------------------------------------------------------------ *
 * Delivery schedules
 * ------------------------------------------------------------------ */

async function requireViewableCanvas(c: Context): Promise<Response | null> {
  const canvas = await getCostCanvas(c.get("organizationId"), c.req.param("id") ?? "", null);
  return canvas ? null : c.json({ error: "Not found" }, 404);
}

app.get("/:id/notifications", async (c) => {
  requirePermission(c, "costs:read");
  const missing = await requireViewableCanvas(c);
  if (missing) return missing;
  try {
    return c.json(await listCanvasNotifications(c.get("organizationId"), c.req.param("id")));
  } catch (e) {
    const err = asError(e);
    if (err) return c.json({ error: err.message }, err.status);
    throw e;
  }
});

app.get("/:id/notifications/targets", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  try {
    await requireLiveCanvas(organizationId, c.req.param("id"));
  } catch (e) {
    const err = asError(e);
    if (err) return c.json({ error: err.message }, err.status);
    throw e;
  }
  return c.json(await listReportDeliveryTargets(organizationId));
});

app.post("/:id/notifications", async (c) => {
  requirePermission(c, "org:settings:write");
  const missing = await requireViewableCanvas(c);
  if (missing) return missing;
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const canvasId = c.req.param("id");
  try {
    const input = (await c.req.json()) as CostCanvasNotificationInput;
    const created = await createCanvasNotification(
      organizationId,
      canvasId,
      input,
      session.userId ?? null,
    );
    void logAudit({
      organizationId,
      userId: session.userId,
      action: "cost_canvas_notification.create",
      entityType: "cost_canvas_notification",
      entityId: created.id,
      metadata: { canvasId, cadence: created.cadence },
    });
    return c.json(created);
  } catch (e) {
    const err = asError(e);
    if (err) return c.json({ error: err.message }, err.status);
    throw e;
  }
});

app.put("/:id/notifications/:notificationId", async (c) => {
  requirePermission(c, "org:settings:write");
  const missing = await requireViewableCanvas(c);
  if (missing) return missing;
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  try {
    const input = (await c.req.json()) as CostCanvasNotificationInput;
    const updated = await updateCanvasNotification(
      organizationId,
      c.req.param("id"),
      c.req.param("notificationId"),
      input,
    );
    void logAudit({
      organizationId,
      userId: session.userId,
      action: "cost_canvas_notification.update",
      entityType: "cost_canvas_notification",
      entityId: updated.id,
      metadata: { canvasId: c.req.param("id") },
    });
    return c.json(updated);
  } catch (e) {
    const err = asError(e);
    if (err) return c.json({ error: err.message }, err.status);
    throw e;
  }
});

app.delete("/:id/notifications/:notificationId", async (c) => {
  requirePermission(c, "org:settings:write");
  const missing = await requireViewableCanvas(c);
  if (missing) return missing;
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  try {
    await deleteCanvasNotification(
      organizationId,
      c.req.param("id"),
      c.req.param("notificationId"),
    );
    void logAudit({
      organizationId,
      userId: session.userId,
      action: "cost_canvas_notification.delete",
      entityType: "cost_canvas_notification",
      entityId: c.req.param("notificationId"),
      metadata: { canvasId: c.req.param("id") },
    });
    return c.json({ ok: true });
  } catch (e) {
    const err = asError(e);
    if (err) return c.json({ error: err.message }, err.status);
    throw e;
  }
});

app.post("/:id/notifications/:notificationId/send", async (c) => {
  requirePermission(c, "org:settings:write");
  const missing = await requireViewableCanvas(c);
  if (missing) return missing;
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  try {
    const result = await sendCanvasNotificationNow(
      organizationId,
      c.req.param("id"),
      c.req.param("notificationId"),
      renderCanvasForDelivery,
    );
    void logAudit({
      organizationId,
      userId: session.userId,
      action: "cost_canvas_notification.send",
      entityType: "cost_canvas_notification",
      entityId: c.req.param("notificationId"),
      metadata: { canvasId: c.req.param("id"), succeeded: result.succeeded },
    });
    return c.json(result);
  } catch (e) {
    const err = asError(e);
    if (err) return c.json({ error: err.message }, err.status);
    throw e;
  }
});

export { app as costCanvasRoutes };
