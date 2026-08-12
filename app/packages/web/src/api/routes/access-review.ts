/**
 * Cross-cloud access review routes (`/api/org/:orgId/access-review*`).
 *
 * These are the principals inside the *customer's* clouds — IAM users and
 * roles, service accounts, app registrations, role bindings, long-lived API
 * keys. Not Infrawrench's own team roles (`/team/*`) and not the credentials
 * Infrawrench holds for you (`/credential-hygiene`).
 *
 * The review is assembled in server-core (`access-review/feed.ts`) so the web
 * API, the CSV export, the weekly digest and the poller's alert pass share one
 * computation. Purely a read over already-synced state: no provider API calls.
 *
 * Permissions mirror posture exactly. Reading is `resources:read`; accepting a
 * finding is `resources:write`, because it is a statement about one resource
 * ("that break-glass role is meant to be admin") at the same trust level as
 * changing it — and members, who can read the screen, deliberately cannot
 * silence it. Both dismissal routes are audited.
 *
 * There is no settings route: the review has no switch of its own. Its
 * critical/high findings ride the posture alert window, so `/posture/settings`
 * is the one place the org decides whether security findings page anybody.
 */
import { Hono } from "hono";
import {
  accessReviewToCsv,
  normalizeStaleDays,
  ACCESS_REVIEW_STALE_DAYS_MAX,
  ACCESS_REVIEW_STALE_DAYS_MIN,
} from "@infrawrench/client-core";
import { listAccessReview } from "@infrawrench/server-core/access-review/feed";
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

const app = new Hono();

/**
 * Read `?staleDays=`. An absent value takes the shared default; a present but
 * unparseable one is an error rather than a silent fallback, because the
 * window is printed on the screen and a caller that asked for 30 and got 90
 * would be reading a report it did not request.
 */
function readStaleDays(raw: string | undefined): number | { error: string } {
  if (raw === undefined || raw === "") return normalizeStaleDays(undefined);
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return { error: "staleDays must be a number" };
  if (parsed < ACCESS_REVIEW_STALE_DAYS_MIN || parsed > ACCESS_REVIEW_STALE_DAYS_MAX) {
    return {
      error: `staleDays must be between ${ACCESS_REVIEW_STALE_DAYS_MIN} and ${ACCESS_REVIEW_STALE_DAYS_MAX}`,
    };
  }
  return normalizeStaleDays(parsed);
}

/**
 * GET /api/org/:orgId/access-review — every synced principal in the org, plus
 * the findings that have evidence against them.
 */
app.get("/", async (c) => {
  requirePermission(c, "resources:read");
  const staleDays = readStaleDays(c.req.query("staleDays"));
  if (typeof staleDays !== "number") return c.json({ error: staleDays.error }, 400);
  return c.json(await listAccessReview(c.get("organizationId"), { staleDays }));
});

/**
 * GET /api/org/:orgId/access-review/export?format=csv|json — the review as a
 * downloadable evidence file.
 *
 * Its own route rather than a query parameter on the list, because it answers
 * with a different content type and a `Content-Disposition`, and because an
 * auditor's link should be a URL you can paste into a ticket.
 *
 * Dismissed findings are included and labelled in both formats: the question
 * an evidence pack answers is "what did you find and what did you decide", and
 * an export that dropped the accepted risks would answer only half of it.
 */
app.get("/export", async (c) => {
  requirePermission(c, "resources:read");
  const staleDays = readStaleDays(c.req.query("staleDays"));
  if (typeof staleDays !== "number") return c.json({ error: staleDays.error }, 400);

  const format = c.req.query("format") ?? "csv";
  if (format !== "csv" && format !== "json") {
    return c.json({ error: 'format must be "csv" or "json"' }, 400);
  }

  const organizationId = c.get("organizationId");
  const review = await listAccessReview(organizationId, { staleDays });
  // The date is in the filename so a folder of these sorts and an auditor can
  // see which one is current without opening any of them.
  const stamp = review.generatedAt.slice(0, 10);
  const filename = `access-review-${stamp}.${format}`;

  // Exporting the review is a disclosure of who holds standing access across
  // every connected account — worth a row in the audit log even though the
  // same facts are on the screen.
  void logAudit({
    organizationId,
    userId: c.get("session").userId,
    action: "access_review.exported",
    entityType: "organization",
    entityId: organizationId,
    metadata: {
      format,
      staleDays,
      principals: review.principals.length,
      findings: review.totalCount,
      dismissed: review.dismissedCount,
    },
  });

  c.header("Content-Disposition", `attachment; filename="${filename}"`);
  if (format === "json") {
    c.header("Content-Type", "application/json; charset=utf-8");
    return c.body(JSON.stringify(review, null, 2));
  }
  c.header("Content-Type", "text/csv; charset=utf-8");
  return c.body(accessReviewToCsv(review));
});

/**
 * POST /api/org/:orgId/access-review/dismissals — accept a finding, so it
 * leaves the list and stops feeding the security alerts.
 *
 * Idempotent: re-dismissing rewrites the note and the author. The finding is
 * still evaluated on every scan — this suppresses it, it does not delete it —
 * and `GET /access-review` reports it back under `dismissed`.
 *
 * The store is `posture_dismissals`, shared with the posture screen. The
 * mechanism is identical down to the key `(organizationId, resourceId,
 * ruleId)`, the rule-id namespaces are disjoint (`access-review:` is reserved,
 * enforced by the plugin registry test), and a dismissal for one surface is
 * simply inert on the other.
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
    action: "access_review.finding.dismissed",
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
 * DELETE /api/org/:orgId/access-review/dismissals?resourceId=…&ruleId=… — undo
 * a dismissal.
 *
 * The key is in the query string, not the path: resource ids are
 * provider-native and routinely contain slashes, which path encoding does not
 * reliably survive.
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
    action: "access_review.finding.restored",
    entityType: "resource",
    entityId: resourceId,
    metadata: { ruleId },
  });
  return c.body(null, 204);
});

export { app as accessReviewRoutes };
