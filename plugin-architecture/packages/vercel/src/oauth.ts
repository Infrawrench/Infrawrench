/**
 * "Connect with Vercel": the OAuth declaration and hooks.
 *
 * Vercel's OAuth for REST API access is an Integration install
 * (vercel.com/docs/integrations/create-integration/vercel-api-integrations and
 * .../submit-integration, verified 2026-10):
 *   - The consent page is the integration's install URL,
 *     `https://vercel.com/integrations/<slug>/new`, which takes no client id
 *     and no redirect URI: Vercel redirects to the single Redirect URL set in
 *     the Integration Console, passing `code`, `configurationId`, `teamId`
 *     (when installed on a team), `next`, `source=external` and the `state`
 *     the install URL carried. Hence the `buildOAuthAuthorizeUrl` hook.
 *   - The code (valid 30 minutes, single use) is exchanged at
 *     `POST https://api.vercel.com/v2/oauth/access_token` with a form body of
 *     `client_id`, `client_secret`, `code` and `redirect_uri`. The response
 *     is `{ token_type, access_token, installation_id, user_id, team_id }`:
 *     a long-lived token with no expiry and no refresh token.
 *   - API scopes (None, Read or Read/Write per area) are configured on the
 *     integration, not requested per flow, so `scopes` is empty.
 *   - A team-installed token needs `?teamId=` on every call, which is exactly
 *     the plugin's existing Team ID field; `completeVercelOAuth` pre-fills it.
 *   - Confidential only (one fixed redirect URL and a client secret), so
 *     there is no desktop client.
 *
 * "Sign in with Vercel" (`vercel.com/oauth/authorize`, PKCE, rotating
 * refresh) would allow a public desktop client and finer permissions, but its
 * API permissions are in private beta; switch to it once they are generally
 * available.
 */
import {
  parseOAuthTokenResponse,
  OAuthTokenError,
  type OAuthAuthorizeUrlParams,
  type OAuthCompletionContext,
  type OAuthCompletionResult,
  type OAuthDeclaration,
  type OAuthExchangeRequest,
  type OAuthTokenSet,
} from "@infrawrench/plugin-base";

/**
 * The integration's URL slug (Integration Console > URL Slug). The install
 * URL is the only place it appears; a deployment that registers its own
 * integration under another slug changes it here.
 */
export const VERCEL_INTEGRATION_SLUG = "infrawrench";

export const vercelOAuth: OAuthDeclaration = {
  authorizeUrl: `https://vercel.com/integrations/${VERCEL_INTEGRATION_SLUG}/new`,
  tokenUrl: "https://api.vercel.com/v2/oauth/access_token",
  scopes: [],
  tokenField: "accessToken",
  clients: { server: { auth: "client_secret_post" } },
  // Scopes are per integration; the plugin manages projects, deployments,
  // domains, env vars, drains and Edge Config, so they are Read/Write.
  access: "read-write",
  refresh: "none",
  docsUrl: "https://vercel.com/docs/integrations/create-integration/vercel-api-integrations",
};

/** The install URL. It carries only `state`; the redirect is fixed on the integration. */
export function buildVercelAuthorizeUrl(params: OAuthAuthorizeUrlParams): string {
  const url = new URL(vercelOAuth.authorizeUrl);
  url.searchParams.set("state", params.state);
  return url.toString();
}

/** The documented exchange: exactly the four form fields Vercel lists. */
export async function exchangeVercelCode(request: OAuthExchangeRequest): Promise<OAuthTokenSet> {
  const body = new URLSearchParams({
    client_id: request.client.clientId,
    client_secret: request.client.clientSecret ?? "",
    code: request.code,
    redirect_uri: request.redirectUri,
  });
  const res = await request.fetch(vercelOAuth.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Not JSON; reported below.
  }
  if (!res.ok) {
    const err = json["error"];
    const message =
      (typeof json["error_description"] === "string" && json["error_description"]) ||
      (err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string"
        ? (err as { message: string }).message
        : typeof err === "string"
          ? err
          : `Vercel token endpoint returned HTTP ${res.status}`);
    throw new OAuthTokenError(message, res.status, err === "invalid_grant");
  }
  return parseOAuthTokenResponse(json);
}

const nonEmpty = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

async function vercelGet<T>(
  doFetch: typeof fetch,
  token: string,
  path: string,
): Promise<T | undefined> {
  try {
    const res = await doFetch(`https://api.vercel.com${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!res.ok) return undefined;
    return (await res.json()) as T;
  } catch {
    return undefined;
  }
}

/**
 * Pre-fill the Team ID from the exchange's `team_id` (null for a personal
 * install) and name the account after the team, or the user for a personal
 * install.
 */
export async function completeVercelOAuth(
  tokens: OAuthTokenSet,
  context: OAuthCompletionContext,
): Promise<OAuthCompletionResult> {
  const teamId = nonEmpty(tokens.raw["team_id"]);
  if (teamId) {
    const team = await vercelGet<{ name?: string; slug?: string }>(
      context.fetch,
      tokens.accessToken,
      `/v2/teams/${encodeURIComponent(teamId)}?teamId=${encodeURIComponent(teamId)}`,
    );
    const name = nonEmpty(team?.name) ?? nonEmpty(team?.slug);
    return { credentials: { teamId }, ...(name ? { accountName: name } : {}) };
  }
  const me = await vercelGet<{ user?: { username?: string; name?: string; email?: string } }>(
    context.fetch,
    tokens.accessToken,
    "/v2/user",
  );
  const name =
    nonEmpty(me?.user?.name) ?? nonEmpty(me?.user?.username) ?? nonEmpty(me?.user?.email);
  return name ? { accountName: name } : {};
}
