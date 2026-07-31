/**
 * Weekly digest settings routes (`/api/org/:orgId/digest/*`).
 *
 * The digest itself is composed and sent by the poller (see
 * `server-core/src/digest/weekly.ts`); these routes only carry the org-level
 * on/off switch, the last-sent bookkeeping for display, and a "send now"
 * escape hatch so the settings UI can prove the pipeline works without
 * waiting for Monday. Per-channel routing is part of the Slack and Teams
 * settings — a channel opts into the `weeklyDigest` trigger the same way it
 * opts into budget alerts.
 */
import { Hono } from "hono";
import {
  getOrgDigestSettings,
  sendWeeklyDigestNow,
  setOrgDigestEnabled,
} from "@infrawrench/server-core/digest/weekly";
import { requirePermission } from "../../auth/permissions";

const app = new Hono();

function toWire(s: {
  enabled: boolean;
  lastSentWeekStart: string | null;
  lastSentAt: Date | null;
}) {
  return {
    enabled: s.enabled,
    lastSentWeekStart: s.lastSentWeekStart,
    lastSentAt: s.lastSentAt ? s.lastSentAt.toISOString() : null,
  };
}

/** The org's digest settings; an org that never touched them reads as disabled. */
app.get("/", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  return c.json(toWire(await getOrgDigestSettings(organizationId)));
});

/**
 * Enable or disable the weekly digest. Enabling schedules the first send for
 * next Monday morning rather than firing immediately — POST /digest/send is
 * the immediate path.
 */
app.put("/", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  const body = await c.req.json<{ enabled?: boolean }>();
  if (typeof body.enabled !== "boolean") {
    return c.json({ error: "enabled must be a boolean" }, 400);
  }
  return c.json(toWire(await setOrgDigestEnabled(organizationId, body.enabled)));
});

/**
 * Compose last week's digest and send it now to every opted-in channel,
 * regardless of the schedule or the enabled flag. Errors surface to the UI —
 * "no channels opted in" is the one the user needs to see.
 */
app.post("/send", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  try {
    const result = await sendWeeklyDigestNow(organizationId);
    return c.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to send the digest";
    return c.json({ error: message }, 400);
  }
});

export { app as digestRoutes };
