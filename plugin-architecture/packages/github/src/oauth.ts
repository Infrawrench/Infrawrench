/**
 * "Connect with GitHub": a GitHub App's user access token (the web
 * application flow), not an OAuth App.
 *
 * A GitHub App's user token carries the fine-grained permissions configured
 * on the app, intersected with what the signed-in user may do, where an OAuth
 * App would need broad classic scopes (`admin:org`, `repo`) for the same
 * endpoints. The billing usage, summary and AI credit endpoints this plugin
 * reads list "GitHub App user access tokens" among the token types they
 * accept, with "Administration" organization permission (read) for an
 * organization and "Enterprise billing" enterprise permission (read) for an
 * enterprise (GitHub REST docs, "Billing usage", verified 2026-10).
 *
 * Protocol facts (GitHub docs, "Generating a user access token for a GitHub
 * App" and "Refreshing user access tokens", verified 2026-10):
 * - authorize `https://github.com/login/oauth/authorize`, token
 *   `https://github.com/login/oauth/access_token`; the token call needs
 *   `Accept: application/json` to answer JSON (the shared helper sends it).
 * - PKCE (S256 only) is supported, but the client secret is still required
 *   for the web flow, so there is no public desktop client.
 * - Scopes are configured on the app; the only meaningful `scope` value is
 *   `offline_access`, which guarantees an expiring token and a refresh token
 *   even if the app has expiring tokens switched off.
 * - Access tokens last 8 hours, refresh tokens 6 months, and every refresh
 *   rotates the refresh token.
 * - The token only reaches organizations and enterprises the app is installed
 *   on, which is why the owner picker lists installations for these accounts.
 *
 * Only github.com: GHE.com data residency and GitHub Enterprise Server run
 * their own instances, where this app does not exist; they keep the pasted
 * token form.
 */

import type {
  OAuthCompletionContext,
  OAuthCompletionResult,
  OAuthDeclaration,
  OAuthTokenSet,
} from "@infrawrench/plugin-base";
import { OAUTH_CREDENTIAL_KEY } from "@infrawrench/plugin-base";
import { formatOwner, resolveHost } from "./api.js";

export const GITHUB_OAUTH: OAuthDeclaration = {
  authorizeUrl: "https://github.com/login/oauth/authorize",
  tokenUrl: "https://github.com/login/oauth/access_token",
  scopes: ["offline_access"],
  tokenField: "token",
  clients: { server: { pkce: true } },
  // Budgets, Copilot seats, runners, caches and codespaces are managed from
  // the app, so the app is registered with read and write permissions.
  access: "read-write",
  refresh: "rotating",
  docsUrl: "https://docs.github.com/en/apps/using-github-apps/authorizing-github-apps",
};

const API = "https://api.github.com";

/** True when a credential set came from Connect with GitHub (sealed or stored grant). */
export function isOAuthConnected(credentials: Record<string, string>): boolean {
  return Boolean(credentials[OAUTH_CREDENTIAL_KEY]);
}

/** OAuth tokens are issued by github.com and are worthless anywhere else. */
export function validateOAuthHost(credentials: Record<string, string>): string | null {
  if (!isOAuthConnected(credentials)) return null;
  if (resolveHost(credentials["host"]).dataResidency) {
    return "Connect with GitHub works for github.com only. For a GHE.com enterprise, use a token instead.";
  }
  return null;
}

interface GhUser {
  login?: string;
  name?: string | null;
}

export interface GhInstallation {
  target_type?: string;
  account?: { login?: string; slug?: string; name?: string | null } | null;
}

async function getJson<T>(doFetch: typeof fetch, token: string, path: string): Promise<T> {
  const res = await doFetch(`${API}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Infrawrench",
    },
  });
  if (!res.ok) throw new Error(`GitHub API error ${res.status} for ${path}`);
  return (await res.json()) as T;
}

/** Owner ids (`org:<login>` / `enterprise:<slug>`) the app is installed on. */
export function installationOwners(
  installations: GhInstallation[],
): Array<{ id: string; label: string; description: string }> {
  const out: Array<{ id: string; label: string; description: string }> = [];
  for (const inst of installations) {
    const type = (inst.target_type ?? "").toLowerCase();
    if (type === "organization" && inst.account?.login) {
      const login = inst.account.login;
      out.push({
        id: formatOwner({ kind: "org", slug: login }),
        label: inst.account.name || login,
        description: `Organization ${login}`,
      });
    } else if (type === "enterprise" && inst.account?.slug) {
      const slug = inst.account.slug;
      out.push({
        id: formatOwner({ kind: "enterprise", slug }),
        label: inst.account.name || slug,
        description: `Enterprise ${slug}`,
      });
    }
  }
  return out;
}

/** Installations visible to a user access token, all pages. */
export async function fetchUserInstallations(
  doFetch: typeof fetch,
  token: string,
): Promise<GhInstallation[]> {
  const all: GhInstallation[] = [];
  for (let page = 1; page <= 10; page++) {
    const body = await getJson<{ installations?: GhInstallation[] }>(
      doFetch,
      token,
      `/user/installations?per_page=100&page=${page}`,
    );
    const batch = body.installations ?? [];
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

/**
 * After consent: name the account after the GitHub user, fix the host to
 * github.com, and pick the organization or enterprise when the app is
 * installed on exactly one. With several, the owner picker lists them.
 */
export async function completeGitHubOAuth(
  tokens: OAuthTokenSet,
  context: OAuthCompletionContext,
): Promise<OAuthCompletionResult> {
  const credentials: Record<string, string> = { host: "github.com" };
  const [user, installations] = await Promise.allSettled([
    getJson<GhUser>(context.fetch, tokens.accessToken, "/user"),
    fetchUserInstallations(context.fetch, tokens.accessToken),
  ]);
  const owners =
    installations.status === "fulfilled" ? installationOwners(installations.value) : [];
  let accountName: string | undefined;
  if (owners.length === 1) {
    credentials["owner"] = owners[0]!.id;
    accountName = `GitHub ${owners[0]!.label}`;
  } else if (user.status === "fulfilled" && user.value.login) {
    accountName = `GitHub (${user.value.login})`;
  }
  return { credentials, ...(accountName ? { accountName } : {}) };
}
