/**
 * Posture check routes (`/api/org/:orgId/posture*`).
 *
 * The findings are assembled in server-core (`posture/feed.ts`) so the web
 * API, the MCP tool, the weekly digest and the poller's alert pass share one
 * computation. Purely a read over already-synced state: no provider API
 * calls.
 *
 * The settings mirror the expiry alert settings next door (`/expiring/settings`),
 * including the permission: `org:settings:write` rather than `resources:read`,
 * because the toggle decides what the org's channels and phones hear about,
 * which is the same trust level as the Slack/Teams/digest settings.
 */
import { Hono } from "hono";
import { listPosture } from "@infrawrench/server-core/posture/feed";
import {
  getPostureSettings,
  updatePostureSettings,
  type PostureSettingsPatch,
  type PostureSettingsRecord,
} from "@infrawrench/server-core/posture/settings";
import { requirePermission } from "../../auth/permissions";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

/**
 * GET /api/org/:orgId/posture — every matched plugin-declared security check
 * on the org's synced resources (public buckets, world-open ingress,
 * unencrypted disks, stale credentials), worst severity first.
 */
app.get("/", async (c) => {
  requirePermission(c, "resources:read");
  return c.json(await listPosture(c.get("organizationId")));
});

function toWire(s: PostureSettingsRecord) {
  return {
    enabled: s.enabled,
    lastNotifiedAt: s.lastNotifiedAt ? s.lastNotifiedAt.toISOString() : null,
  };
}

/** The org's posture alert settings; an org that never saved reads the defaults. */
app.get("/settings", async (c) => {
  requirePermission(c, "org:settings:write");
  return c.json(toWire(await getPostureSettings(c.get("organizationId"))));
});

/**
 * Update the posture alert settings. `lastNotifiedAt` is deliberately not
 * writable — it is the poller's cooldown claim.
 */
app.put("/settings", async (c) => {
  requirePermission(c, "org:settings:write");
  let body: Record<string, unknown>;
  try {
    const parsed = await c.req.json();
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return c.json({ error: "Request body must be an object" }, 400);
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const patch: PostureSettingsPatch = {};

  if (body["enabled"] !== undefined) {
    if (typeof body["enabled"] !== "boolean") {
      return c.json({ error: "enabled must be a boolean" }, 400);
    }
    patch.enabled = body["enabled"];
  }
  if (Object.keys(patch).length === 0) {
    return c.json({ error: "No settings supplied" }, 400);
  }

  try {
    return c.json(toWire(await updatePostureSettings(c.get("organizationId"), patch)));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to save posture alert settings";
    return c.json({ error: message }, 400);
  }
});

export { app as postureRoutes };
