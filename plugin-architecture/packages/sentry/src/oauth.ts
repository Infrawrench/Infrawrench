/**
 * "Connect with Sentry": a sentry.io OAuth application.
 *
 * Protocol facts (Sentry docs, "API Reference: Authentication", and Sentry's
 * own token endpoint and application model in getsentry/sentry,
 * `web/frontend/oauth_token.py` and `models/apiapplication.py`; verified
 * 2026-10):
 * - authorize `https://sentry.io/oauth/authorize/`, token
 *   `https://sentry.io/oauth/token/`. PKCE (S256) is "strongly recommended
 *   for all OAuth clients".
 * - An application created as public has no client secret and may use the
 *   authorization code grant with PKCE and the refresh grant; loopback
 *   redirects are matched per RFC 8252. So the desktop app gets its own
 *   public client.
 * - Access tokens expire after 30 days. A refresh issues a new access and
 *   refresh token, and the old refresh token then fails ("already rotated").
 * - The user picks one organization on the consent screen and the token is
 *   scoped to it: `GET /api/0/organizations/` on the control host returns just
 *   that organization, with `links.regionUrl` naming its data region.
 *
 * Scopes are the ones the plugin's capabilities need (see `preflight.ts`):
 * reading the organization, projects, teams, issues and alerts, and writing
 * them for the actions the plugin offers, plus releases.
 *
 * Only sentry.io: a self-hosted Sentry would need an application registered
 * on it, so self-hosted accounts keep the pasted token.
 */

import type {
  OAuthCompletionContext,
  OAuthCompletionResult,
  OAuthDeclaration,
  OAuthTokenSet,
} from "@infrawrench/plugin-base";
import { OAUTH_CREDENTIAL_KEY } from "@infrawrench/plugin-base";
import type { SentryOrganization } from "./mappers.js";
import { SENTRY_CONTROL_URL, SENTRY_REGIONS, resolveInstance } from "./regions.js";

export const SENTRY_OAUTH_SCOPES = [
  "org:read",
  "project:read",
  "project:write",
  "project:releases",
  "team:read",
  "team:write",
  "event:read",
  "event:write",
  "alerts:read",
  "alerts:write",
];

export const SENTRY_OAUTH: OAuthDeclaration = {
  authorizeUrl: `${SENTRY_CONTROL_URL}/oauth/authorize/`,
  tokenUrl: `${SENTRY_CONTROL_URL}/oauth/token/`,
  scopes: SENTRY_OAUTH_SCOPES,
  tokenField: "authToken",
  clients: { server: { pkce: true }, desktop: { loopbackHost: "127.0.0.1" } },
  access: "read-write",
  refresh: "rotating",
  docsUrl: "https://docs.sentry.io/api/auth/",
};

/** OAuth tokens are issued by sentry.io and mean nothing to a self-hosted install. */
export function validateOAuthInstance(credentials: Record<string, string>): string | null {
  if (!credentials[OAUTH_CREDENTIAL_KEY]) return null;
  try {
    if (resolveInstance(credentials["region"], credentials["baseUrl"]).selfHosted) {
      return "Connect with Sentry works for sentry.io only. For a self-hosted Sentry, use an auth token instead.";
    }
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return null;
}

/** The region picker id for an organization's `links.regionUrl`, defaulting to US. */
export function regionIdFor(regionUrl: string | undefined): string {
  if (!regionUrl) return SENTRY_REGIONS[0]!.id;
  let host: string;
  try {
    host = new URL(regionUrl).host;
  } catch {
    return SENTRY_REGIONS[0]!.id;
  }
  return SENTRY_REGIONS.find((r) => new URL(r.apiUrl).host === host)?.id ?? SENTRY_REGIONS[0]!.id;
}

/**
 * After consent: the token covers the one organization the user picked, so
 * fill in that organization and the region its data lives in, and name the
 * account after it.
 */
export async function completeSentryOAuth(
  tokens: OAuthTokenSet,
  context: OAuthCompletionContext,
): Promise<OAuthCompletionResult> {
  let orgs: SentryOrganization[];
  try {
    const res = await context.fetch(`${SENTRY_CONTROL_URL}/api/0/organizations/`, {
      headers: { Authorization: `Bearer ${tokens.accessToken}`, Accept: "application/json" },
    });
    if (!res.ok) return { credentials: { baseUrl: "" } };
    orgs = (await res.json()) as SentryOrganization[];
  } catch {
    return { credentials: { baseUrl: "" } };
  }
  const scopedId = tokens.raw["organization_id"];
  const org =
    (scopedId !== undefined ? orgs.find((o) => String(o.id) === String(scopedId)) : undefined) ??
    (orgs.length === 1 ? orgs[0] : undefined);
  if (!org) return { credentials: { baseUrl: "" } };
  return {
    credentials: {
      region: regionIdFor(org.links?.regionUrl),
      baseUrl: "",
      organization: org.slug,
    },
    accountName: `Sentry ${org.name ?? org.slug}`,
  };
}
