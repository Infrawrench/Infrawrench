/**
 * "Connect with Convex": a Convex OAuth application issuing team tokens.
 *
 * Protocol facts (Convex docs, "OAuth Applications", and the Management API
 * OpenAPI document at `https://api.convex.dev/v1/openapi.json`; verified
 * 2026-10):
 * - authorize `https://dashboard.convex.dev/oauth/authorize/team` (the
 *   plugin is team-scoped: it lists every project on the team), token
 *   `https://api.convex.dev/oauth/token` (form body with `client_secret`, so
 *   the flow is server-only). PKCE with S256 is optional and supported.
 * - The response is just `{ access_token, token_type }`: no expiry and no
 *   refresh token, so the token is used as-is until it is revoked.
 * - A team token can create projects and deployments and read and write data
 *   and functions on every project of the team, limited to the authorizing
 *   member's role. Convex offers no narrower or read-only token (`full`).
 * - The token works where a team access token does (`GET /token_details`
 *   reports `type: "teamToken"` with the team id), so the client needs no
 *   change. Member, invite and custom role endpoints do not accept OAuth
 *   team tokens.
 * - Unverified applications can be authorized by at most 100 teams.
 */

import type {
  OAuthCompletionContext,
  OAuthCompletionResult,
  OAuthDeclaration,
  OAuthTokenSet,
} from "@infrawrench/plugin-base";

export const CONVEX_OAUTH: OAuthDeclaration = {
  authorizeUrl: "https://dashboard.convex.dev/oauth/authorize/team",
  tokenUrl: "https://api.convex.dev/oauth/token",
  scopes: [],
  tokenField: "accessToken",
  clients: { server: { pkce: true } },
  access: "full",
  refresh: "none",
  docsUrl: "https://docs.convex.dev/platform-apis/oauth-applications",
};

/**
 * After consent: name the account after the team. Convex team tokens from
 * an OAuth application read `team:<team slug>|<secret>`, and the Management
 * API has no call that returns a team's name, so the slug is the label.
 */
export function completeConvexOAuth(
  tokens: OAuthTokenSet,
  _context: OAuthCompletionContext,
): Promise<OAuthCompletionResult> {
  const slug = /^team:([^|]+)\|/.exec(tokens.accessToken)?.[1];
  return Promise.resolve(slug ? { accountName: `Convex (${slug})` } : {});
}
