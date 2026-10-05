/**
 * Extended-support routes (`/api/org/:orgId/extended-support*`).
 *
 * The list is server-core's computation over synced versions plus the billed
 * overlay (`services/extended-support.ts`). Settings follow the expiry
 * settings next door, permission included: `org:settings:write`, because the
 * switch and the lead time decide what the org's channels hear about.
 */
import { Hono } from "hono";
import {
  ExtendedSupportSettingsError,
  getExtendedSupportSettings,
  updateExtendedSupportSettings,
  type ExtendedSupportSettingsPatch,
  type ExtendedSupportSettingsRecord,
} from "@infrawrench/server-core/extended-support/settings";
import { requirePermission } from "../../auth/permissions";
import { listExtendedSupportWithBilling } from "../../services/extended-support";
import { readObjectBody } from "../object-body";

const app = new Hono();

/**
 * GET /api/org/:orgId/extended-support: resources on versions past (or within
 * the lead time of) the end of standard support, with the monthly surcharge an
 * upgrade removes. `?refresh=true` bypasses the short billing cache.
 */
app.get("/", async (c) => {
  requirePermission(c, "resources:read");
  const refresh = c.req.query("refresh") === "true";
  return c.json(await listExtendedSupportWithBilling(c.get("organizationId"), { refresh }));
});

function toWire(s: ExtendedSupportSettingsRecord) {
  return {
    enabled: s.enabled,
    leadDays: s.leadDays,
    lastNotifiedAt: s.lastNotifiedAt ? s.lastNotifiedAt.toISOString() : null,
  };
}

app.get("/settings", async (c) => {
  requirePermission(c, "org:settings:write");
  return c.json(toWire(await getExtendedSupportSettings(c.get("organizationId"))));
});

/** Every field optional, so one toggle can be saved alone. `lastNotifiedAt` is the poller's. */
app.put("/settings", async (c) => {
  requirePermission(c, "org:settings:write");
  const parsed = await readObjectBody(c.req);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const body = parsed.body;
  const patch: ExtendedSupportSettingsPatch = {};
  if (body["enabled"] !== undefined) {
    if (typeof body["enabled"] !== "boolean") {
      return c.json({ error: "enabled must be a boolean" }, 400);
    }
    patch.enabled = body["enabled"];
  }
  if (body["leadDays"] !== undefined) {
    if (typeof body["leadDays"] !== "number") {
      return c.json({ error: "leadDays must be a number" }, 400);
    }
    patch.leadDays = body["leadDays"];
  }
  if (Object.keys(patch).length === 0) return c.json({ error: "No settings supplied" }, 400);
  try {
    return c.json(toWire(await updateExtendedSupportSettings(c.get("organizationId"), patch)));
  } catch (err) {
    if (err instanceof ExtendedSupportSettingsError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

export { app as extendedSupportRoutes };
