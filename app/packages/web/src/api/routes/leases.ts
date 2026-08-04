import { Hono, type Context } from "hono";
import {
  LeaseInputError,
  cancelLeaseRecord,
  createLeaseRecord,
  deleteLeaseRecord,
  getLeaseWire,
  getLeaseWireByResource,
  listLeases,
  updateLeaseRecord,
  type LeaseCreateInput,
  type LeaseUpdateInput,
} from "@infrawrench/server-core/leases/store";
import { requirePermission } from "../../auth/permissions";
import { logAudit } from "../../services/audit";
import type { AuthSession } from "../auth-middleware";

/**
 * Resource leases (TTL) — an optional "expires at" on any resource. Active
 * leases ride the expiry radar (kind `"lease"`); auto-delete leases are
 * executed by the poller (`server-core/src/leases/pass.ts`, two mandatory
 * announcements, freeze-aware). These routes only manage the rows.
 *
 * Permissions: reads are `resources:read` (the list is a view over the org's
 * resource set, like schedules); mutations are `resources:write` — except
 * that setting `autoDelete: true` additionally requires `resources:delete`,
 * because that lease is a standing instruction to delete the resource.
 */

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

interface ParsedBody {
  body: Record<string, unknown>;
  error?: Response;
}

async function parseObjectBody(c: Context): Promise<ParsedBody> {
  try {
    const parsed = (await c.req.json()) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { body: {}, error: c.json({ error: "Request body must be an object" }, 400) };
    }
    return { body: parsed as Record<string, unknown> };
  } catch {
    return { body: {}, error: c.json({ error: "Invalid JSON body" }, 400) };
  }
}

function leaseErrorResponse(c: Context, err: unknown) {
  if (err instanceof LeaseInputError) {
    return c.json({ error: err.message }, err.status);
  }
  // Anything else is a server bug or infrastructure failure — log the detail
  // server-side and keep internals out of the response.
  console.error("[leases] unexpected error:", err);
  return c.json({ error: "Lease operation failed" }, 500);
}

app.get("/", async (c) => {
  requirePermission(c, "resources:read");
  return c.json(await listLeases(c.get("organizationId")));
});

/** GET /resource?resourceId=… — the (unique) lease on one resource, or null. */
app.get("/resource", async (c) => {
  requirePermission(c, "resources:read");
  const resourceId = c.req.query("resourceId");
  if (!resourceId) return c.json({ error: "Missing resourceId" }, 400);
  return c.json({ lease: await getLeaseWireByResource(c.get("organizationId"), resourceId) });
});

app.post("/", async (c) => {
  requirePermission(c, "resources:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const { body, error } = await parseObjectBody(c);
  if (error) return error;
  if (typeof body["resourceId"] !== "string" || typeof body["accountId"] !== "string") {
    return c.json({ error: "resourceId and accountId are required" }, 400);
  }
  if (typeof body["expiresAt"] !== "string") {
    return c.json({ error: "expiresAt is required (ISO 8601)" }, 400);
  }
  if (body["autoDelete"] !== undefined && typeof body["autoDelete"] !== "boolean") {
    return c.json({ error: "autoDelete must be a boolean" }, 400);
  }
  if (body["note"] !== undefined && typeof body["note"] !== "string") {
    return c.json({ error: "note must be a string" }, 400);
  }
  // An auto-delete lease is a standing deletion — it needs the same
  // permission the direct delete endpoint gates on.
  if (body["autoDelete"] === true) requirePermission(c, "resources:delete");

  const input: LeaseCreateInput = {
    resourceId: body["resourceId"],
    accountId: body["accountId"],
    expiresAt: body["expiresAt"],
    ...(body["autoDelete"] !== undefined ? { autoDelete: body["autoDelete"] as boolean } : {}),
    ...(body["note"] !== undefined ? { note: body["note"] as string } : {}),
  };
  try {
    const created = await createLeaseRecord(organizationId, input, session?.userId);
    void logAudit({
      organizationId,
      userId: session?.userId,
      action: "resource_lease.create",
      entityType: "resource_lease",
      entityId: created.id,
      metadata: {
        resourceId: created.resourceId,
        pluginId: created.pluginId,
        resourceTypeId: created.resourceTypeId,
        expiresAt: created.expiresAt.toISOString(),
        autoDelete: created.autoDelete,
      },
    });
    return c.json((await getLeaseWire(organizationId, created.id))!, 201);
  } catch (err) {
    return leaseErrorResponse(c, err);
  }
});

app.put("/:id", async (c) => {
  requirePermission(c, "resources:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const leaseId = c.req.param("id");
  const { body, error } = await parseObjectBody(c);
  if (error) return error;

  const patch: LeaseUpdateInput = {};
  if (body["expiresAt"] !== undefined) {
    if (typeof body["expiresAt"] !== "string") {
      return c.json({ error: "expiresAt must be a string (ISO 8601)" }, 400);
    }
    patch.expiresAt = body["expiresAt"];
  }
  if (body["autoDelete"] !== undefined) {
    if (typeof body["autoDelete"] !== "boolean") {
      return c.json({ error: "autoDelete must be a boolean" }, 400);
    }
    patch.autoDelete = body["autoDelete"];
  }
  if (body["note"] !== undefined) {
    if (body["note"] !== null && typeof body["note"] !== "string") {
      return c.json({ error: "note must be a string or null" }, 400);
    }
    patch.note = body["note"] as string | null;
  }
  if (Object.keys(patch).length === 0) return c.json({ error: "No changes supplied" }, 400);
  if (patch.autoDelete === true) requirePermission(c, "resources:delete");

  try {
    const updated = await updateLeaseRecord(organizationId, leaseId, patch);
    void logAudit({
      organizationId,
      userId: session?.userId,
      action: "resource_lease.update",
      entityType: "resource_lease",
      entityId: updated.id,
      metadata: { resourceId: updated.resourceId, patch: patch as Record<string, unknown> },
    });
    return c.json((await getLeaseWire(organizationId, updated.id))!);
  } catch (err) {
    return leaseErrorResponse(c, err);
  }
});

app.post("/:id/cancel", async (c) => {
  requirePermission(c, "resources:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const leaseId = c.req.param("id");
  try {
    const canceled = await cancelLeaseRecord(organizationId, leaseId);
    void logAudit({
      organizationId,
      userId: session?.userId,
      action: "resource_lease.cancel",
      entityType: "resource_lease",
      entityId: canceled.id,
      metadata: { resourceId: canceled.resourceId, pluginId: canceled.pluginId },
    });
    return c.json((await getLeaseWire(organizationId, canceled.id))!);
  } catch (err) {
    return leaseErrorResponse(c, err);
  }
});

app.delete("/:id", async (c) => {
  requirePermission(c, "resources:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const leaseId = c.req.param("id");
  try {
    const deleted = await deleteLeaseRecord(organizationId, leaseId);
    void logAudit({
      organizationId,
      userId: session?.userId,
      action: "resource_lease.delete",
      entityType: "resource_lease",
      entityId: deleted.id,
      metadata: { resourceId: deleted.resourceId, pluginId: deleted.pluginId },
    });
    return c.body(null, 204);
  } catch (err) {
    return leaseErrorResponse(c, err);
  }
});

export { app as leaseRoutes };
