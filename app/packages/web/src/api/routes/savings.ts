/**
 * Realized savings (org-scoped, mounted at /api/org/:orgId/savings).
 *
 * What the actions people took actually saved, measured against each
 * resource's own pre-action spend: the receipt beside the finders'
 * projections. The report is computed on every read (billing restates; see
 * `server-core/src/savings/realized.ts`); the routes below otherwise manage
 * the *events* the report measures.
 *
 * Reads are `costs:read`. Logging, editing and removing an entry, and the
 * org's tuning, are `costs:write`: the same permission that guards cost
 * annotations, which every entry leaves on the charts.
 */
import { Hono, type Context } from "hono";
import {
  realizedSavingsSettingsSchema,
  savingsEventAnnotationSchema,
  savingsEventInputSchema,
} from "@infrawrench/ui/cost/config";
import {
  annotateSavingsEvent,
  createManualSavingsEvent,
  deleteSavingsEvent,
  getSavingsEventRow,
  SavingsEventError,
  updateManualSavingsEvent,
} from "@infrawrench/server-core/savings/events";
import {
  getRealizedSavingsReport,
  RealizedSavingsRangeError,
} from "@infrawrench/server-core/savings/realized";
import {
  getOrgSavingsSettings,
  setOrgSavingsSettings,
} from "@infrawrench/server-core/savings/settings";

import { requirePermission } from "../../auth/permissions";
import { logAudit } from "../../services/audit";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

function errorResponse(c: Context, e: unknown) {
  if (e instanceof SavingsEventError) return c.json({ error: e.message }, e.status);
  throw e;
}

/** GET /realized?from=&to=: the report, with every event's realized figure. */
app.get("/realized", async (c) => {
  requirePermission(c, "costs:read");
  try {
    return c.json(
      await getRealizedSavingsReport(c.get("organizationId"), {
        from: c.req.query("from") || undefined,
        to: c.req.query("to") || undefined,
      }),
    );
  } catch (e) {
    if (e instanceof RealizedSavingsRangeError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

/** POST /events: log a saving by hand. */
app.post("/events", async (c) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const parsed = savingsEventInputSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid saving", issues: parsed.error.issues }, 400);
  }
  try {
    const created = await createManualSavingsEvent(
      organizationId,
      parsed.data,
      session?.userId ?? null,
    );
    void logAudit({
      organizationId,
      userId: session?.userId,
      action: "savings_event.create",
      entityType: "savings_event",
      entityId: created.id,
      metadata: { kind: created.kind, occurredOn: created.occurredOn },
    });
    return c.json(created);
  } catch (e) {
    return errorResponse(c, e);
  }
});

/** PUT /events/:id: rewrite a manual entry. */
app.put("/events/:id", async (c) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId");
  const parsed = savingsEventInputSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid saving", issues: parsed.error.issues }, 400);
  }
  try {
    const updated = await updateManualSavingsEvent(organizationId, c.req.param("id"), parsed.data);
    void logAudit({
      organizationId,
      userId: c.get("session")?.userId,
      action: "savings_event.update",
      entityType: "savings_event",
      entityId: updated.id,
      metadata: { kind: updated.kind },
    });
    return c.json(updated);
  } catch (e) {
    return errorResponse(c, e);
  }
});

/**
 * PATCH /events/:id: add context to any event (a note, an attribution, a
 * horizon, an end date). The facts of an automatic event stay as observed.
 */
app.patch("/events/:id", async (c) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId");
  const parsed = savingsEventAnnotationSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid change", issues: parsed.error.issues }, 400);
  }
  try {
    const updated = await annotateSavingsEvent(organizationId, c.req.param("id"), parsed.data);
    void logAudit({
      organizationId,
      userId: c.get("session")?.userId,
      action: "savings_event.update",
      entityType: "savings_event",
      entityId: updated.id,
      metadata: { kind: updated.kind, fields: Object.keys(parsed.data) },
    });
    return c.json(updated);
  } catch (e) {
    return errorResponse(c, e);
  }
});

/** DELETE /events/:id: withdraw an entry and the chart note it left. */
app.delete("/events/:id", async (c) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId");
  const id = c.req.param("id");
  if (!(await getSavingsEventRow(organizationId, id))) {
    return c.json({ error: "Saving not found" }, 404);
  }
  try {
    const removed = await deleteSavingsEvent(organizationId, id);
    void logAudit({
      organizationId,
      userId: c.get("session")?.userId,
      action: "savings_event.delete",
      entityType: "savings_event",
      entityId: id,
      metadata: { kind: removed.kind, title: removed.title },
    });
    return c.json({ ok: true });
  } catch (e) {
    return errorResponse(c, e);
  }
});

/** GET /settings: horizon, shortfall threshold and baseline window. */
app.get("/settings", async (c) => {
  requirePermission(c, "costs:read");
  return c.json(await getOrgSavingsSettings(c.get("organizationId")));
});

/** PUT /settings: retune how realized savings are measured, org-wide. */
app.put("/settings", async (c) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId");
  const parsed = realizedSavingsSettingsSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid savings settings", issues: parsed.error.issues }, 400);
  }
  const saved = await setOrgSavingsSettings(organizationId, parsed.data);
  void logAudit({
    organizationId,
    userId: c.get("session")?.userId,
    action: "savings_settings.update",
    entityType: "organization",
    entityId: organizationId,
    metadata: { ...saved },
  });
  return c.json(saved);
});

export default app;
