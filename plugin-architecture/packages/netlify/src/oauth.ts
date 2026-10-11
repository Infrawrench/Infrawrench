/**
 * "Connect with Netlify": the OAuth declaration and the identity hook.
 *
 * Netlify OAuth applications (docs.netlify.com/api-and-cli-guides/api-guides/
 * get-started-with-api/, verified 2026-10):
 *   - Self-serve under User settings > Applications > OAuth applications
 *     (app.netlify.com/user/applications), each with one registered
 *     redirect URI, a client id and a client secret.
 *   - Authorize `https://app.netlify.com/authorize`. Netlify's own guides
 *     show the implicit flow (`response_type=token`); the authorization code
 *     flow (`response_type=code`, then `POST https://api.netlify.com/oauth/token`
 *     with `grant_type=authorization_code`, `code`, `client_id`,
 *     `client_secret`, `redirect_uri`) is what Netlify recommends for apps
 *     with a backend and what the standard helpers send.
 *   - No scopes: a token can do everything the user can (`access: "full"`).
 *   - Tokens do not expire and there is no refresh token. Resetting the
 *     Netlify password invalidates every OAuth token issued before it.
 *   - No documented PKCE or public-client support, so the flow is server only.
 *
 * The token authenticates exactly like a personal access token (Bearer), so
 * the client needs no change.
 */
import type {
  OAuthCompletionContext,
  OAuthCompletionResult,
  OAuthDeclaration,
  OAuthTokenSet,
} from "@infrawrench/plugin-base";

export const netlifyOAuth: OAuthDeclaration = {
  authorizeUrl: "https://app.netlify.com/authorize",
  tokenUrl: "https://api.netlify.com/oauth/token",
  scopes: [],
  tokenField: "accessToken",
  clients: { server: { auth: "client_secret_post" } },
  access: "full",
  refresh: "none",
  docsUrl: "https://docs.netlify.com/api-and-cli-guides/api-guides/get-started-with-api/",
};

const nonEmpty = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

/** Name the account after the Netlify user (full name, else email). */
export async function completeNetlifyOAuth(
  tokens: OAuthTokenSet,
  context: OAuthCompletionContext,
): Promise<OAuthCompletionResult> {
  try {
    const res = await context.fetch("https://api.netlify.com/api/v1/user", {
      headers: { Authorization: `Bearer ${tokens.accessToken}`, Accept: "application/json" },
    });
    if (!res.ok) return {};
    const user = (await res.json()) as { full_name?: string; email?: string; slug?: string };
    const name = nonEmpty(user.full_name) ?? nonEmpty(user.email) ?? nonEmpty(user.slug);
    return name ? { accountName: name } : {};
  } catch {
    return {};
  }
}
