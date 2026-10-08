/**
 * "Connect with PlanetScale": a PlanetScale OAuth application.
 *
 * Protocol facts (PlanetScale docs, "OAuth" and "OAuth access scopes", and
 * the API's OpenAPI document at `https://api.planetscale.com/v1/openapi-spec`;
 * verified 2026-10):
 * - authorize `https://auth.planetscale.com/oauth/authorize`, token
 *   `https://auth.planetscale.com/oauth/token`. Both the exchange and the
 *   refresh need the client secret, so the flow is server-only.
 * - Access scopes are selected on the application, per organization,
 *   database or branch, not in the authorize URL; the declaration requests
 *   none. The user can deny individual scopes, and the token response's
 *   `scope` lists what was granted (kept in the grant state).
 * - Access tokens (`pscale_oauth_...`) last 30 days and come with a refresh
 *   token. PlanetScale does not document rotation, so the refresh is treated
 *   as rotating, which is safe for either behavior.
 * - An OAuth token is sent as `Authorization: Bearer <token>`, unlike a
 *   service token's `<id>:<secret>`. The access token lands in the service
 *   token secret field and the ID stays empty; {@link planetscaleAuthorization}
 *   picks the header.
 *
 * The plugin creates and deletes databases, branches, passwords, roles,
 * backups, webhooks and deploy requests, so the application is registered
 * with the write scopes those need: read-write.
 */

import type {
  OAuthCompletionContext,
  OAuthCompletionResult,
  OAuthDeclaration,
  OAuthTokenSet,
} from "@infrawrench/plugin-base";
import { readOAuthGrantState } from "@infrawrench/plugin-base";

export const PLANETSCALE_API = "https://api.planetscale.com/v1";

/** Prefix PlanetScale gives OAuth access tokens. */
const OAUTH_TOKEN_PREFIX = "pscale_oauth_";

export const PLANETSCALE_OAUTH: OAuthDeclaration = {
  authorizeUrl: "https://auth.planetscale.com/oauth/authorize",
  tokenUrl: "https://auth.planetscale.com/oauth/token",
  scopes: [],
  tokenField: "serviceTokenSecret",
  clients: { server: {} },
  access: "read-write",
  refresh: "rotating",
  docsUrl: "https://planetscale.com/docs/api/reference/oauth",
};

/**
 * True for an OAuth connection: grant state is present, or (desktop cloud
 * mode, where the grant state is stripped before credentials reach the
 * client) the token carries PlanetScale's OAuth prefix.
 */
export function isPlanetScaleOAuth(credentials: Record<string, string>): boolean {
  return (
    readOAuthGrantState(credentials) !== null ||
    (credentials["serviceTokenSecret"] ?? "").startsWith(OAUTH_TOKEN_PREFIX)
  );
}

/** The Authorization header value for a credential set. */
export function planetscaleAuthorization(credentials: Record<string, string>): string {
  const secret = credentials["serviceTokenSecret"] ?? "";
  if (!secret) throw new Error("PlanetScale plugin: missing serviceTokenSecret credential");
  if (isPlanetScaleOAuth(credentials)) return `Bearer ${secret}`;
  const id = credentials["serviceTokenId"];
  if (!id) throw new Error("PlanetScale plugin: missing serviceTokenId credential");
  return `${id}:${secret}`;
}

/**
 * After consent: pre-fill the organization the user granted (the first one
 * when they granted several; the field stays editable) and name the account.
 */
export async function completePlanetScaleOAuth(
  tokens: OAuthTokenSet,
  context: OAuthCompletionContext,
): Promise<OAuthCompletionResult> {
  try {
    const res = await context.fetch(`${PLANETSCALE_API}/organizations`, {
      headers: { Authorization: `Bearer ${tokens.accessToken}`, Accept: "application/json" },
    });
    if (!res.ok) return {};
    const body = (await res.json()) as { data?: Array<{ name?: string }> };
    const name = body.data?.find((o) => !!o.name)?.name;
    return name
      ? { credentials: { organizationName: name }, accountName: `PlanetScale (${name})` }
      : {};
  } catch {
    return {};
  }
}
