/**
 * Slack connect + channel-routing routes.
 *
 * Org-scoped (`/api/org/:orgId/slack/*`): report connection status, hand back
 * the "Add to Slack" URL (with a signed `state` binding the install to this
 * org), list the channels an install can see so the UI can offer a picker, and
 * manage which channels take which alerts.
 *
 * Public OAuth callback (`/api/slack/oauth/callback`): Slack redirects the
 * browser here after the user approves the install; we verify the signed state
 * and exchange the code for a bot token. No session needed — the signed state
 * authorizes the org binding, exactly as the GitHub App setup callback does.
 */
import { Hono } from "hono";
import { and, eq, isNull } from "drizzle-orm";
import crypto from "node:crypto";
import { db } from "../../db/client";
import { slackChannels, slackInstallations } from "../../db/schema";
import {
  exchangeSlackCode,
  isSlackConfigured,
  listSlackChannels,
  recordSlackInstall,
  sendSlackTest,
  signSlackState,
  slackAuthorizeUrl,
  verifySlackState,
} from "@infrawrench/server-core/slack";
import { requirePermission } from "../../auth/permissions";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

function appUrl(): string {
  return process.env["APP_URL"] ?? "http://localhost:3000";
}

/**
 * The redirect target registered in the Slack app config. Slack requires the
 * value sent to `oauth.v2.access` to match the one sent to `authorize`, so both
 * sides derive it here.
 */
function redirectUri(): string {
  return `${appUrl().replace(/\/$/, "")}/api/slack/oauth/callback`;
}

async function liveInstallations(organizationId: string) {
  return db
    .select()
    .from(slackInstallations)
    .where(
      and(
        eq(slackInstallations.organizationId, organizationId),
        isNull(slackInstallations.deletedAt),
      ),
    );
}

const app = new Hono();

/** Connection status: whether the server has a Slack app, plus the org's installs and channels. */
app.get("/status", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  const installs = await liveInstallations(organizationId);
  const channels = await db
    .select()
    .from(slackChannels)
    .where(eq(slackChannels.organizationId, organizationId))
    .orderBy(slackChannels.channelName);

  return c.json({
    configured: isSlackConfigured(),
    installations: installs.map((i) => ({
      id: i.id,
      teamId: i.teamId,
      teamName: i.teamName,
    })),
    // Hide channels whose install has been disconnected; the rows stay so a
    // re-install restores them.
    channels: channels.flatMap((ch) =>
      installs.some((i) => i.id === ch.installationId)
        ? [
            {
              id: ch.id,
              installationId: ch.installationId,
              channelId: ch.channelId,
              channelName: ch.channelName,
              isPrivate: ch.isPrivate,
            },
          ]
        : [],
    ),
  });
});

/** The "Add to Slack" URL, with a state that binds the install to this org. */
app.get("/install-url", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  if (!isSlackConfigured()) {
    return c.json({ error: "Slack is not configured on this server." }, 400);
  }
  const session = c.get("session");
  const state = signSlackState(organizationId, session?.userId);
  return c.json({ url: slackAuthorizeUrl(state, redirectUri()) });
});

/** Channels the install can see, for the picker. Live call — not cached. */
app.get("/installations/:installationId/available-channels", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  const installationId = c.req.param("installationId");
  try {
    const channels = await listSlackChannels(organizationId, installationId);
    return c.json({ channels });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to list Slack channels";
    return c.json({ error: message }, 400);
  }
});

/** Disconnect a workspace. Soft-delete so a re-install restores its channels. */
app.delete("/installations/:installationId", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  const installationId = c.req.param("installationId");
  const result = await db
    .update(slackInstallations)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(slackInstallations.id, installationId),
        eq(slackInstallations.organizationId, organizationId),
      ),
    )
    .returning({ id: slackInstallations.id });
  if (result.length === 0) return c.json({ error: "Slack workspace not found" }, 404);
  return c.json({ ok: true });
});

interface ChannelBody {
  installationId: string;
  channelId: string;
  channelName: string;
  isPrivate?: boolean;
}

/**
 * Connect a channel as a possible destination. Re-adding an existing channel
 * refreshes its cached name.
 *
 * Adding a channel no longer decides what it receives: that is an
 * `alert_rules` row (`PUT /alert-rules`). An org with no rules yet falls back
 * to the synthesized default — everything except drift, everywhere — so a
 * freshly added channel still starts receiving alerts without a second step.
 */
app.post("/channels", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  const body = await c.req.json<ChannelBody>();

  const channelId = body.channelId?.trim();
  const channelName = body.channelName?.trim().replace(/^#/, "");
  if (!body.installationId) return c.json({ error: "installationId is required" }, 400);
  if (!channelId) return c.json({ error: "channelId is required" }, 400);
  if (!channelName) return c.json({ error: "channelName is required" }, 400);

  // The install must belong to this org — otherwise a caller could attach a
  // channel to someone else's workspace by guessing an installation id.
  const installs = await liveInstallations(organizationId);
  if (!installs.some((i) => i.id === body.installationId)) {
    return c.json({ error: "Slack workspace not found" }, 404);
  }

  const now = new Date();
  const [row] = await db
    .insert(slackChannels)
    .values({
      id: crypto.randomUUID(),
      organizationId,
      installationId: body.installationId,
      channelId,
      channelName,
      isPrivate: body.isPrivate ?? false,
    })
    .onConflictDoUpdate({
      target: [slackChannels.installationId, slackChannels.channelId],
      set: {
        channelName,
        ...(body.isPrivate != null ? { isPrivate: body.isPrivate } : {}),
        updatedAt: now,
      },
    })
    .returning();
  return c.json(row);
});

/** Refresh a channel's cached name after a Slack-side rename. */
app.patch("/channels/:id", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  const id = c.req.param("id");
  const body = await c.req.json<{ channelName?: string }>();

  const channelName = body.channelName?.trim().replace(/^#/, "");
  if (!channelName) return c.json({ error: "channelName is required" }, 400);

  const result = await db
    .update(slackChannels)
    .set({ channelName, updatedAt: new Date() })
    .where(and(eq(slackChannels.id, id), eq(slackChannels.organizationId, organizationId)))
    .returning();
  if (result.length === 0) return c.json({ error: "Channel not found" }, 404);
  return c.json(result[0]);
});

app.delete("/channels/:id", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  const id = c.req.param("id");
  const result = await db
    .delete(slackChannels)
    .where(and(eq(slackChannels.id, id), eq(slackChannels.organizationId, organizationId)))
    .returning({ id: slackChannels.id });
  if (result.length === 0) return c.json({ error: "Channel not found" }, 404);
  return c.json({ ok: true });
});

/** Post a test message to every configured channel. */
app.post("/test", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  try {
    const summary = await sendSlackTest(organizationId);
    return c.json({ ok: true, ...summary });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to send Slack test message";
    return c.json({ error: message }, 400);
  }
});

export { app as slackRoutes };

/**
 * Public OAuth callback. Slack sends `code` and our signed `state` here after
 * the user approves the install (or `error=access_denied` if they cancel).
 */
export const slackOauthRoute = new Hono();

slackOauthRoute.get("/slack/oauth/callback", async (c) => {
  const state = c.req.query("state") ?? "";
  const verified = verifySlackState(state);
  const denied = c.req.query("error");
  const code = c.req.query("code");

  if (!verified) {
    // Without a valid state we don't know the org, so the root is the best we
    // can do. The root layout surfaces the `slack` param as a toast.
    return c.redirect(`${appUrl()}/?slack=error`);
  }

  const { organizationId, userId } = verified;
  const returnUrl = (result: string) =>
    `${appUrl()}/org/${organizationId}/settings/paging?slack=${result}`;

  if (denied || !code) {
    console.log(`[slack] install cancelled for org ${organizationId}: ${denied ?? "no code"}`);
    return c.redirect(returnUrl("cancelled"));
  }

  try {
    const install = await exchangeSlackCode(code, redirectUri());
    await recordSlackInstall(organizationId, userId, install);
    console.log(
      `[slack] connected workspace ${install.teamName ?? install.teamId} to org ${organizationId}`,
    );
    return c.redirect(returnUrl("connected"));
  } catch (err) {
    console.error("[slack] install failed:", err);
    return c.redirect(returnUrl("error"));
  }
});
