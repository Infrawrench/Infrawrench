/**
 * Microsoft Teams channel-routing routes (`/api/org/:orgId/msteams/*`).
 *
 * Mounted at `msteams` rather than `teams` because `/api/org/:orgId/team`
 * already means the org's members.
 *
 * There is no OAuth callback here, unlike Slack: Teams has no app-only install
 * flow we can use, so an org pastes the webhook URL of a Teams "Workflows"
 * automation and we post to it. See `server-core/src/msteams.ts` for the full
 * reasoning. The URL is a bearer credential and is never returned by any of
 * these routes — the client only ever sees the `urlHint`.
 */
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import {
  addMsTeamsWebhook,
  listMsTeamsWebhooks,
  sendMsTeamsTest,
} from "@infrawrench/server-core/msteams";
import { db } from "../../db/client";
import { msteamsWebhooks } from "../../db/schema";
import { requirePermission } from "../../auth/permissions";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

/** The org's routed Teams channels. */
app.get("/status", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  return c.json({ webhooks: await listMsTeamsWebhooks(organizationId) });
});

interface WebhookBody {
  label: string;
  url: string;
  syncIncidents?: boolean;
  budgetAlerts?: boolean;
  anomalyAlerts?: boolean;
  workflowPages?: boolean;
  weeklyDigest?: boolean;
}

/**
 * Add a channel by its webhook URL, or update the one already holding that URL.
 * A rejected URL (wrong host, not https) comes back as a 400 whose message is
 * written for the user — the settings form renders it verbatim.
 */
app.post("/webhooks", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const body = await c.req.json<WebhookBody>();

  if (!body.label?.trim()) return c.json({ error: "label is required" }, 400);
  if (!body.url?.trim()) return c.json({ error: "url is required" }, 400);

  try {
    const webhook = await addMsTeamsWebhook(organizationId, session?.userId ?? null, {
      label: body.label,
      url: body.url,
      ...(body.syncIncidents != null ? { syncIncidents: body.syncIncidents } : {}),
      ...(body.budgetAlerts != null ? { budgetAlerts: body.budgetAlerts } : {}),
      ...(body.anomalyAlerts != null ? { anomalyAlerts: body.anomalyAlerts } : {}),
      ...(body.workflowPages != null ? { workflowPages: body.workflowPages } : {}),
      ...(body.weeklyDigest != null ? { weeklyDigest: body.weeklyDigest } : {}),
    });
    return c.json(webhook);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to save Teams webhook";
    return c.json({ error: message }, 400);
  }
});

interface WebhookPatchBody {
  label?: string;
  syncIncidents?: boolean;
  budgetAlerts?: boolean;
  anomalyAlerts?: boolean;
  workflowPages?: boolean;
  weeklyDigest?: boolean;
}

/** Rename a channel or change which alerts it receives. The URL is immutable. */
app.patch("/webhooks/:id", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  const id = c.req.param("id");
  const body = await c.req.json<WebhookPatchBody>();

  const patch: Partial<typeof msteamsWebhooks.$inferInsert> = { updatedAt: new Date() };
  if (body.label != null) {
    const label = body.label.trim();
    if (!label) return c.json({ error: "label cannot be empty" }, 400);
    patch.label = label;
  }
  if (body.syncIncidents != null) patch.syncIncidents = body.syncIncidents;
  if (body.budgetAlerts != null) patch.budgetAlerts = body.budgetAlerts;
  if (body.anomalyAlerts != null) patch.anomalyAlerts = body.anomalyAlerts;
  if (body.workflowPages != null) patch.workflowPages = body.workflowPages;
  if (body.weeklyDigest != null) patch.weeklyDigest = body.weeklyDigest;

  const result = await db
    .update(msteamsWebhooks)
    .set(patch)
    .where(and(eq(msteamsWebhooks.id, id), eq(msteamsWebhooks.organizationId, organizationId)))
    .returning();
  const row = result[0];
  if (!row) return c.json({ error: "Teams channel not found" }, 404);
  return c.json({
    id: row.id,
    label: row.label,
    urlHint: row.urlHint,
    syncIncidents: row.syncIncidents,
    budgetAlerts: row.budgetAlerts,
    anomalyAlerts: row.anomalyAlerts,
    workflowPages: row.workflowPages,
    weeklyDigest: row.weeklyDigest,
  });
});

app.delete("/webhooks/:id", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  const id = c.req.param("id");
  const result = await db
    .delete(msteamsWebhooks)
    .where(and(eq(msteamsWebhooks.id, id), eq(msteamsWebhooks.organizationId, organizationId)))
    .returning({ id: msteamsWebhooks.id });
  if (result.length === 0) return c.json({ error: "Teams channel not found" }, 404);
  return c.json({ ok: true });
});

/** Post a test card to every configured channel. */
app.post("/test", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  try {
    const summary = await sendMsTeamsTest(organizationId);
    return c.json({ ok: true, ...summary });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to send Teams test message";
    return c.json({ error: message }, 400);
  }
});

export { app as msteamsRoutes };
