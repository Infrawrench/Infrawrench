/**
 * "Connect with GitLab": GitLab.com as an OAuth 2.0 provider.
 *
 * Protocol facts (GitLab docs, "OAuth 2.0 identity provider API" and
 * "Configure GitLab as an OAuth 2.0 authentication identity provider",
 * verified 2026-10):
 * - authorize `https://gitlab.com/oauth/authorize`, token
 *   `https://gitlab.com/oauth/token`.
 * - PKCE (S256) lets a non-confidential application exchange the code without
 *   a client secret, so the desktop app has its own public client next to the
 *   server's confidential one.
 * - Access tokens are valid for two hours; a refresh returns a new access and
 *   refresh token and invalidates both old ones (rotating).
 * - OAuth access tokens are sent as `Authorization: Bearer`, never in the
 *   `PRIVATE-TOKEN` header; the REST client sends Bearer for every token.
 *
 * Scopes: `api` because the plugin runs pipelines and creates, edits and
 * deletes groups, projects, variables and more (GitLab's narrower `read_api`
 * would make every action fail), plus `create_runner` for registering
 * runners, the same set the personal access token link asks for.
 *
 * Only GitLab.com: a self-managed or Dedicated instance would need its own
 * OAuth application registered on it, so those keep the pasted token.
 */

import type {
  OAuthCompletionContext,
  OAuthCompletionResult,
  OAuthDeclaration,
  OAuthTokenSet,
} from "@infrawrench/plugin-base";
import { OAUTH_CREDENTIAL_KEY } from "@infrawrench/plugin-base";
import { GITLAB_COM, resolveBaseUrl } from "./api.js";

export const GITLAB_OAUTH: OAuthDeclaration = {
  authorizeUrl: `${GITLAB_COM}/oauth/authorize`,
  tokenUrl: `${GITLAB_COM}/oauth/token`,
  scopes: ["api", "create_runner"],
  tokenField: "token",
  clients: { server: { pkce: true }, desktop: { loopbackHost: "127.0.0.1" } },
  access: "read-write",
  refresh: "rotating",
  docsUrl: "https://docs.gitlab.com/integration/oauth_provider/",
};

/** OAuth tokens come from GitLab.com and mean nothing to another instance. */
export function validateOAuthInstance(credentials: Record<string, string>): string | null {
  if (!credentials[OAUTH_CREDENTIAL_KEY]) return null;
  if (resolveBaseUrl(credentials["url"]) !== GITLAB_COM) {
    return "Connect with GitLab works for GitLab.com only. For a self-managed or Dedicated instance, use an access token instead.";
  }
  return null;
}

/**
 * After consent: point the account at GitLab.com and name it after the
 * signed-in user. The group stays optional; its picker lists the groups.
 */
export async function completeGitLabOAuth(
  tokens: OAuthTokenSet,
  context: OAuthCompletionContext,
): Promise<OAuthCompletionResult> {
  const credentials = { url: GITLAB_COM };
  try {
    const res = await context.fetch(`${GITLAB_COM}/api/v4/user`, {
      headers: { Authorization: `Bearer ${tokens.accessToken}`, Accept: "application/json" },
    });
    if (!res.ok) return { credentials };
    const user = (await res.json()) as { username?: string };
    return user.username
      ? { credentials, accountName: `GitLab (${user.username})` }
      : { credentials };
  } catch {
    return { credentials };
  }
}
