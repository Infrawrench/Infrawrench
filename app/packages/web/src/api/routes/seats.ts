/**
 * SaaS seat routes (`/api/org/:orgId/seats*`).
 *
 * The list is server-core's computation over the stored inventory the
 * poller's seats pass collects (`seats/feed.ts`). Reads are `costs:read`:
 * the page is seat prices and savings, the realized-savings stance, and it
 * names people by email, which is not a resource listing. Removing a seat
 * changes a provider account, so it is `resources:write` behind the change
 * freeze and audited. The threshold is `costs:write`, the realized-savings
 * settings permission, since it decides what the org's savings figures say.
 */
import { Hono } from "hono";
import { listSeats } from "@infrawrench/server-core/seats/feed";
import { requestSeatRefresh } from "@infrawrench/server-core/seats/collect";
import { removeSeat, SeatRemovalError } from "@infrawrench/server-core/seats/remove";
import {
  getSeatSettings,
  SeatSettingsError,
  updateSeatSettings,
} from "@infrawrench/server-core/seats/settings";
import { requirePermission } from "../../auth/permissions";
import { logAudit } from "../../services/audit";
import { checkChangeFreeze } from "../../services/change-freezes";
import { readObjectBody } from "../object-body";

const app = new Hono();

/** GET /api/org/:orgId/seats: every paid seat, with inactive / duplicate / downgrade findings. */
app.get("/", async (c) => {
  requirePermission(c, "costs:read");
  return c.json(await listSeats(c.get("organizationId")));
});

/** POST /api/org/:orgId/seats/refresh: make every seat-capable account due for collection now. */
app.post("/refresh", async (c) => {
  requirePermission(c, "costs:read");
  return c.json({ queued: await requestSeatRefresh(c.get("organizationId")) });
});

app.get("/settings", async (c) => {
  requirePermission(c, "costs:read");
  return c.json(await getSeatSettings(c.get("organizationId")));
});

app.put("/settings", async (c) => {
  requirePermission(c, "costs:write");
  const parsed = await readObjectBody(c.req);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  if (parsed.body["inactiveDays"] === undefined) {
    return c.json({ error: "No settings supplied" }, 400);
  }
  try {
    const organizationId = c.get("organizationId");
    const next = await updateSeatSettings(organizationId, {
      inactiveDays: parsed.body["inactiveDays"] as number,
    });
    const session = c.get("session") as { userId?: string } | undefined;
    void logAudit({
      organizationId,
      userId: session?.userId,
      action: "seats.settings_updated",
      entityType: "organization",
      entityId: organizationId,
      metadata: { inactiveDays: next.inactiveDays },
    });
    return c.json(next);
  } catch (err) {
    if (err instanceof SeatSettingsError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

/**
 * POST /api/org/:orgId/seats/:seatId/remove: remove a seat flagged as
 * inactive or duplicated, through the plugin. Records the realized saving.
 */
app.post("/:seatId/remove", async (c) => {
  requirePermission(c, "resources:write");
  const organizationId = c.get("organizationId");
  const seatId = c.req.param("seatId");
  const frozen = await checkChangeFreeze(c, {
    action: "seat.remove",
    entityType: "seat",
    entityId: seatId,
  });
  if (frozen) return frozen;
  const session = c.get("session") as { userId?: string } | undefined;
  try {
    const outcome = await removeSeat(organizationId, seatId, session?.userId ?? null);
    void logAudit({
      organizationId,
      userId: session?.userId,
      action: "seat.removed",
      entityType: "seat",
      entityId: seatId,
      metadata: {
        accountId: outcome.seat.accountId,
        pluginId: outcome.seat.pluginId,
        product: outcome.seat.product,
        seatType: outcome.seat.seatType,
        memberId: outcome.seat.memberId,
        finding: outcome.finding.kind,
        effective: outcome.effective,
      },
    });
    return c.json({ effective: outcome.effective, message: outcome.message });
  } catch (err) {
    if (err instanceof SeatRemovalError) return c.json({ error: err.message }, err.status);
    throw err;
  }
});

export { app as seatRoutes };
