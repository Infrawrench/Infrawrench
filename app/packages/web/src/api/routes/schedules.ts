import { Hono, type Context } from "hono";
import {
  getScheduleWire,
  listSchedules,
  previewSchedule,
} from "@infrawrench/server-core/schedules/feed";
import {
  ScheduleInputError,
  createScheduleRecord,
  deleteScheduleRecord,
  updateScheduleRecord,
  type ScheduleCreateInput,
  type ScheduleUpdateInput,
} from "@infrawrench/server-core/schedules/store";
import { requirePermission } from "../../auth/permissions";
import { logAudit } from "../../services/audit";
import type { AuthSession } from "../auth-middleware";

/**
 * Sleep/wake schedules — "off at 19:00, on at 08:00, Mon–Fri" windows on
 * resources whose plugin declares a `lifecycle` start/stop action pair.
 * Execution happens in the poller (`server-core/src/schedules/pass.ts`);
 * these routes only manage the rows and quote projected savings.
 *
 * Permissions: reads are `resources:read` (the list is derived from the
 * org's resource set, like orphans); mutations are `resources:write` — a
 * schedule is a standing instruction to invoke the same actions that
 * permission already gates on `/resources/invoke-action`.
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

/** Wall-clock "HH:MM", 24-hour — the same shape the MCP tool schema enforces. */
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function readTiming(
  body: Record<string, unknown>,
  { partial }: { partial: boolean },
):
  | { error: string }
  | {
      timing: {
        daysOfWeek?: number[];
        stopTime?: string;
        startTime?: string;
        timezone?: string;
      };
    } {
  const timing: {
    daysOfWeek?: number[];
    stopTime?: string;
    startTime?: string;
    timezone?: string;
  } = {};
  if (body["daysOfWeek"] !== undefined || !partial) {
    if (
      !Array.isArray(body["daysOfWeek"]) ||
      body["daysOfWeek"].length < 1 ||
      body["daysOfWeek"].length > 7 ||
      !body["daysOfWeek"].every(
        (d) => typeof d === "number" && Number.isInteger(d) && d >= 1 && d <= 7,
      )
    ) {
      return { error: "daysOfWeek must be an array of ISO weekday numbers (1–7)" };
    }
    timing.daysOfWeek = body["daysOfWeek"] as number[];
  }
  for (const key of ["stopTime", "startTime", "timezone"] as const) {
    if (body[key] !== undefined || !partial) {
      if (typeof body[key] !== "string") return { error: `${key} must be a string` };
      if (key !== "timezone" && !TIME_RE.test(body[key])) {
        return { error: `${key} must be in 24-hour HH:MM format` };
      }
      timing[key] = body[key] as string;
    }
  }
  return { timing };
}

function scheduleErrorResponse(c: Context, err: unknown) {
  if (err instanceof ScheduleInputError) {
    return c.json({ error: err.message }, err.status);
  }
  // Anything else is a server bug or infrastructure failure — log the detail
  // server-side and keep internals out of the response.
  console.error("[schedules] unexpected error:", err);
  return c.json({ error: "Schedule operation failed" }, 500);
}

app.get("/", async (c) => {
  requirePermission(c, "resources:read");
  return c.json(await listSchedules(c.get("organizationId")));
});

app.post("/preview", async (c) => {
  requirePermission(c, "resources:read");
  const { body, error } = await parseObjectBody(c);
  if (error) return error;
  if (typeof body["resourceId"] !== "string" || typeof body["accountId"] !== "string") {
    return c.json({ error: "resourceId and accountId are required" }, 400);
  }
  const timing = readTiming(body, { partial: false });
  if ("error" in timing) return c.json({ error: timing.error }, 400);
  try {
    return c.json(
      await previewSchedule(c.get("organizationId"), {
        resourceId: body["resourceId"],
        accountId: body["accountId"],
        daysOfWeek: timing.timing.daysOfWeek!,
        stopTime: timing.timing.stopTime!,
        startTime: timing.timing.startTime!,
        timezone: timing.timing.timezone!,
      }),
    );
  } catch (err) {
    return scheduleErrorResponse(c, err);
  }
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
  const timing = readTiming(body, { partial: false });
  if ("error" in timing) return c.json({ error: timing.error }, 400);

  const input: ScheduleCreateInput = {
    resourceId: body["resourceId"],
    accountId: body["accountId"],
    daysOfWeek: timing.timing.daysOfWeek!,
    stopTime: timing.timing.stopTime!,
    startTime: timing.timing.startTime!,
    timezone: timing.timing.timezone!,
  };
  try {
    const created = await createScheduleRecord(organizationId, input, session?.userId);
    void logAudit({
      organizationId,
      userId: session?.userId,
      action: "resource_schedule.create",
      entityType: "resource_schedule",
      entityId: created.id,
      metadata: {
        resourceId: created.resourceId,
        pluginId: created.pluginId,
        resourceTypeId: created.resourceTypeId,
        daysOfWeek: created.daysOfWeek,
        stopTime: created.stopTime,
        startTime: created.startTime,
        timezone: created.timezone,
      },
    });
    return c.json((await getScheduleWire(organizationId, created.id))!, 201);
  } catch (err) {
    return scheduleErrorResponse(c, err);
  }
});

app.put("/:id", async (c) => {
  requirePermission(c, "resources:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const scheduleId = c.req.param("id");
  const { body, error } = await parseObjectBody(c);
  if (error) return error;

  const timing = readTiming(body, { partial: true });
  if ("error" in timing) return c.json({ error: timing.error }, 400);
  const patch: ScheduleUpdateInput = { ...timing.timing };
  if (body["paused"] !== undefined) {
    if (typeof body["paused"] !== "boolean")
      return c.json({ error: "paused must be a boolean" }, 400);
    patch.paused = body["paused"];
  }
  if (Object.keys(patch).length === 0) return c.json({ error: "No changes supplied" }, 400);

  try {
    const updated = await updateScheduleRecord(organizationId, scheduleId, patch);
    void logAudit({
      organizationId,
      userId: session?.userId,
      action: "resource_schedule.update",
      entityType: "resource_schedule",
      entityId: updated.id,
      metadata: { resourceId: updated.resourceId, patch: patch as Record<string, unknown> },
    });
    return c.json((await getScheduleWire(organizationId, updated.id))!);
  } catch (err) {
    return scheduleErrorResponse(c, err);
  }
});

app.delete("/:id", async (c) => {
  requirePermission(c, "resources:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const scheduleId = c.req.param("id");
  try {
    const deleted = await deleteScheduleRecord(organizationId, scheduleId);
    void logAudit({
      organizationId,
      userId: session?.userId,
      action: "resource_schedule.delete",
      entityType: "resource_schedule",
      entityId: deleted.id,
      metadata: { resourceId: deleted.resourceId, pluginId: deleted.pluginId },
    });
    return c.body(null, 204);
  } catch (err) {
    return scheduleErrorResponse(c, err);
  }
});

export { app as scheduleRoutes };
