/**
 * "Connect with Resend": the OAuth declaration and the identity hook.
 *
 * Resend's OAuth 2.1 server (resend.com/docs/guides/building-a-resend-oauth-client,
 * verified 2026-10):
 *   - Authorize `https://api.resend.com/oauth/authorize`, token
 *     `https://api.resend.com/oauth/token`, revoke `.../oauth/revoke`,
 *     registration `.../oauth/register` (RFC 7591).
 *   - PKCE S256 is required on every code exchange. Confidential clients
 *     authenticate with `client_secret_basic` or `client_secret_post`; public
 *     clients use `token_endpoint_auth_method: none`. Loopback redirect URIs
 *     (`http://127.0.0.1/...`) accept any port; `localhost` and `127.0.0.1`
 *     are different hosts.
 *   - Two scopes: `emails:send` (send-only routes) and `full_access` (every
 *     other route). The plugin lists and manages domains, keys, webhooks and
 *     the rest, so it needs `full_access`: there is no read-only option.
 *   - Access tokens are JWTs that live 15 minutes. Refresh tokens rotate on
 *     every refresh with a sliding 60-day lifetime, and replaying an old one
 *     revokes the whole grant. The host persists each rotation under a lock,
 *     and the client asks `HostServices.oauth.getAccessToken()` per request
 *     because a client can outlive one access token.
 *   - The token response carries no team identifier and there is no userinfo
 *     endpoint; a token covers exactly one team.
 *
 * Clients are registered once (Resend has no console page for it yet; the
 * registration endpoint is the documented way) and configured through the
 * usual env variables. See `.git/provider-oauth/notes/resend.md`.
 */
import type {
  OAuthCompletionContext,
  OAuthCompletionResult,
  OAuthDeclaration,
  OAuthTokenSet,
} from "@infrawrench/plugin-base";

export const resendOAuth: OAuthDeclaration = {
  authorizeUrl: "https://api.resend.com/oauth/authorize",
  tokenUrl: "https://api.resend.com/oauth/token",
  scopes: ["full_access"],
  tokenField: "apiKey",
  clients: {
    server: { auth: "client_secret_post", pkce: true },
    desktop: { loopbackHost: "127.0.0.1" },
  },
  access: "full",
  refresh: "rotating",
  docsUrl: "https://resend.com/docs/guides/building-a-resend-oauth-client",
};

/**
 * Name the account after the team's first verified sending domain (the only
 * team-identifying data the API exposes), e.g. `Resend (example.com)`.
 */
export async function completeResendOAuth(
  tokens: OAuthTokenSet,
  context: OAuthCompletionContext,
): Promise<OAuthCompletionResult> {
  try {
    const res = await context.fetch("https://api.resend.com/domains?limit=100", {
      headers: { Authorization: `Bearer ${tokens.accessToken}`, Accept: "application/json" },
    });
    if (!res.ok) return {};
    const body = (await res.json()) as { data?: Array<{ name?: string; status?: string }> };
    const domains = body.data ?? [];
    const pick =
      domains.find((d) => d.status === "verified" && d.name) ?? domains.find((d) => d.name);
    return pick?.name ? { accountName: `Resend (${pick.name})` } : {};
  } catch {
    return {};
  }
}
