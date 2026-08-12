/**
 * The shared dismissal routes for recomputed security findings.
 *
 * Posture checks and the cross-cloud access review are two surfaces over one
 * decision store (`posture_dismissals` — the rule-id namespaces are disjoint,
 * so a dismissal for one surface is simply inert on the other), and their
 * `POST /dismissals` + `DELETE /dismissals` handlers were byte-for-byte
 * identical apart from the audit action names. This registrar is that one
 * implementation; each feature's route file mounts it with its own audit
 * prefix.
 *
 * The permission is `resources:write`, not `resources:read`: accepting a
 * finding is a statement about one resource ("this bucket is public on
 * purpose"), the same trust level as changing it, and members — who can read
 * the screen — deliberately cannot silence it. Both routes are audited;
 * silencing a security finding is exactly the kind of decision an audit
 * reader goes looking for later.
 */
import type { Hono } from "hono";
import {
  dismissPostureFinding,
  restorePostureFinding,
  MAX_DISMISSAL_REASON_LENGTH,
} from "@infrawrench/server-core/posture/dismissals";
import { requirePermission } from "../../auth/permissions";
import { logAudit } from "../../services/audit";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

/**
 * Register `POST /dismissals` and `DELETE /dismissals` on `app`.
 *
 * `auditPrefix` names the surface in the audit log — `posture` or
 * `access_review` — producing `<prefix>.finding.dismissed` and
 * `<prefix>.finding.restored`.
 */
export function registerFindingDismissalRoutes(app: Hono, auditPrefix: string): void {
  /**
   * POST /dismissals — accept a finding, so it leaves the list and stops
   * feeding the alerts.
   *
   * Idempotent: re-dismissing rewrites the note and the author. The finding
   * itself is still evaluated on every scan — this suppresses it, it does not
   * delete it — and the feed reports it back under `dismissed`.
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
    void logAudit({
      organizationId,
      userId,
      action: `${auditPrefix}.finding.dismissed`,
      entityType: "resource",
      entityId: dismissal.resourceId,
      metadata: { ruleId: dismissal.ruleId, reason: dismissal.reason },
    });
    // Projected, not returned verbatim: the record carries the row's `id` and
    // `organizationId`, which the documented body forbids and no client uses.
    return c.json({
      resourceId: dismissal.resourceId,
      ruleId: dismissal.ruleId,
      dismissedAt: dismissal.dismissedAt,
      dismissedBy: dismissal.dismissedBy,
      reason: dismissal.reason,
    });
  });

  /**
   * DELETE /dismissals?resourceId=…&ruleId=… — undo a dismissal.
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
      action: `${auditPrefix}.finding.restored`,
      entityType: "resource",
      entityId: resourceId,
      metadata: { ruleId },
    });
    return c.body(null, 204);
  });
}
