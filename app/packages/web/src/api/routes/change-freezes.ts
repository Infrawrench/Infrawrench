import { Hono } from "hono";
import { z } from "zod";
import { requirePermission } from "../../auth/permissions";
import { logAudit } from "../../services/audit";
import {
  createChangeFreeze,
  deleteChangeFreeze,
  endChangeFreeze,
  getActiveChangeFreeze,
  listChangeFreezes,
  updateChangeFreeze,
  type ChangeFreezeRow,
} from "../../services/change-freezes";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const freezeInputSchema = z
  .object({
    name: z.string().min(1).max(120),
    reason: z.string().max(2000).optional(),
    startsAt: z.string().datetime({ offset: true }).optional(),
    endsAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

function toWire(freeze: ChangeFreezeRow) {
  return {
    id: freeze.id,
    name: freeze.name,
    reason: freeze.reason,
    startsAt: freeze.startsAt.toISOString(),
    endsAt: freeze.endsAt ? freeze.endsAt.toISOString() : null,
    active: freeze.active,
    createdByUserId: freeze.createdByUserId,
    endedByUserId: freeze.endedByUserId,
    createdAt: freeze.createdAt.toISOString(),
    updatedAt: freeze.updatedAt.toISOString(),
  };
}

function parseInput(raw: unknown):
  | {
      ok: true;
      value: { name: string; reason?: string; startsAt?: Date; endsAt?: Date };
    }
  | { ok: false; error: string } {
  const parsed = freezeInputSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: "Invalid freeze window" };
  }
  const startsAt = parsed.data.startsAt ? new Date(parsed.data.startsAt) : undefined;
  const endsAt = parsed.data.endsAt ? new Date(parsed.data.endsAt) : undefined;
  if (endsAt && endsAt <= (startsAt ?? new Date())) {
    return { ok: false, error: "endsAt must be after startsAt" };
  }
  return {
    ok: true,
    value: {
      name: parsed.data.name,
      ...(parsed.data.reason !== undefined ? { reason: parsed.data.reason } : {}),
      ...(startsAt ? { startsAt } : {}),
      ...(endsAt ? { endsAt } : {}),
    },
  };
}

const app = new Hono();

/** GET /api/org/:orgId/change-freezes — list freeze windows, newest first. */
app.get("/", async (c) => {
  requirePermission(c, "freezes:read");
  const freezes = await listChangeFreezes(c.get("organizationId"));
  return c.json(freezes.map(toWire));
});

/**
 * GET /api/org/:orgId/change-freezes/status — the freeze currently in effect,
 * if any. What the app-wide banner and pre-flight warnings poll.
 */
app.get("/status", async (c) => {
  requirePermission(c, "freezes:read");
  const freeze = await getActiveChangeFreeze(c.get("organizationId"));
  return c.json({ freeze: freeze ? toWire(freeze) : null });
});

/** POST /api/org/:orgId/change-freezes — declare a freeze window. */
app.post("/", async (c) => {
  requirePermission(c, "freezes:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");

  const parsed = parseInput(await c.req.json());
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);

  const freeze = await createChangeFreeze(organizationId, parsed.value, session.userId ?? null);
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "change_freeze.create",
    entityType: "change_freeze",
    entityId: freeze.id,
    metadata: {
      name: freeze.name,
      startsAt: freeze.startsAt.toISOString(),
      endsAt: freeze.endsAt ? freeze.endsAt.toISOString() : null,
    },
  });
  return c.json(toWire(freeze));
});

/** PUT /api/org/:orgId/change-freezes/:id — update name/reason/window. */
app.put("/:id", async (c) => {
  requirePermission(c, "freezes:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");

  const parsed = parseInput(await c.req.json());
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);

  const freeze = await updateChangeFreeze(organizationId, c.req.param("id"), parsed.value);
  if (!freeze) return c.json({ error: "Not found" }, 404);
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "change_freeze.update",
    entityType: "change_freeze",
    entityId: freeze.id,
    metadata: {
      name: freeze.name,
      endsAt: freeze.endsAt ? freeze.endsAt.toISOString() : null,
    },
  });
  return c.json(toWire(freeze));
});

/** POST /api/org/:orgId/change-freezes/:id/end — end the freeze now. */
app.post("/:id/end", async (c) => {
  requirePermission(c, "freezes:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");

  const freeze = await endChangeFreeze(organizationId, c.req.param("id"), session.userId ?? null);
  if (!freeze) return c.json({ error: "Not found" }, 404);
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "change_freeze.end",
    entityType: "change_freeze",
    entityId: freeze.id,
    metadata: { name: freeze.name },
  });
  return c.json(toWire(freeze));
});

/** DELETE /api/org/:orgId/change-freezes/:id — remove a freeze window. */
app.delete("/:id", async (c) => {
  requirePermission(c, "freezes:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const id = c.req.param("id");

  const deleted = await deleteChangeFreeze(organizationId, id);
  if (!deleted) return c.json({ error: "Not found" }, 404);
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "change_freeze.delete",
    entityType: "change_freeze",
    entityId: id,
  });
  return c.json({ ok: true });
});

export { app as changeFreezeRoutes };
