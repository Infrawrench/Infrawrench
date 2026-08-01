/**
 * Expiry radar routes (`/api/org/:orgId/expiring*`).
 *
 * The feed is assembled in server-core (`expiry/feed.ts`) so the web API, the
 * MCP tool, the weekly digest and the poller's alert pass share one
 * computation. Purely a read over already-synced state: no provider API calls.
 *
 * The settings mirror the drift alert settings next door
 * (`/changes/alert-settings`), including the permission: `org:settings:write`
 * rather than `resources:read`, because the lead time decides what the org's
 * channels and phones hear about, which is the same trust level as the
 * Slack/Teams/digest settings.
 */
import { Hono } from "hono";
import { listExpiring } from "@infrawrench/server-core/expiry/feed";
import {
  getExpirySettings,
  updateExpirySettings,
  type ExpirySettingsPatch,
  type ExpirySettingsRecord,
} from "@infrawrench/server-core/expiry/settings";
import { requirePermission } from "../../auth/permissions";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

/**
 * GET /api/org/:orgId/expiring — every declared deadline on the org's synced
 * resources (TLS certs, domains, tokens, key-rotation budgets), soonest first,
 * bucketed by severity against the org's lead time.
 */
app.get("/", async (c) => {
  requirePermission(c, "resources:read");
  return c.json(await listExpiring(c.get("organizationId")));
});

function toWire(s: ExpirySettingsRecord) {
  return {
    enabled: s.enabled,
    leadDays: s.leadDays,
    lastNotifiedAt: s.lastNotifiedAt ? s.lastNotifiedAt.toISOString() : null,
  };
}

/** The org's expiry alert settings; an org that never saved reads the defaults. */
app.get("/settings", async (c) => {
  requirePermission(c, "org:settings:write");
  return c.json(toWire(await getExpirySettings(c.get("organizationId"))));
});

/**
 * Update the expiry alert settings. Every field is optional so a single toggle
 * can be saved on its own. Bounds live in server-core so the API and the
 * poller cannot disagree about what a valid lead time is. `lastNotifiedAt` is
 * deliberately not writable — it is the poller's cooldown claim.
 */
app.put("/settings", async (c) => {
  requirePermission(c, "org:settings:write");
  const body = await c.req.json<Record<string, unknown>>();
  const patch: ExpirySettingsPatch = {};

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
  if (Object.keys(patch).length === 0) {
    return c.json({ error: "No settings supplied" }, 400);
  }

  try {
    return c.json(toWire(await updateExpirySettings(c.get("organizationId"), patch)));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to save expiry alert settings";
    return c.json({ error: message }, 400);
  }
});

export { app as expiringRoutes };
