/**
 * GitHub App connect + repo-listing routes for git-triggered workflows.
 *
 * Org-scoped (`/api/org/:orgId/github/*`): report connection status, hand back
 * the install URL (with a signed `state` binding the install to this org), and
 * list the repos the org's installation(s) can access.
 *
 * Public setup callback (`/api/github/setup`): GitHub redirects the browser
 * here after the user installs/configures the app; we verify the signed state
 * and record the installation for that org. No session needed — the signed
 * state authorizes the org binding.
 */
import { Hono } from "hono";
import { and, eq, isNull } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "../../db/client";
import { githubInstallations } from "../../db/schema";
import {
  githubAppSlug,
  isGithubAppConfigured,
  listInstallationRepos,
  getInstallation,
  signInstallState,
  verifyInstallState,
} from "@infrawrench/server-core/github/app";
import { requirePermission } from "../../auth/permissions";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

function appUrl(): string {
  return process.env["APP_URL"] ?? process.env["NEXT_PUBLIC_APP_URL"] ?? "http://localhost:3000";
}

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
  requirePermission(c, "dashboards:write");
  const organizationId = c.get("organizationId");
  const slug = githubAppSlug();
  if (!isGithubAppConfigured() || !slug) {
    return c.json({ error: "GitHub App is not configured on this server." }, 400);
  }
  const returnToRaw = c.req.query("return") ?? "";
  const returnTo = INSTALL_RETURN_PAGES.has(returnToRaw) ? returnToRaw : "agents";
  const state = signInstallState(organizationId, returnTo);
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
  requirePermission(c, "dashboards:write");
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

/**
 * Public setup callback. GitHub sends `installation_id`, `setup_action`, and our
 * signed `state` here after the user installs the app.
 */
export const githubSetupRoute = new Hono();

githubSetupRoute.get("/github/setup", async (c) => {
  const installationIdRaw = c.req.query("installation_id");
  const setupAction = c.req.query("setup_action");
  const state = c.req.query("state") ?? "";
  const verified = verifyInstallState(state);
  const installationId = Number(installationIdRaw);

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
  // installation id. Nothing to record — an owner must approve it on GitHub.
  if (setupAction === "request") {
    return c.redirect(returnUrl("requested"));
  }

  if (!installationIdRaw || Number.isNaN(installationId)) {
    return c.redirect(returnUrl("error"));
  }

  const account = await getInstallation(installationId).catch(() => null);

  // Upsert (re-installs reuse the same installation id).
  const existing = await db
    .select({ id: githubInstallations.id })
    .from(githubInstallations)
    .where(eq(githubInstallations.installationId, installationId))
    .limit(1);
  if (existing[0]) {
    await db
      .update(githubInstallations)
      .set({
        organizationId,
        accountLogin: account?.accountLogin ?? null,
        accountType: account?.accountType ?? null,
        deletedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(githubInstallations.installationId, installationId));
  } else {
    await db.insert(githubInstallations).values({
      id: uuidv4(),
      organizationId,
      installationId,
      accountLogin: account?.accountLogin ?? null,
      accountType: account?.accountType ?? null,
    });
  }

  return c.redirect(returnUrl("connected"));
});
