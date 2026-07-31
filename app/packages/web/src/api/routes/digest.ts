/**
 * Weekly digest settings routes (`/api/org/:orgId/digest/*`).
 *
 * The digest itself is composed and sent by the poller (see
 * `server-core/src/digest/weekly.ts`); these routes carry the org-level
 * settings — on/off, send day/hour/timezone, the AI-narrative opt-in — the
 * last-attempt bookkeeping for display, the email recipient list, and a
 * "send now" escape hatch so the settings UI can prove the pipeline works
 * without waiting for the schedule. Slack and Teams routing is part of their
 * own settings: a channel opts into the `weeklyDigest` trigger the same way it
 * opts into budget alerts. Email has no such trigger table because email is a
 * digest-only transport, so its recipients live here.
 */
import { Hono } from "hono";
import {
  getOrgDigestSettings,
  sendWeeklyDigestNow,
  updateOrgDigestSettings,
  type DigestSettingsPatch,
  type DigestSettingsRecord,
} from "@infrawrench/server-core/digest/weekly";
import {
  addDigestEmailRecipient,
  listDigestEmailRecipients,
  removeDigestEmailRecipient,
} from "@infrawrench/server-core/digest/recipients";
import { requirePermission } from "../../auth/permissions";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

function toWire(s: DigestSettingsRecord) {
  return {
    enabled: s.enabled,
    lastSentWeekStart: s.lastSentWeekStart,
    lastSentAt: s.lastSentAt ? s.lastSentAt.toISOString() : null,
    timezone: s.timezone,
    sendDay: s.sendDay,
    sendHour: s.sendHour,
    narrativeEnabled: s.narrativeEnabled,
    narrativeAvailable: s.narrativeAvailable,
    emailAvailable: s.emailAvailable,
    attemptCount: s.attemptCount,
    lastAttemptAt: s.lastAttemptAt ? s.lastAttemptAt.toISOString() : null,
    lastStatus: s.lastStatus,
    lastError: s.lastError,
    nextAttemptAt: s.nextAttemptAt ? s.nextAttemptAt.toISOString() : null,
  };
}

/** The org's digest settings; an org that never touched them reads as disabled. */
app.get("/", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  return c.json(toWire(await getOrgDigestSettings(organizationId)));
});

/**
 * Update the weekly digest settings. Every field is optional, so the toggle,
 * the schedule and the narrative opt-in can each be saved on their own.
 * Enabling schedules the first digest for the next send time rather than firing
 * immediately — POST /digest/send is the immediate path.
 */
app.put("/", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  const body = await c.req.json<Record<string, unknown>>();

  const patch: DigestSettingsPatch = {};
  if (body["enabled"] !== undefined) {
    if (typeof body["enabled"] !== "boolean") {
      return c.json({ error: "enabled must be a boolean" }, 400);
    }
    patch.enabled = body["enabled"];
  }
  if (body["narrativeEnabled"] !== undefined) {
    if (typeof body["narrativeEnabled"] !== "boolean") {
      return c.json({ error: "narrativeEnabled must be a boolean" }, 400);
    }
    patch.narrativeEnabled = body["narrativeEnabled"];
  }
  if (body["timezone"] !== undefined) {
    if (typeof body["timezone"] !== "string") {
      return c.json({ error: "timezone must be an IANA time zone name" }, 400);
    }
    patch.timezone = body["timezone"];
  }
  if (body["sendDay"] !== undefined) {
    if (typeof body["sendDay"] !== "number") {
      return c.json({ error: "sendDay must be 1 (Monday) through 7 (Sunday)" }, 400);
    }
    patch.sendDay = body["sendDay"];
  }
  if (body["sendHour"] !== undefined) {
    if (typeof body["sendHour"] !== "number") {
      return c.json({ error: "sendHour must be an integer from 0 to 23" }, 400);
    }
    patch.sendHour = body["sendHour"];
  }
  if (Object.keys(patch).length === 0) {
    return c.json({ error: "No settings supplied" }, 400);
  }

  try {
    return c.json(toWire(await updateOrgDigestSettings(organizationId, patch)));
  } catch (err) {
    // The timezone and range checks live in server-core so the poller and the
    // API cannot disagree about what a valid schedule is.
    const message = err instanceof Error ? err.message : "Failed to save digest settings";
    return c.json({ error: message }, 400);
  }
});

/**
 * Compose last week's digest and send it now to every opted-in channel and
 * every email recipient, regardless of the schedule or the enabled flag.
 * Errors surface to the UI — "nothing is routed to receive it" is the one the
 * user needs to see.
 */
app.post("/send", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  try {
    const result = await sendWeeklyDigestNow(organizationId);
    return c.json({
      ok: true,
      attempted: result.attempted,
      succeeded: result.succeeded,
      slack: result.slack,
      teams: result.teams,
      email: result.email,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to send the digest";
    return c.json({ error: message }, 400);
  }
});

// --- Email recipients ---

/** Every address the org routes its digest to. */
app.get("/recipients", async (c) => {
  requirePermission(c, "org:settings:write");
  return c.json({ recipients: await listDigestEmailRecipients(c.get("organizationId")) });
});

/** Add an address. Re-adding one already on the list is a no-op. */
app.post("/recipients", async (c) => {
  requirePermission(c, "org:settings:write");
  const body = await c.req.json<{ email?: unknown }>();
  if (typeof body.email !== "string") {
    return c.json({ error: "email is required" }, 400);
  }
  try {
    const recipient = await addDigestEmailRecipient(
      c.get("organizationId"),
      body.email,
      c.get("session")?.userId ?? null,
    );
    return c.json(recipient);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to add the recipient";
    return c.json({ error: message }, 400);
  }
});

/** Remove an address. */
app.delete("/recipients/:id", async (c) => {
  requirePermission(c, "org:settings:write");
  const removed = await removeDigestEmailRecipient(c.get("organizationId"), c.req.param("id"));
  if (!removed) return c.json({ error: "Recipient not found" }, 404);
  return c.json({ ok: true });
});

export { app as digestRoutes };
