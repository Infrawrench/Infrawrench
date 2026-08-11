/**
 * Quota radar routes (`/api/org/:orgId/quotas*`).
 *
 * The feed is assembled in server-core (`quotas/feed.ts`) so the web API, the
 * weekly digest and the poller's alert pass share one computation — and so the
 * page's severity buckets and the alert's are the same code, not two
 * implementations of "over threshold". Purely a read over already-collected
 * readings: no provider API calls happen here (the collection is the poller's
 * `quotas/collect.ts`, which is where the money is spent).
 *
 * The settings mirror the expiry settings next door (`/expiring/settings`),
 * including the permission: `org:settings:write` rather than `resources:read`,
 * because the threshold decides what the org's channels and phones hear about,
 * which is the same trust level as the Slack/Teams/digest settings.
 */
import { Hono } from "hono";
import { getQuotaFeed } from "@infrawrench/server-core/quotas/feed";
import {
  getQuotaSettings,
  updateQuotaSettings,
  type QuotaSettingsPatchInput,
  type QuotaSettingsRecord,
} from "@infrawrench/server-core/quotas/settings";
import { requirePermission } from "../../auth/permissions";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

/**
 * GET /api/org/:orgId/quotas — every provider limit the org has a reading for,
 * worst first, with the trend fitted over the last fortnight of snapshots.
 *
 * Also carries the per-account collection status and the list of plugins that
 * cannot report quotas at all. Both are load-bearing rather than decoration: a
 * response of `rows: []` alone is indistinguishable between "nothing is near a
 * limit" and "every collection is failing", and only one of those is good
 * news.
 */
app.get("/", async (c) => {
  requirePermission(c, "resources:read");
  return c.json(await getQuotaFeed(c.get("organizationId")));
});

function toWire(s: QuotaSettingsRecord) {
  return {
    enabled: s.enabled,
    threshold: s.threshold,
    lastNotifiedAt: s.lastNotifiedAt ? s.lastNotifiedAt.toISOString() : null,
  };
}

/** The org's quota alert settings; an org that never saved reads the defaults. */
app.get("/settings", async (c) => {
  requirePermission(c, "org:settings:write");
  return c.json(toWire(await getQuotaSettings(c.get("organizationId"))));
});

/**
 * Update the quota alert settings. Every field is optional so a single toggle
 * can be saved on its own. Bounds live in server-core so the API and the
 * poller cannot disagree about what a valid threshold is, and they *reject*
 * rather than clamp — a form that silently shows 0.5 after the user typed 0.4
 * reads as the setting not having saved. `lastNotifiedAt` is deliberately not
 * writable: it is the poller's cooldown claim.
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
  const patch: QuotaSettingsPatchInput = {};

  if (body["enabled"] !== undefined) {
    if (typeof body["enabled"] !== "boolean") {
      return c.json({ error: "enabled must be a boolean" }, 400);
    }
    patch.enabled = body["enabled"];
  }
  if (body["threshold"] !== undefined) {
    if (typeof body["threshold"] !== "number") {
      return c.json({ error: "threshold must be a number" }, 400);
    }
    patch.threshold = body["threshold"];
  }
  if (Object.keys(patch).length === 0) {
    return c.json({ error: "No settings supplied" }, 400);
  }

  try {
    // The session is absent on an API-key request, and `updated_by_user_id`
    // is a nullable FK precisely so that case records "changed, by nobody we
    // can name" rather than refusing the write.
    const userId = c.get("session")?.userId;
    return c.json(
      toWire(await updateQuotaSettings(c.get("organizationId"), patch, userId ?? undefined)),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to save quota alert settings";
    return c.json({ error: message }, 400);
  }
});

export { app as quotaRoutes };
