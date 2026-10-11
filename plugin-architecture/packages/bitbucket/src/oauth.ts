/**
 * "Connect with Bitbucket": a Bitbucket Cloud OAuth 2.0 consumer.
 *
 * Protocol facts (Bitbucket Cloud REST API introduction, "OAuth 2.0" and
 * "Bitbucket OAuth 2.0 scopes", and the February 2026 announcement "OAuth 2.0
 * and API authentication changes for Bitbucket Cloud", enforced from
 * 2026-05-04; verified 2026-10):
 * - authorize `https://bitbucket.org/site/oauth2/authorize`, token
 *   `https://bitbucket.org/site/oauth2/access_token`, with the consumer key
 *   and secret as HTTP Basic. No PKCE and no public clients are documented,
 *   so there is no desktop client.
 * - Scopes are the permissions ticked on the consumer; the authorize URL
 *   carries none.
 * - Access tokens expire after an hour. Every refresh returns a new refresh
 *   token and the old one stops working shortly after (rotating); an unused
 *   refresh token expires after three months.
 * - The token is sent only as `Authorization: Bearer` to api.bitbucket.org,
 *   which is what the client already does for a token without an email.
 */

import type {
  OAuthCompletionContext,
  OAuthCompletionResult,
  OAuthDeclaration,
  OAuthTokenSet,
} from "@infrawrench/plugin-base";
import { OAUTH_CREDENTIAL_KEY } from "@infrawrench/plugin-base";
import { API_BASE } from "./api.js";
import type { BbAccount, BbWorkspaceAccess } from "./types.js";

export const BITBUCKET_OAUTH: OAuthDeclaration = {
  authorizeUrl: "https://bitbucket.org/site/oauth2/authorize",
  tokenUrl: "https://bitbucket.org/site/oauth2/access_token",
  scopes: [],
  tokenField: "token",
  clients: { server: { auth: "client_secret_basic" } },
  // Pipelines are run and stopped, and variables, environments, webhooks,
  // deploy keys, branch restrictions and runners are created and deleted.
  access: "read-write",
  refresh: "rotating",
  docsUrl: "https://support.atlassian.com/bitbucket-cloud/docs/use-oauth-on-bitbucket-cloud/",
};

/** True when a credential set came from Connect with Bitbucket (sealed or stored grant). */
export function isOAuthConnected(credentials: Record<string, string>): boolean {
  return Boolean(credentials[OAUTH_CREDENTIAL_KEY]);
}

/**
 * The email to send with the token, if any. An OAuth token is a Bearer token,
 * so an email left over in the form from an earlier API token is ignored.
 */
export function emailFor(credentials: Record<string, string>): string {
  return isOAuthConnected(credentials) ? "" : (credentials["email"] ?? "").trim();
}

async function getJson<T>(doFetch: typeof fetch, token: string, path: string): Promise<T> {
  const res = await doFetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Bitbucket API error ${res.status} for ${path}`);
  return (await res.json()) as T;
}

/**
 * After consent: clear the email (OAuth tokens are Bearer), name the account
 * after the user, and pick the workspace when the user belongs to exactly
 * one. With several, the workspace picker lists them.
 */
export async function completeBitbucketOAuth(
  tokens: OAuthTokenSet,
  context: OAuthCompletionContext,
): Promise<OAuthCompletionResult> {
  const credentials: Record<string, string> = { email: "" };
  const [user, workspaces] = await Promise.allSettled([
    getJson<BbAccount>(context.fetch, tokens.accessToken, "/user"),
    getJson<{ values?: BbWorkspaceAccess[] }>(
      context.fetch,
      tokens.accessToken,
      "/user/workspaces?pagelen=100",
    ),
  ]);
  const slugs =
    workspaces.status === "fulfilled"
      ? (workspaces.value.values ?? []).filter((w) => w.workspace?.slug)
      : [];
  let accountName: string | undefined;
  if (slugs.length === 1) {
    const ws = slugs[0]!.workspace!;
    credentials["workspace"] = ws.slug;
    accountName = `Bitbucket ${ws.name ?? ws.slug}`;
  } else if (user.status === "fulfilled" && user.value.display_name) {
    accountName = `Bitbucket (${user.value.display_name})`;
  }
  return { credentials, ...(accountName ? { accountName } : {}) };
}
