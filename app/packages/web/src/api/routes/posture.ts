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
 *
 * The dismissal routes take `resources:write` instead: accepting a finding is
 * a statement about one resource ("this bucket is public on purpose"), the
 * same trust level as changing it, and members — who can read the screen —
 * deliberately cannot silence it. Both are audited.
 */
import { Hono } from "hono";
import { listPosture } from "@infrawrench/server-core/posture/feed";
import {
  dismissPostureFinding,
  restorePostureFinding,
  MAX_DISMISSAL_REASON_LENGTH,
} from "@infrawrench/server-core/posture/dismissals";
import {
  getPostureSettings,
  updatePostureSettings,
  type PostureSettingsPatch,
  type PostureSettingsRecord,
} from "@infrawrench/server-core/posture/settings";
import { requirePermission } from "../../auth/permissions";
import { logAudit } from "../../services/audit";
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

/**
 * POST /api/org/:orgId/posture/dismissals — accept a finding, so it leaves
 * the list and stops feeding the alerts.
 *
 * Idempotent: re-dismissing rewrites the note and the author. The finding
 * itself is still evaluated on every scan — this suppresses it, it does not
 * delete it — and `GET /posture` reports it back under `dismissed`.
 */
app.post("/dismissals", async (c) => {
  requirePermission(c, "resources:write");
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

  const resourceId = body["resourceId"];
  const ruleId = body["ruleId"];
  if (typeof resourceId !== "string" || resourceId.trim() === "") {
    return c.json({ error: "resourceId is required" }, 400);
  }
  if (typeof ruleId !== "string" || ruleId.trim() === "") {
    return c.json({ error: "ruleId is required" }, 400);
  }
  const reason = body["reason"];
  if (reason !== undefined && reason !== null && typeof reason !== "string") {
    return c.json({ error: "reason must be a string" }, 400);
  }
  if (typeof reason === "string" && reason.length > MAX_DISMISSAL_REASON_LENGTH) {
    return c.json(
      { error: `reason must be at most ${MAX_DISMISSAL_REASON_LENGTH} characters` },
      400,
    );
  }

  const organizationId = c.get("organizationId");
  const userId = c.get("session").userId;
  const dismissal = await dismissPostureFinding(organizationId, {
    resourceId,
    ruleId,
    reason: reason ?? null,
    userId: userId ?? null,
  });
  // Silencing a security finding is exactly the kind of decision an audit
  // reader goes looking for later.
  void logAudit({
    organizationId,
    userId,
    action: "posture.finding.dismissed",
    entityType: "resource",
    entityId: dismissal.resourceId,
    metadata: { ruleId: dismissal.ruleId, reason: dismissal.reason },
  });
  // Projected, not returned verbatim: the record carries the row's `id` and
  // `organizationId`, which the documented `PostureDismissal` body forbids and
  // no client has any use for.
  return c.json({
    resourceId: dismissal.resourceId,
    ruleId: dismissal.ruleId,
    dismissedAt: dismissal.dismissedAt,
    dismissedBy: dismissal.dismissedBy,
    reason: dismissal.reason,
  });
});

/**
 * DELETE /api/org/:orgId/posture/dismissals?resourceId=…&ruleId=… — undo a
 * dismissal.
 *
 * The key is in the query string, not the path: resource ids are
 * provider-native and routinely contain slashes (GCP's
 * `projects/p/zones/z/instances/i`), which path encoding does not reliably
 * survive.
 */
app.delete("/dismissals", async (c) => {
  requirePermission(c, "resources:write");
  const resourceId = c.req.query("resourceId");
  const ruleId = c.req.query("ruleId");
  if (!resourceId) return c.json({ error: "resourceId is required" }, 400);
  if (!ruleId) return c.json({ error: "ruleId is required" }, 400);

  const organizationId = c.get("organizationId");
  const removed = await restorePostureFinding(organizationId, resourceId, ruleId);
  if (!removed) return c.json({ error: "That finding is not dismissed" }, 404);

  void logAudit({
    organizationId,
    userId: c.get("session").userId,
    action: "posture.finding.restored",
    entityType: "resource",
    entityId: resourceId,
    metadata: { ruleId },
  });
  return c.body(null, 204);
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
