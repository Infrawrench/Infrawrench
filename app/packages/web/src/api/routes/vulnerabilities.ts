/**
 * Vulnerability routes (`/api/org/:orgId/vulnerabilities*`).
 *
 * The feed is the stored scanner findings joined to the synced resources that
 * run them, assembled in server-core (`vulnerabilities/feed.ts`) so the API,
 * the alert pass and the scorecard/compliance helpers share one computation.
 * The read makes no provider API calls: the poller collects findings.
 *
 * Permissions follow posture exactly: reading is `resources:read`, the alert
 * settings are `org:settings:write`, and dismissing (accepting a CVE as a
 * known risk) is `resources:write`, audited, so members cannot silence what
 * they can read.
 */
import { Hono } from "hono";
import { listVulnerabilities } from "@infrawrench/server-core/vulnerabilities/feed";
import {
  dismissVulnerability,
  MAX_VULNERABILITY_DISMISSAL_REASON_LENGTH,
  restoreVulnerability,
} from "@infrawrench/server-core/vulnerabilities/dismissals";
import {
  getVulnerabilitySettings,
  toVulnerabilitySettingsWire,
  updateVulnerabilitySettings,
  type VulnerabilitySettingsPatch,
} from "@infrawrench/server-core/vulnerabilities/settings";
import { requirePermission } from "../../auth/permissions";
import { logAudit } from "../../services/audit";
import type { AuthSession } from "../auth-middleware";
import { readObjectBody } from "../object-body";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

/** GET /api/org/:orgId/vulnerabilities: every open finding, joined to what runs it. */
app.get("/", async (c) => {
  requirePermission(c, "resources:read");
  return c.json(await listVulnerabilities(c.get("organizationId")));
});

/** POST /dismissals: accept an advisory for one artifact (or `*`). Idempotent. */
app.post("/dismissals", async (c) => {
  requirePermission(c, "resources:write");
  const parsed = await readObjectBody(c.req);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const body = parsed.body;
  const advisoryId = body["advisoryId"];
  const artifactKey = body["artifactKey"];
  const reason = body["reason"];
  if (typeof advisoryId !== "string" || advisoryId.trim() === "") {
    return c.json({ error: "advisoryId is required" }, 400);
  }
  if (typeof artifactKey !== "string" || artifactKey.trim() === "") {
    return c.json({ error: "artifactKey is required" }, 400);
  }
  if (reason !== undefined && reason !== null && typeof reason !== "string") {
    return c.json({ error: "reason must be a string" }, 400);
  }
  if (typeof reason === "string" && reason.length > MAX_VULNERABILITY_DISMISSAL_REASON_LENGTH) {
    return c.json(
      {
        error: `reason must be at most ${MAX_VULNERABILITY_DISMISSAL_REASON_LENGTH} characters`,
      },
      400,
    );
  }

  const organizationId = c.get("organizationId");
  const userId = c.get("session").userId;
  const dismissal = await dismissVulnerability(organizationId, {
    advisoryId,
    artifactKey,
    reason: reason ?? null,
    userId: userId ?? null,
  });
  void logAudit({
    organizationId,
    userId,
    action: "vulnerability.dismissed",
    entityType: "vulnerability",
    entityId: dismissal.advisoryId,
    metadata: { artifactKey: dismissal.artifactKey, reason: dismissal.reason },
  });
  return c.json({
    advisoryId: dismissal.advisoryId,
    artifactKey: dismissal.artifactKey,
    dismissedAt: dismissal.dismissedAt,
    dismissedBy: dismissal.dismissedBy,
    reason: dismissal.reason,
  });
});

/**
 * DELETE /dismissals?advisoryId=…&artifactKey=…: undo a dismissal. The key is
 * in the query string because artifact keys carry slashes and colons.
 */
app.delete("/dismissals", async (c) => {
  requirePermission(c, "resources:write");
  const advisoryId = c.req.query("advisoryId");
  const artifactKey = c.req.query("artifactKey");
  if (!advisoryId) return c.json({ error: "advisoryId is required" }, 400);
  if (!artifactKey) return c.json({ error: "artifactKey is required" }, 400);

  const organizationId = c.get("organizationId");
  const removed = await restoreVulnerability(organizationId, advisoryId, artifactKey);
  if (!removed) return c.json({ error: "That vulnerability is not dismissed" }, 404);
  void logAudit({
    organizationId,
    userId: c.get("session").userId,
    action: "vulnerability.restored",
    entityType: "vulnerability",
    entityId: advisoryId.trim().toUpperCase(),
    metadata: { artifactKey },
  });
  return c.body(null, 204);
});

app.get("/settings", async (c) => {
  requirePermission(c, "org:settings:write");
  return c.json(
    toVulnerabilitySettingsWire(await getVulnerabilitySettings(c.get("organizationId"))),
  );
});

/** Update the alert settings. `lastNotifiedAt` is the poller's claim and not writable. */
app.put("/settings", async (c) => {
  requirePermission(c, "org:settings:write");
  const parsed = await readObjectBody(c.req);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const body = parsed.body;
  const patch: VulnerabilitySettingsPatch = {};
  for (const key of ["alertsEnabled", "runningOnly"] as const) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== "boolean") return c.json({ error: `${key} must be a boolean` }, 400);
    patch[key] = body[key];
  }
  if (body["minSeverity"] !== undefined) {
    if (body["minSeverity"] !== "critical" && body["minSeverity"] !== "high") {
      return c.json({ error: 'minSeverity must be "critical" or "high"' }, 400);
    }
    patch.minSeverity = body["minSeverity"];
  }
  if (Object.keys(patch).length === 0) return c.json({ error: "No settings supplied" }, 400);
  const organizationId = c.get("organizationId");
  const saved = await updateVulnerabilitySettings(organizationId, patch);
  void logAudit({
    organizationId,
    userId: c.get("session").userId,
    action: "vulnerability.settings.updated",
    entityType: "organization",
    entityId: organizationId,
    metadata: { ...patch },
  });
  return c.json(toVulnerabilitySettingsWire(saved));
});

export { app as vulnerabilityRoutes };
