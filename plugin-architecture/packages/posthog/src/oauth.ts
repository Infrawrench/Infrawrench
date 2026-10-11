/**
 * "Connect with PostHog": PostHog Cloud as an OAuth 2.1 provider.
 *
 * Protocol facts (posthog.com/docs/api/oauth, the authorization server
 * metadata at `https://oauth.posthog.com/.well-known/oauth-authorization-server`,
 * and PostHog's `services/oauth-proxy` and `posthog/api/oauth` sources,
 * verified 2026-10):
 * - `oauth.posthog.com` is a region-agnostic front for US and EU Cloud: its
 *   authorize endpoint sends the user to their region (by session cookie, or
 *   a region picker) and its token endpoint routes the exchange and every
 *   later refresh to the same region. PostHog recommends it for new
 *   integrations, so one declaration covers both regions.
 * - Clients are identified by a Client ID Metadata Document (CIMD): the
 *   client id is an HTTPS URL serving JSON (`client_id`, `client_name`,
 *   `redirect_uris`, optional `logo_uri` and `com.posthog.scopes`). Nothing is
 *   registered with PostHog. CIMD clients are public (token endpoint auth
 *   `none`), always with PKCE S256. `127.0.0.1` redirect URIs match any port.
 * - Access tokens (`pha_`) last 7 days for CIMD clients; refresh tokens
 *   (`phr_`) are not rotated for them, so the refresh token is reusable.
 * - The token response carries `posthog_region` (`us`/`eu`),
 *   `scoped_organizations` and `scoped_teams` (what the user granted on the
 *   consent screen). Tokens are sent as `Authorization: Bearer`, exactly like
 *   a personal API key, so the REST client needs no change.
 *
 * Scopes: the same list the personal API key instructions ask for (see
 * `preflight.ts`): read and write for flags, experiments, analytics content,
 * destinations, batch exports and members, plus `query:read` and
 * `billing:read`. The plugin edits all of those, so `access` is read-write.
 *
 * PostHog Cloud only: a self-hosted instance is its own authorization server
 * with its own clients, so those keep the personal API key.
 */

import type {
  OAuthCompletionContext,
  OAuthCompletionResult,
  OAuthDeclaration,
  OAuthTokenSet,
} from "@infrawrench/plugin-base";
import { OAUTH_CREDENTIAL_KEY } from "@infrawrench/plugin-base";
import { CLOUD_HOSTS } from "./api.js";

export const POSTHOG_OAUTH_SCOPES = [
  "organization:read",
  "project:read",
  "feature_flag:read",
  "feature_flag:write",
  "experiment:read",
  "experiment:write",
  "dashboard:read",
  "dashboard:write",
  "insight:read",
  "insight:write",
  "cohort:read",
  "cohort:write",
  "action:read",
  "action:write",
  "annotation:read",
  "annotation:write",
  "hog_function:read",
  "hog_function:write",
  "batch_export:read",
  "batch_export:write",
  "query:read",
  "organization_member:read",
  "organization_member:write",
  "billing:read",
];

export const POSTHOG_OAUTH: OAuthDeclaration = {
  authorizeUrl: "https://oauth.posthog.com/oauth/authorize/",
  tokenUrl: "https://oauth.posthog.com/oauth/token/",
  scopes: POSTHOG_OAUTH_SCOPES,
  tokenField: "apiKey",
  clients: { server: { auth: "none", pkce: true }, desktop: { loopbackHost: "127.0.0.1" } },
  access: "read-write",
  refresh: "reusable",
  docsUrl: "https://posthog.com/docs/api/oauth",
};

/** OAuth tokens come from PostHog Cloud and mean nothing to a self-hosted instance. */
export function validateOAuthHost(credentials: Record<string, string>): string | null {
  if (!credentials[OAUTH_CREDENTIAL_KEY]) return null;
  if ((credentials["host"] ?? "").trim()) {
    return "Connect with PostHog works for PostHog Cloud only. For a self-hosted instance, clear the connection and use a personal API key.";
  }
  return null;
}

const asStrings = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : [];

async function getJson(
  context: OAuthCompletionContext,
  token: string,
  url: string,
): Promise<Record<string, unknown> | null> {
  try {
    const res = await context.fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * After consent: set the region PostHog answered from, pick the organization
 * the user granted (when it is exactly one), and name the account after it.
 */
export async function completePostHogOAuth(
  tokens: OAuthTokenSet,
  context: OAuthCompletionContext,
): Promise<OAuthCompletionResult> {
  const reported = String(tokens.raw["posthog_region"] ?? "").toLowerCase();
  const region = reported === "eu" ? "eu" : "us";
  const base = CLOUD_HOSTS[region]!;
  const credentials: Record<string, string> = { region };

  let orgId = "";
  const orgs = asStrings(tokens.raw["scoped_organizations"]);
  if (orgs.length === 1) {
    orgId = orgs[0]!;
  } else if (orgs.length === 0) {
    // Project-level grants name projects; the project names its organization.
    const teams = asStrings(tokens.raw["scoped_teams"]);
    if (teams.length > 0) {
      const project = await getJson(
        context,
        tokens.accessToken,
        `${base}/api/projects/${encodeURIComponent(teams[0]!)}/`,
      );
      const org = project?.["organization"];
      if (typeof org === "string") orgId = org;
      else if (org && typeof org === "object" && "id" in org) orgId = String(org.id);
    }
  }
  if (orgId) credentials["organizationId"] = orgId;

  const org = await getJson(
    context,
    tokens.accessToken,
    `${base}/api/organizations/${orgId ? encodeURIComponent(orgId) : "@current"}/`,
  );
  const name = typeof org?.["name"] === "string" ? org["name"] : "";
  return name ? { credentials, accountName: `PostHog (${name})` } : { credentials };
}
