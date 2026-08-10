import { Hono, type Context } from "hono";
import {
  OwnershipInputError,
  deleteOwnership,
  getOwnershipByResource,
  listOwnerCandidates,
  listOwnership,
  upsertOwnership,
} from "@infrawrench/server-core/ownership/store";
import type { ResourceOwnershipPatch } from "@infrawrench/client-core";
import { requirePermission } from "../../auth/permissions";
import { logAudit } from "../../services/audit";
import type { AuthSession } from "../auth-middleware";

/**
 * Resource ownership — owner, purpose, and the authorizing ticket, on any
 * resource. Read by the orphan finder (which annotates every flagged row with
 * its owner) and by the alert notifier (which routes a resource-scoped alert
 * to the owning person).
 *
 * Permissions follow the leases stance: reads are `resources:read` (ownership
 * is a view over the org's resource set), writes are `resources:write`.
 * Deliberately *not* gated on an org-admin permission — the person who can
 * create a resource is the person who should be able to say it is theirs, and
 * requiring an admin to record ownership is how ownership data stops existing.
 *
 * There is one write endpoint, an upsert keyed by resource: the caller knows
 * which resource it is editing, not whether a row already exists.
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

function ownershipErrorResponse(c: Context, err: unknown) {
  if (err instanceof OwnershipInputError) {
    return c.json({ error: err.message }, err.status);
  }
  console.error("[ownership] unexpected error:", err);
  return c.json({ error: "Ownership operation failed" }, 500);
}

/**
 * A nullable string field on the patch: absent keeps, `null` clears, a string
 * sets. The three cases are distinguishable in JSON and all three are
 * meaningful, so the boundary must not collapse them.
 */
function readNullableString(
  body: Record<string, unknown>,
  key: string,
): { ok: true; value?: string | null } | { ok: false } {
  if (!(key in body)) return { ok: true };
  const raw = body[key];
  if (raw === null) return { ok: true, value: null };
  if (typeof raw === "string") return { ok: true, value: raw };
  return { ok: false };
}

app.get("/", async (c) => {
  requirePermission(c, "resources:read");
  return c.json(await listOwnership(c.get("organizationId")));
});

/**
 * GET /members — people an owner can be set to.
 *
 * On `resources:read` rather than `team:read`: recording who owns a resource
 * must not be a privilege reserved for whoever can also see roles and
 * membership dates. The projection is correspondingly minimal — id, name,
 * email, nothing else.
 */
app.get("/members", async (c) => {
  requirePermission(c, "resources:read");
  return c.json({ members: await listOwnerCandidates(c.get("organizationId")) });
});

/** GET /resource?resourceId=… — the (unique) ownership record, or null. */
app.get("/resource", async (c) => {
  requirePermission(c, "resources:read");
  const resourceId = c.req.query("resourceId");
  if (!resourceId) return c.json({ error: "Missing resourceId" }, 400);
  return c.json({
    ownership: await getOwnershipByResource(c.get("organizationId"), resourceId),
  });
});

/**
 * PUT / — upsert one resource's ownership.
 *
 * Answers 200 with `null` when the patch left the record empty, because
 * clearing every field deletes the row (see the store): the response is the
 * new truth, and inventing an all-null record to return would contradict what
 * the next GET says.
 */
app.put("/", async (c) => {
  requirePermission(c, "resources:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const { body, error } = await parseObjectBody(c);
  if (error) return error;

  if (typeof body["resourceId"] !== "string" || !body["resourceId"]) {
    return c.json({ error: "resourceId is required" }, 400);
  }
  const ownerUserId = readNullableString(body, "ownerUserId");
  const ownerLabel = readNullableString(body, "ownerLabel");
  const purpose = readNullableString(body, "purpose");
  const ticketUrl = readNullableString(body, "ticketUrl");
  if (!ownerUserId.ok || !ownerLabel.ok || !purpose.ok || !ticketUrl.ok) {
    return c.json({ error: "ownerUserId, ownerLabel, purpose and ticketUrl must be strings" }, 400);
  }

  const patch: ResourceOwnershipPatch = {
    resourceId: body["resourceId"],
    ...("value" in ownerUserId ? { ownerUserId: ownerUserId.value } : {}),
    ...("value" in ownerLabel ? { ownerLabel: ownerLabel.value } : {}),
    ...("value" in purpose ? { purpose: purpose.value } : {}),
    ...("value" in ticketUrl ? { ticketUrl: ticketUrl.value } : {}),
  };

  try {
    const saved = await upsertOwnership(organizationId, patch, session?.userId);
    void logAudit({
      organizationId,
      userId: session?.userId,
      action: saved ? "resource_ownership.set" : "resource_ownership.clear",
      entityType: "resource_ownership",
      entityId: patch.resourceId,
      metadata: {
        ownerUserId: saved?.ownerUserId ?? null,
        ownerLabel: saved?.ownerLabel ?? null,
        ticketUrl: saved?.ticketUrl ?? null,
      },
    });
    return c.json(saved);
  } catch (err) {
    return ownershipErrorResponse(c, err);
  }
});

/** DELETE /?resourceId=… — drop the record entirely. */
app.delete("/", async (c) => {
  requirePermission(c, "resources:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const resourceId = c.req.query("resourceId");
  if (!resourceId) return c.json({ error: "Missing resourceId" }, 400);
  try {
    const removed = await deleteOwnership(organizationId, resourceId);
    if (!removed) return c.json({ error: "No ownership recorded for this resource" }, 404);
    void logAudit({
      organizationId,
      userId: session?.userId,
      action: "resource_ownership.clear",
      entityType: "resource_ownership",
      entityId: resourceId,
    });
    return c.body(null, 204);
  } catch (err) {
    return ownershipErrorResponse(c, err);
  }
});

export { app as ownershipRoutes };
