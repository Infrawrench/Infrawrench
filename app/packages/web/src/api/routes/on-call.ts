/**
 * On-call rotation routes (`/api/org/:orgId/on-call*`).
 *
 * Reading takes `team:read` rather than a settings permission: knowing who is
 * on call is something every member needs and nobody should have to ask an
 * admin for. Writing takes `org:settings:write`, the alert-routing stance — a
 * rotation decides who gets woken up, which is an org-wide decision.
 *
 * The one exception is **covers**. Arranging cover takes `team:read` too,
 * because it happens at 17:55 on a Friday and the person who needs to hand over
 * is rarely an org admin. Every cover is audit-logged, which is the control that
 * makes the looser permission safe: the question a reviewer asks afterwards is
 * "who was actually on call", and the log answers it.
 */
import { Hono } from "hono";
import { upcomingOnCallShifts, type OnCallScheduleInput } from "@infrawrench/client-core";
import {
  OnCallInputError,
  createOnCallOverride,
  createOnCallSchedule,
  deleteOnCallOverride,
  deleteOnCallSchedule,
  getOnCallSchedule,
  listOnCallOverrides,
  listOnCallSchedules,
  resolveOnCallNow,
  updateOnCallSchedule,
} from "@infrawrench/server-core/on-call/store";

import { requirePermission } from "../../auth/permissions";
import { logAudit } from "../../services/audit";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

const MAX_PREVIEW_SHIFTS = 60;

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

function readScheduleBody(
  body: Record<string, unknown>,
): { ok: true; value: Partial<OnCallScheduleInput> } | { ok: false; error: string } {
  const out: Partial<OnCallScheduleInput> = {};
  for (const key of ["name", "timezone", "handoffTime", "startDate"] as const) {
    if (key in body) {
      const raw = body[key];
      if (typeof raw !== "string") return { ok: false, error: `${key} must be a string` };
      out[key] = raw;
    }
  }
  if ("rotationDays" in body) {
    const raw = body["rotationDays"];
    if (typeof raw !== "number" || !Number.isInteger(raw)) {
      return { ok: false, error: "rotationDays must be a whole number" };
    }
    out.rotationDays = raw;
  }
  if ("participantUserIds" in body) {
    const raw = body["participantUserIds"];
    if (!Array.isArray(raw) || raw.some((v) => typeof v !== "string")) {
      return { ok: false, error: "participantUserIds must be an array of strings" };
    }
    out.participantUserIds = raw as string[];
  }
  if ("enabled" in body) {
    const raw = body["enabled"];
    if (typeof raw !== "boolean") return { ok: false, error: "enabled must be a boolean" };
    out.enabled = raw;
  }
  return { ok: true, value: out };
}

/** GET /api/org/:orgId/on-call/schedules — the org's rotations. */
app.get("/schedules", async (c) => {
  requirePermission(c, "team:read");
  return c.json({ schedules: await listOnCallSchedules(c.get("organizationId")) });
});

/**
 * GET /api/org/:orgId/on-call/now — who is on call right now, per rotation.
 *
 * The read a phone, a Slack command or a dashboard tile wants: it answers the
 * question without the caller having to know the rotation arithmetic.
 */
app.get("/now", async (c) => {
  requirePermission(c, "team:read");
  const organizationId = c.get("organizationId");
  const schedules = await listOnCallSchedules(organizationId);
  const now = Date.now();
  const entries = await Promise.all(
    schedules.map(async (schedule) => {
      const resolved = await resolveOnCallNow(organizationId, schedule.id, now);
      return {
        scheduleId: schedule.id,
        scheduleName: schedule.name,
        enabled: schedule.enabled,
        shift: resolved.shift,
        next: resolved.next,
      };
    }),
  );
  return c.json({ onCall: entries, generatedAt: new Date(now).toISOString() });
});

/**
 * GET /api/org/:orgId/on-call/schedules/:scheduleId/shifts — the rotation's
 * upcoming shifts, plus the covers drawn over them.
 *
 * Rotation shifts and covers are returned **separately** rather than merged: a
 * preview that silently folded covers in would make it impossible to see what
 * the rotation itself does, which is the thing being edited.
 */
app.get("/schedules/:scheduleId/shifts", async (c) => {
  requirePermission(c, "team:read");
  const organizationId = c.get("organizationId");
  const scheduleId = c.req.param("scheduleId");
  const schedule = await getOnCallSchedule(organizationId, scheduleId);
  if (!schedule) return c.json({ error: "No such rotation" }, 404);

  const rawCount = c.req.query("count");
  const count = rawCount === undefined ? 8 : Number(rawCount);
  if (!Number.isInteger(count) || count < 1 || count > MAX_PREVIEW_SHIFTS) {
    return c.json(
      { error: `count must be a whole number between 1 and ${MAX_PREVIEW_SHIFTS}` },
      400,
    );
  }

  const now = Date.now();
  const shifts = upcomingOnCallShifts(schedule, now, count);
  const last = shifts[shifts.length - 1];
  const overrides = await listOnCallOverrides(organizationId, {
    scheduleId,
    from: new Date(now),
    ...(last ? { to: new Date(last.endsAt) } : {}),
  });
  return c.json({ shifts, overrides });
});

/** POST /api/org/:orgId/on-call/schedules */
app.post("/schedules", async (c) => {
  requirePermission(c, "org:settings:write");
  const parsed = await readObjectBody(c.req);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const fields = readScheduleBody(parsed.body);
  if (!fields.ok) return c.json({ error: fields.error }, 400);

  const organizationId = c.get("organizationId");
  try {
    const schedule = await createOnCallSchedule(
      organizationId,
      fields.value as OnCallScheduleInput,
      c.get("session").userId ?? null,
    );
    void logAudit({
      organizationId,
      userId: c.get("session").userId,
      action: "on_call_schedule.create",
      entityType: "on_call_schedule",
      entityId: schedule.id,
      metadata: { name: schedule.name, participants: schedule.participants.length },
    });
    return c.json(schedule);
  } catch (err) {
    if (err instanceof OnCallInputError) return c.json({ error: err.message }, err.status);
    throw err;
  }
});

/** PATCH /api/org/:orgId/on-call/schedules/:scheduleId */
app.patch("/schedules/:scheduleId", async (c) => {
  requirePermission(c, "org:settings:write");
  const parsed = await readObjectBody(c.req);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const fields = readScheduleBody(parsed.body);
  if (!fields.ok) return c.json({ error: fields.error }, 400);
  if (Object.keys(fields.value).length === 0) {
    return c.json({ error: "No changes supplied" }, 400);
  }

  const organizationId = c.get("organizationId");
  try {
    const schedule = await updateOnCallSchedule(
      organizationId,
      c.req.param("scheduleId"),
      fields.value,
    );
    void logAudit({
      organizationId,
      userId: c.get("session").userId,
      action: "on_call_schedule.update",
      entityType: "on_call_schedule",
      entityId: schedule.id,
      metadata: {
        name: schedule.name,
        participants: schedule.participants.length,
        enabled: schedule.enabled,
      },
    });
    return c.json(schedule);
  } catch (err) {
    if (err instanceof OnCallInputError) return c.json({ error: err.message }, err.status);
    throw err;
  }
});

/** DELETE /api/org/:orgId/on-call/schedules/:scheduleId */
app.delete("/schedules/:scheduleId", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  const scheduleId = c.req.param("scheduleId");
  const removed = await deleteOnCallSchedule(organizationId, scheduleId);
  if (!removed) return c.json({ error: "No such rotation" }, 404);
  void logAudit({
    organizationId,
    userId: c.get("session").userId,
    action: "on_call_schedule.delete",
    entityType: "on_call_schedule",
    entityId: scheduleId,
  });
  return c.body(null, 204);
});

/** GET /api/org/:orgId/on-call/overrides */
app.get("/overrides", async (c) => {
  requirePermission(c, "team:read");
  const scheduleId = c.req.query("scheduleId");
  return c.json({
    overrides: await listOnCallOverrides(c.get("organizationId"), {
      ...(scheduleId ? { scheduleId } : {}),
    }),
  });
});

/**
 * POST /api/org/:orgId/on-call/overrides — arrange cover.
 *
 * `team:read`, deliberately: cover is arranged at 17:55 on a Friday, and the
 * person handing over is rarely an org admin. The audit entry is what makes
 * that safe.
 */
app.post("/overrides", async (c) => {
  requirePermission(c, "team:read");
  const parsed = await readObjectBody(c.req);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const body = parsed.body;
  for (const key of ["scheduleId", "userId", "startsAt", "endsAt"] as const) {
    if (typeof body[key] !== "string") return c.json({ error: `${key} is required` }, 400);
  }
  const reason = body["reason"];
  if (reason !== undefined && reason !== null && typeof reason !== "string") {
    return c.json({ error: "reason must be a string or null" }, 400);
  }

  const organizationId = c.get("organizationId");
  try {
    const override = await createOnCallOverride(
      organizationId,
      {
        scheduleId: body["scheduleId"] as string,
        userId: body["userId"] as string,
        startsAt: body["startsAt"] as string,
        endsAt: body["endsAt"] as string,
        reason: (reason as string | null | undefined) ?? null,
      },
      c.get("session").userId ?? null,
    );
    void logAudit({
      organizationId,
      userId: c.get("session").userId,
      action: "on_call_override.create",
      entityType: "on_call_override",
      entityId: override.id,
      metadata: {
        scheduleId: override.scheduleId,
        coveringUserId: override.userId,
        startsAt: override.startsAt,
        endsAt: override.endsAt,
      },
    });
    return c.json(override);
  } catch (err) {
    if (err instanceof OnCallInputError) return c.json({ error: err.message }, err.status);
    throw err;
  }
});

/** DELETE /api/org/:orgId/on-call/overrides/:overrideId */
app.delete("/overrides/:overrideId", async (c) => {
  requirePermission(c, "team:read");
  const organizationId = c.get("organizationId");
  const overrideId = c.req.param("overrideId");
  const removed = await deleteOnCallOverride(organizationId, overrideId);
  if (!removed) return c.json({ error: "No such cover" }, 404);
  void logAudit({
    organizationId,
    userId: c.get("session").userId,
    action: "on_call_override.delete",
    entityType: "on_call_override",
    entityId: overrideId,
  });
  return c.body(null, 204);
});

export { app as onCallRoutes };
