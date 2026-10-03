/**
 * Slack connect + channel-routing routes.
 *
 * Org-scoped (`/api/org/:orgId/slack/*`): report connection status, hand back
 * the "Add to Slack" URL (with a signed `state` binding the install to this
 * org), list the channels an install can see so the UI can offer a picker, and
 * manage which channels take which alerts.
 *
 * Browser half (`/api/slack/oauth/*`), outside the org tree:
 *  - `start`: the URL `install-url` hands back. Requires the web session of
 *    the user who asked for it (bouncing through sign-in when the browser has
 *    none, as it won't when desktop or mobile opens the system browser), drops
 *    the state's nonce into an HttpOnly cookie, and redirects to Slack.
 *  - `callback`: Slack redirects here after approval; it needs both a valid,
 *    unexpired signed state and that browser's matching nonce cookie before it
 *    exchanges the code for a bot token.
 * A signed state alone is not enough, or an admin of one org could send an
 * install link to another company's Slack admin and collect their workspace's
 * bot token under their own org.
 */
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { and, eq, isNull } from "drizzle-orm";
import crypto from "node:crypto";
import { db } from "../../db/client";
import { slackChannels, slackInstallations } from "../../db/schema";
import {
  exchangeSlackCode,
  isSlackConfigured,
  listSlackChannels,
  newSlackStateNonce,
  recordSlackInstall,
  sendSlackTest,
  signSlackState,
  SLACK_STATE_TTL_MS,
  slackAuthorizeUrl,
  slackStateNonceMatches,
  verifySlackState,
} from "@infrawrench/server-core/slack";
import { requirePermission } from "../../auth/permissions";
import { sessionMiddleware, type AuthSession } from "../auth-middleware";
import { safeReturnPath } from "../oauth-state";

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

/**
 * Holds the install nonce in the browser that started the install. Scoped to
 * the two OAuth hops so it rides nothing else; Lax so it survives Slack's
 * top-level redirect back to the callback.
 */
const SLACK_OAUTH_COOKIE = "iw_slack_oauth";
const SLACK_OAUTH_COOKIE_PATH = "/api/slack/oauth";

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

/**
 * The "Add to Slack" URL. It points at our own `start` hop rather than straight
 * at Slack: this request may come from the desktop main process or the mobile
 * app, neither of which is the browser that will finish the install, so the
 * nonce cookie is set when that browser arrives (see `start` below).
 */
app.get("/install-url", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  if (!isSlackConfigured()) {
    return c.json({ error: "Slack is not configured on this server." }, 400);
  }
  const userId = c.get("session")?.userId;
  if (!userId) {
    return c.json({ error: "A Slack install must be started by a signed-in user." }, 400);
  }
  const state = signSlackState(organizationId, userId, newSlackStateNonce());
  const start = `${appUrl().replace(/\/$/, "")}/api/slack/oauth/start`;
  return c.json({ url: `${start}?state=${encodeURIComponent(state)}` });
});

/** Channels the install can see, for the picker. Live call, not cached. */
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
 * to the synthesized default (everything except drift, everywhere) so a
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

  // The install must belong to this org, otherwise a caller could attach a
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

  // `c.req.json<T>()` is a cast, not a check: a numeric `channelName` would
  // throw inside `.trim()` and surface as a 500 for a plainly bad request.
  if (typeof body.channelName !== "string") {
    return c.json({ error: "channelName must be a string" }, 400);
  }
  const channelName = body.channelName.trim().replace(/^#/, "");
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

export const slackOauthRoute = new Hono();

/**
 * First browser hop of an install. Only the user the state was minted for may
 * pass: anyone else holding the link (because it was forwarded to them) gets
 * the error toast, and never the nonce cookie the callback insists on.
 */
slackOauthRoute.get("/slack/oauth/start", async (c) => {
  const state = c.req.query("state") ?? "";
  const verified = verifySlackState(state);
  if (!verified) return c.redirect(`${appUrl()}/?slack=error`);

  // Signed out (typical when desktop or mobile opened the system browser):
  // sign in, then land back here with the same state.
  if (!getCookie(c, "wos-session")) {
    const returnTo = safeReturnPath(`/api/slack/oauth/start?state=${encodeURIComponent(state)}`);
    return c.redirect(`/api/auth/sign-in?return_to=${encodeURIComponent(returnTo ?? "/")}`);
  }
  const denied = await sessionMiddleware(c, async () => {});
  if (denied instanceof Response) return denied;
  if (c.get("session")?.userId !== verified.userId) {
    console.warn(
      `[slack] install link for org ${verified.organizationId} opened by a different user; refused`,
    );
    return c.redirect(`${appUrl()}/?slack=error`);
  }

  setCookie(c, SLACK_OAUTH_COOKIE, verified.nonce, {
    path: SLACK_OAUTH_COOKIE_PATH,
    httpOnly: true,
    sameSite: "Lax",
    secure: appUrl().startsWith("https://"),
    maxAge: SLACK_STATE_TTL_MS / 1000,
  });
  return c.redirect(slackAuthorizeUrl(state, redirectUri()));
});

/**
 * OAuth callback. Slack sends `code` and our signed `state` here after the user
 * approves the install (or `error=access_denied` if they cancel). The nonce
 * cookie is consumed whatever the outcome, so a state completes at most once
 * per browser.
 */
slackOauthRoute.get("/slack/oauth/callback", async (c) => {
  const state = c.req.query("state") ?? "";
  const verified = verifySlackState(state);
  const denied = c.req.query("error");
  const code = c.req.query("code");
  const nonce = getCookie(c, SLACK_OAUTH_COOKIE);
  deleteCookie(c, SLACK_OAUTH_COOKIE, { path: SLACK_OAUTH_COOKIE_PATH });

  if (!verified || !slackStateNonceMatches(verified, nonce)) {
    // Expired, forged, or finished in a browser that did not start it. Without
    // a trustworthy state the root is the best we can do; the root layout
    // surfaces the `slack` param as a toast.
    if (verified) {
      console.warn(
        `[slack] install callback for org ${verified.organizationId} without the starting browser's nonce; refused`,
      );
    }
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
