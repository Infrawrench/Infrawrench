/**
 * GitHub App connect + repo-listing routes for git-triggered workflows.
 *
 * Org-scoped (`/api/org/:orgId/github/*`): report connection status, hand back
 * the install URL (with a signed `state` binding the install to this org and
 * the requesting user), and list the repos the org's installation(s) can access.
 *
 * Setup callback (`/api/github/setup`): GitHub redirects the browser here after
 * the user installs/configures the app. Nothing GitHub puts in that URL is
 * trusted on its own: the `installation_id` is a guessable integer, so the
 * callback requires the signed-in session of the user who asked for the
 * install URL, then sends them through the GitHub App user-authorization flow
 * and records the installation only if `GET /user/installations` shows that
 * GitHub user can access it.
 */
import { Hono, type Context } from "hono";
import { getCookie } from "hono/cookie";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../db/client";
import { githubInstallations } from "../../db/schema";
import {
  exchangeGithubUserCode,
  githubAppOAuthConfig,
  githubAppSlug,
  githubUserAuthorizeUrl,
  isGithubAppConfigured,
  listInstallationRepos,
  getInstallation,
  signInstallState,
  userCanAccessInstallation,
  verifyInstallState,
} from "@infrawrench/server-core/github/app";
import { resolveEffectivePermissions } from "@infrawrench/server-core/permissions";
import { hasPermission } from "@infrawrench/server-core/permissions/catalog";
import { requirePermission } from "../../auth/permissions";
import { linkGithubInstallation } from "../../services/github-installations";
import { sessionMiddleware, type AuthSession } from "../auth-middleware";
import { safeReturnPath } from "../oauth-state";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

function appUrl(): string {
  return (process.env["APP_URL"] ?? "http://localhost:3000").replace(/\/$/, "");
}

/**
 * The setup callback, which doubles as the OAuth redirect target. Must be
 * registered as both the GitHub App's Setup URL and one of its Callback URLs.
 */
function setupCallbackUrl(): string {
  return `${appUrl()}/api/github/setup`;
}

/** The permission connecting a GitHub installation takes, checked at both ends. */
const CONNECT_PERMISSION = "dashboards:write";

async function orgInstallations(organizationId: string) {
  return db
    .select()
    .from(githubInstallations)
    .where(
      and(
        eq(githubInstallations.organizationId, organizationId),
        isNull(githubInstallations.deletedAt),
      ),
    );
}

const app = new Hono();

/** GET status: whether the app is configured, and the org's connections. */
app.get("/status", async (c) => {
  requirePermission(c, "dashboards:read");
  const organizationId = c.get("organizationId");
  const installs = await orgInstallations(organizationId);
  return c.json({
    configured: isGithubAppConfigured(),
    appSlug: githubAppSlug(),
    installations: installs.map((i) => ({
      installationId: i.installationId,
      accountLogin: i.accountLogin,
    })),
  });
});

/** Pages the setup callback may send the user back to (path under /org/:orgId). */
const INSTALL_RETURN_PAGES = new Set(["agents", "workflows"]);

/** GET install-url: the GitHub "install this app" URL with a signed state. */
app.get("/install-url", async (c) => {
  requirePermission(c, CONNECT_PERMISSION);
  const organizationId = c.get("organizationId");
  const slug = githubAppSlug();
  if (!isGithubAppConfigured() || !slug) {
    return c.json({ error: "GitHub App is not configured on this server." }, 400);
  }
  if (!githubAppOAuthConfig()) {
    // Without the client credentials the callback cannot prove who installed
    // the app, and refuses every install; say so before the round-trip.
    return c.json(
      {
        error:
          "GitHub App user authorization is not configured on this server (GITHUB_APP_CLIENT_ID / GITHUB_APP_CLIENT_SECRET).",
      },
      400,
    );
  }
  const returnToRaw = c.req.query("return") ?? "";
  const returnTo = INSTALL_RETURN_PAGES.has(returnToRaw) ? returnToRaw : "agents";
  const state = signInstallState({ organizationId, userId: c.get("session").userId, returnTo });
  const url = `https://github.com/apps/${slug}/installations/new?state=${encodeURIComponent(state)}`;
  return c.json({ url });
});

/** GET repos: repos across the org's installations (with their installationId). */
app.get("/repos", async (c) => {
  requirePermission(c, "dashboards:read");
  const organizationId = c.get("organizationId");
  const installs = await orgInstallations(organizationId);
  const repos: Array<{
    installationId: number;
    id: number;
    fullName: string;
    defaultBranch: string;
    private: boolean;
  }> = [];
  for (const inst of installs) {
    try {
      const list = await listInstallationRepos(inst.installationId);
      for (const r of list) repos.push({ installationId: inst.installationId, ...r });
    } catch (e) {
      console.error(`[github] repo list failed for installation ${inst.installationId}:`, e);
    }
  }
  repos.sort((a, b) => a.fullName.localeCompare(b.fullName));
  return c.json({ repos });
});

/** DELETE a connection (locally; the user can also uninstall on GitHub). */
app.delete("/installations/:installationId", async (c) => {
  requirePermission(c, CONNECT_PERMISSION);
  const organizationId = c.get("organizationId");
  const installationId = Number(c.req.param("installationId"));
  await db
    .update(githubInstallations)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(githubInstallations.organizationId, organizationId),
        eq(githubInstallations.installationId, installationId),
      ),
    );
  return c.json({ ok: true });
});

export { app as githubRoutes };

/** A positive integer installation id, or null. */
function parseInstallationId(raw: string | undefined): number | null {
  if (!raw || !/^\d{1,15}$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * The signed-in user on this browser request, or a Response to return
 * instead: a bounce through sign-in when there is no session at all (the
 * desktop app opens the install page in the system browser, which may not be
 * signed in yet), or the error redirect when the session is invalid.
 */
async function callbackSession(c: Context, errorUrl: string): Promise<string | Response> {
  if (!getCookie(c, "wos-session")) {
    const url = new URL(c.req.url);
    const returnTo = safeReturnPath(`${url.pathname}${url.search}`);
    if (!returnTo) return c.redirect(errorUrl);
    return c.redirect(`/api/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`);
  }
  const denied = await sessionMiddleware(c, async () => {});
  if (denied instanceof Response) return c.redirect(errorUrl);
  const userId = c.get("session")?.userId;
  return userId ?? c.redirect(errorUrl);
}

/**
 * Setup callback. GitHub sends `installation_id`, `setup_action`, and our
 * signed `state` here after the user installs the app; the OAuth leg then
 * returns here with `code` and a re-signed `state` carrying the installation.
 */
export const githubSetupRoute = new Hono();

githubSetupRoute.get("/github/setup", async (c) => {
  const setupAction = c.req.query("setup_action");
  const code = c.req.query("code");
  const verified = verifyInstallState(c.req.query("state") ?? "");

  if (!verified) {
    // Without a valid state we don't know the org, so the root is the best we
    // can do. The root layout surfaces the `github` param as a toast.
    return c.redirect(`${appUrl()}/?github=error`);
  }

  const { organizationId, returnTo } = verified;
  const returnUrl = (result: string) =>
    `${appUrl()}/org/${organizationId}/${returnTo && INSTALL_RETURN_PAGES.has(returnTo) ? returnTo : "agents"}?github=${result}`;

  // A member of an org without app-install rights can only *request* the
  // install; GitHub redirects here with setup_action=request and no
  // installation id. Nothing to record: an owner must approve it on GitHub.
  if (setupAction === "request") {
    return c.redirect(returnUrl("requested"));
  }

  // The state names a user; only that user, signed in on this browser, may
  // finish the flow. A leaked or replayed install URL is useless to anyone else.
  const session = await callbackSession(c, returnUrl("error"));
  if (session instanceof Response) return session;
  if (session !== verified.userId) {
    console.warn(
      `[github] setup callback: session user does not match state for org ${organizationId}`,
    );
    return c.redirect(returnUrl("error"));
  }
  // Re-checked now rather than trusted from when the URL was minted: the user
  // may have been removed from the org, or demoted, in the meantime.
  const access = await resolveEffectivePermissions(organizationId, {
    kind: "user",
    userId: session,
  });
  if (!hasPermission(access.permissions, CONNECT_PERMISSION)) {
    return c.redirect(returnUrl("error"));
  }

  const oauth = githubAppOAuthConfig();
  if (!oauth) {
    console.error(
      "[github] setup callback refused: GITHUB_APP_CLIENT_ID / GITHUB_APP_CLIENT_SECRET are not set, so the installation's owner cannot be verified.",
    );
    return c.redirect(returnUrl("error"));
  }

  const installationId =
    verified.installationId ?? parseInstallationId(c.req.query("installation_id"));
  if (installationId === null) {
    return c.redirect(returnUrl("error"));
  }

  if (!code) {
    // First leg: identify the GitHub user before believing `installation_id`.
    // The installation id rides inside a freshly signed state, never the URL.
    const next = signInstallState({
      organizationId,
      userId: session,
      returnTo,
      installationId,
    });
    return c.redirect(githubUserAuthorizeUrl(oauth.clientId, setupCallbackUrl(), next));
  }

  try {
    const userToken = await exchangeGithubUserCode(code, setupCallbackUrl());
    if (!(await userCanAccessInstallation(userToken, installationId))) {
      console.warn(
        `[github] setup callback: installation ${installationId} is not accessible to the authorizing GitHub user (org ${organizationId})`,
      );
      return c.redirect(returnUrl("error"));
    }
    const account = await getInstallation(installationId).catch(() => null);
    const result = await linkGithubInstallation({
      organizationId,
      userId: session,
      installationId,
      account,
    });
    if (result !== "linked") {
      console.warn(
        `[github] setup callback: installation ${installationId} is connected to another organization; refusing to move it to ${organizationId}`,
      );
      return c.redirect(returnUrl("error"));
    }
  } catch (err) {
    console.error("[github] setup callback failed:", err);
    return c.redirect(returnUrl("error"));
  }

  return c.redirect(returnUrl("connected"));
});
