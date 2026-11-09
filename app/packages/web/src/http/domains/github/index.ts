/**
 * GitHub App connect and repo listing, the handlers.
 *
 * The setup callback trusts nothing GitHub puts in its URL on its own: the
 * `installation_id` is a guessable integer, so the callback requires the
 * signed-in session of the user who asked for the install URL, then sends
 * them through the GitHub App user-authorization flow and records the
 * installation only if `GET /user/installations` shows that GitHub user can
 * access it.
 */
import { Effect, Layer } from "effect";
import { HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { and, eq, isNull } from "drizzle-orm";
import {
  exchangeGithubUserCode,
  getInstallation,
  githubAppOAuthConfig,
  githubAppSlug,
  githubUserAuthorizeUrl,
  isGithubAppConfigured,
  listInstallationRepos,
  signInstallState,
  userCanAccessInstallation,
  verifyInstallState,
} from "@infrawrench/server-core/github/app";
import { resolveEffectivePermissions } from "@infrawrench/server-core/permissions";
import { hasPermission } from "@infrawrench/server-core/permissions/catalog";
import {
  badRequest,
  CONNECT_PERMISSION,
  GithubApi,
  GithubAppRepos,
  GithubAppStatus,
  GithubInstallUrl,
  Ok,
} from "@infrawrench/api-contract";
import { safeReturnPath } from "../../../api/oauth-state";
import { db } from "../../../db/client";
import { githubInstallations } from "../../../db/schema";
import { linkGithubInstallation } from "../../../services/github-installations";
import { makeDomain } from "../../domain";
import { legacy } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import { SESSION_COOKIE } from "../../session-cookie";
import { sessionPerson } from "../../session-person";

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

/** Pages the setup callback may send the user back to (path under /org/:orgId). */
const INSTALL_RETURN_PAGES = new Set([
  "agents",
  "workflows",
  "settings/github-issues",
  "settings/pr-checks",
  "ci",
]);

const orgInstallations = (organizationId: string) =>
  legacy(() =>
    db
      .select()
      .from(githubInstallations)
      .where(
        and(
          eq(githubInstallations.organizationId, organizationId),
          isNull(githubInstallations.deletedAt),
        ),
      ),
  );

interface InstallationRepo {
  installationId: number;
  id: number;
  fullName: string;
  defaultBranch: string;
  private: boolean;
}

const GithubHandlers = HttpApiBuilder.group(GithubApi, "github", (h) =>
  h
    // Whether the app is configured, and the org's connections.
    .handle("status", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const installs = yield* orgInstallations(organizationId);
        return yield* respond(GithubAppStatus)({
          configured: isGithubAppConfigured(),
          appSlug: githubAppSlug(),
          installations: installs.map((i) => ({
            installationId: i.installationId,
            accountLogin: i.accountLogin,
          })),
        });
      }),
    )
    // The GitHub "install this app" URL with a signed state.
    .handle("installUrl", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const slug = githubAppSlug();
        if (!isGithubAppConfigured() || !slug) {
          return yield* badRequest("GitHub App is not configured on this server.");
        }
        if (!githubAppOAuthConfig()) {
          // Without the client credentials the callback cannot prove who
          // installed the app, and refuses every install; say so before the
          // round-trip.
          return yield* badRequest(
            "GitHub App user authorization is not configured on this server (GITHUB_APP_CLIENT_ID / GITHUB_APP_CLIENT_SECRET).",
          );
        }
        const returnToRaw = searchParams(request.url).get("return") ?? "";
        const returnTo = INSTALL_RETURN_PAGES.has(returnToRaw) ? returnToRaw : "agents";
        const state = signInstallState({ organizationId, userId: session.userId, returnTo });
        const url = `https://github.com/apps/${slug}/installations/new?state=${encodeURIComponent(state)}`;
        return yield* respond(GithubInstallUrl)({ url });
      }),
    )
    // Repos across the org's installations (with their installationId).
    .handle("repos", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const installs = yield* orgInstallations(organizationId);
        const repos = yield* legacy(async () => {
          const out: InstallationRepo[] = [];
          for (const inst of installs) {
            try {
              const list = await listInstallationRepos(inst.installationId);
              for (const r of list) out.push({ installationId: inst.installationId, ...r });
            } catch (e) {
              console.error(
                `[github] repo list failed for installation ${inst.installationId}:`,
                e,
              );
            }
          }
          return out;
        });
        repos.sort((a, b) => a.fullName.localeCompare(b.fullName));
        return yield* respond(GithubAppRepos)({ repos });
      }),
    )
    // Drop a connection (locally; the user can also uninstall on GitHub).
    .handle("disconnect", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const installationId = Number(params.installationId);
        yield* legacy(() =>
          db
            .update(githubInstallations)
            .set({ deletedAt: new Date(), updatedAt: new Date() })
            .where(
              and(
                eq(githubInstallations.organizationId, organizationId),
                eq(githubInstallations.installationId, installationId),
              ),
            ),
        );
        return yield* respond(Ok)({
          ok: true,
        });
      }),
    ),
);

/** The query string of a request URL, which HttpApi hands over as a path. */
const searchParams = (url: string) => new URL(url, "http://localhost").searchParams;

/** A positive integer installation id, or null. */
function parseInstallationId(raw: string | null): number | null {
  if (!raw || !/^\d{1,15}$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

const redirect = (location: string) => HttpServerResponse.redirect(location);

const GithubSetupHandlers = HttpApiBuilder.group(GithubApi, "githubSetup", (h) =>
  // GitHub sends `installation_id`, `setup_action`, and our signed `state`
  // here after the user installs the app; the OAuth leg then returns here
  // with `code` and a re-signed `state` carrying the installation.
  h.handle("setup", ({ request }) =>
    Effect.gen(function* () {
      const url = new URL(request.url, "http://localhost");
      const query = url.searchParams;
      const setupAction = query.get("setup_action");
      const code = query.get("code");
      const verified = verifyInstallState(query.get("state") ?? "");

      if (!verified) {
        // Without a valid state we don't know the org, so the root is the best
        // we can do. The root layout surfaces the `github` param as a toast.
        return redirect(`${appUrl()}/?github=error`);
      }

      const { organizationId, returnTo } = verified;
      const returnUrl = (result: string) =>
        `${appUrl()}/org/${organizationId}/${returnTo && INSTALL_RETURN_PAGES.has(returnTo) ? returnTo : "agents"}?github=${result}`;

      // A member of an org without app-install rights can only *request* the
      // install; GitHub redirects here with setup_action=request and no
      // installation id. Nothing to record: an owner must approve it on GitHub.
      if (setupAction === "request") return redirect(returnUrl("requested"));

      // The state names a user; only that user, signed in on this browser, may
      // finish the flow. A leaked or replayed install URL is useless to anyone
      // else. A browser with no session at all is bounced through sign-in (the
      // desktop app opens the install page in the system browser, which may
      // not be signed in yet); an invalid session is the error redirect.
      if (!request.cookies[SESSION_COOKIE]) {
        const back = safeReturnPath(`${url.pathname}${url.search}`);
        if (!back) return redirect(returnUrl("error"));
        return redirect(`/api/auth/sign-in?return_to=${encodeURIComponent(back)}`);
      }
      const person = yield* Effect.result(sessionPerson);
      if (person._tag === "Failure") return redirect(returnUrl("error"));
      const userId = person.success.userId;
      if (!userId) return redirect(returnUrl("error"));
      if (userId !== verified.userId) {
        console.warn(
          `[github] setup callback: session user does not match state for org ${organizationId}`,
        );
        return redirect(returnUrl("error"));
      }
      // Re-checked now rather than trusted from when the URL was minted: the
      // user may have been removed from the org, or demoted, in the meantime.
      const access = yield* legacy(() =>
        resolveEffectivePermissions(organizationId, { kind: "user", userId }),
      );
      if (!hasPermission(access.permissions, CONNECT_PERMISSION)) {
        return redirect(returnUrl("error"));
      }

      const oauth = githubAppOAuthConfig();
      if (!oauth) {
        console.error(
          "[github] setup callback refused: GITHUB_APP_CLIENT_ID / GITHUB_APP_CLIENT_SECRET are not set, so the installation's owner cannot be verified.",
        );
        return redirect(returnUrl("error"));
      }

      const installationId =
        verified.installationId ?? parseInstallationId(query.get("installation_id"));
      if (installationId === null) return redirect(returnUrl("error"));

      if (!code) {
        // First leg: identify the GitHub user before believing
        // `installation_id`. The installation id rides inside a freshly signed
        // state, never the URL.
        const next = signInstallState({ organizationId, userId, returnTo, installationId });
        return redirect(githubUserAuthorizeUrl(oauth.clientId, setupCallbackUrl(), next));
      }

      const outcome = yield* legacy(async (): Promise<"connected" | "error"> => {
        try {
          const userToken = await exchangeGithubUserCode(code, setupCallbackUrl());
          if (!(await userCanAccessInstallation(userToken, installationId))) {
            console.warn(
              `[github] setup callback: installation ${installationId} is not accessible to the authorizing GitHub user (org ${organizationId})`,
            );
            return "error";
          }
          const account = await getInstallation(installationId).catch(() => null);
          const result = await linkGithubInstallation({
            organizationId,
            userId,
            installationId,
            account,
          });
          if (result !== "linked") {
            console.warn(
              `[github] setup callback: installation ${installationId} is connected to another organization; refusing to move it to ${organizationId}`,
            );
            return "error";
          }
          return "connected";
        } catch (err) {
          console.error("[github] setup callback failed:", err);
          return "error";
        }
      });
      return redirect(returnUrl(outcome));
    }),
  ),
);

export const githubDomain = makeDomain(
  "github",
  GithubApi,
  Layer.mergeAll(GithubHandlers, GithubSetupHandlers),
);
