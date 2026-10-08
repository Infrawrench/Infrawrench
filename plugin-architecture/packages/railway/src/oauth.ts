/**
 * "Connect with Railway" (Login with Railway): the OAuth declaration, the
 * identity hook, and workspace discovery for OAuth tokens.
 *
 * Verified against docs.railway.com/integrations/oauth (2026-10):
 *   - Authorize `https://backboard.railway.com/oauth/auth`, token
 *     `https://backboard.railway.com/oauth/token`. `openid` is required in
 *     every request; scopes are space separated.
 *   - Web apps are confidential clients (`client_secret_basic` or
 *     `client_secret_post`, PKCE recommended); native apps are public clients
 *     (auth method `none`, PKCE S256 required, no secret). A native redirect
 *     must use `127.0.0.1`, not `localhost`, and redirect URIs match exactly.
 *   - Access tokens last one hour. A refresh token needs `offline_access`
 *     AND `prompt=consent`; refresh tokens rotate, and an old one fails.
 *   - `workspace:viewer|member|admin` grant access to the workspaces the user
 *     picks on the consent screen, capped at the user's own role there.
 *     Listing them (`me { workspaces }`) also needs `email` and `profile`.
 *   - OAuth access tokens call the public GraphQL API with
 *     `Authorization: Bearer`, the same header account tokens use.
 *
 * The plugin deploys, restarts, rolls back, edits variables, volumes and
 * domains, and reads and sets usage limits and credits, which are workspace
 * admin features. So it asks for `workspace:admin`; a user who is only a
 * member of a workspace gets member access there and the billing features
 * report that they need an admin, exactly as with a member's API token.
 */
import {
  OAUTH_CREDENTIAL_KEY,
  type OAuthCompletionContext,
  type OAuthCompletionResult,
  type OAuthDeclaration,
  type OAuthTokenSet,
} from "@infrawrench/plugin-base";
import { GRAPHQL_URL, type RailwayApi } from "./api.js";
import { Q_ME_WORKSPACES, Q_TOKEN_WORKSPACES } from "./queries.js";
import type { RwWorkspaceRef } from "./types.js";

export const RAILWAY_OAUTH_SCOPES = [
  "openid",
  "email",
  "profile",
  "offline_access",
  "workspace:admin",
];

export const railwayOAuth: OAuthDeclaration = {
  authorizeUrl: "https://backboard.railway.com/oauth/auth",
  tokenUrl: "https://backboard.railway.com/oauth/token",
  scopes: RAILWAY_OAUTH_SCOPES,
  // Without prompt=consent a returning user can skip the consent screen and
  // Railway then issues no refresh token.
  authorizeParams: { prompt: "consent" },
  tokenField: "apiToken",
  clients: {
    server: { auth: "client_secret_basic", pkce: true },
    desktop: { loopbackHost: "127.0.0.1" },
  },
  access: "read-write",
  refresh: "rotating",
  docsUrl: "https://docs.railway.com/integrations/oauth",
};

/** True when the credential set came from "Connect with Railway". */
export function isRailwayOAuth(credentials: Record<string, string>): boolean {
  return Boolean(credentials[OAUTH_CREDENTIAL_KEY]);
}

interface MeWorkspaces {
  me: { name?: string | null; email?: string | null; workspaces?: RwWorkspaceRef[] | null };
}

/**
 * Workspaces the credential can see: an API token's own workspace list, or
 * the workspaces an OAuth grant covers.
 */
export async function credentialWorkspaces(
  api: RailwayApi,
  oauth: boolean,
): Promise<RwWorkspaceRef[]> {
  if (oauth) {
    const res = await api.gql<MeWorkspaces>(Q_ME_WORKSPACES);
    return res.me?.workspaces ?? [];
  }
  const res = await api.gql<{ apiToken: { workspaces: RwWorkspaceRef[] } }>(Q_TOKEN_WORKSPACES);
  return res.apiToken?.workspaces ?? [];
}

const nonEmpty = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

/**
 * Pre-fill the workspace when the user granted exactly one, and name the
 * account after it (or after the user when they granted several).
 */
export async function completeRailwayOAuth(
  tokens: OAuthTokenSet,
  context: OAuthCompletionContext,
): Promise<OAuthCompletionResult> {
  let me: MeWorkspaces["me"] | undefined;
  try {
    const res = await context.fetch(GRAPHQL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${tokens.accessToken}`,
      },
      body: JSON.stringify({ query: Q_ME_WORKSPACES }),
    });
    if (res.ok) {
      const body = (await res.json()) as { data?: MeWorkspaces };
      me = body.data?.me;
    }
  } catch {
    // Pre-filling is a convenience; the user can still pick the workspace.
  }
  const workspaces = me?.workspaces ?? [];
  const only = workspaces.length === 1 ? workspaces[0] : undefined;
  if (only?.id) {
    return {
      credentials: { workspaceId: only.id },
      ...(nonEmpty(only.name) ? { accountName: only.name } : {}),
    };
  }
  const person = nonEmpty(me?.name) ?? nonEmpty(me?.email);
  return person ? { accountName: person } : {};
}
