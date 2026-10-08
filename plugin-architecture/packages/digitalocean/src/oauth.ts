/**
 * "Connect with DigitalOcean": the OAuth declaration and the identity hook.
 *
 * Verified against docs.digitalocean.com/reference/api/oauth/ (2026-10):
 *   - Authorize `https://cloud.digitalocean.com/v1/oauth/authorize`, token
 *     `https://cloud.digitalocean.com/v1/oauth/token`. The authorization
 *     server metadata lists `client_secret_post` and `none` as token endpoint
 *     auth methods and `S256` as the only PKCE method.
 *   - Confidential clients (registered in the control panel) get a 30-day
 *     access token; public clients (PKCE, no secret, created through Dynamic
 *     Client Registration) get a one-hour one. Loopback redirect URIs match on
 *     any port for public clients.
 *   - Every access token comes with a refresh token that can be used exactly
 *     once and returns a new one: rotating.
 *   - Scopes are the same granular `resource:action` scopes personal access
 *     tokens use (docs.digitalocean.com/reference/api/scopes/). The token
 *     response carries an `info` object with the user's name, email and team.
 *
 * The plugin creates, edits and deletes resources across most of the API, so
 * the request lists the read scope for everything it lists plus the write
 * scopes its create forms, detail actions and delete buttons use. It still
 * avoids the catch-all `api:write` alias and anything it never calls (SSH key
 * writes, team management, Functions, BYOIP, partner network).
 */
import type {
  OAuthCompletionContext,
  OAuthCompletionResult,
  OAuthDeclaration,
  OAuthTokenSet,
} from "@infrawrench/plugin-base";

const crud = (resource: string) => [
  `${resource}:read`,
  `${resource}:create`,
  `${resource}:update`,
  `${resource}:delete`,
];

/** Scopes requested on the consent screen, in the order DigitalOcean lists them. */
export const DIGITALOCEAN_OAUTH_SCOPES: string[] = [
  "account:read",
  "actions:read",
  ...crud("app"),
  "billing:read",
  ...crud("block_storage"),
  "block_storage_action:read",
  "block_storage_action:create",
  "block_storage_snapshot:read",
  "block_storage_snapshot:create",
  "block_storage_snapshot:delete",
  ...crud("cdn"),
  "certificate:read",
  "certificate:create",
  "certificate:delete",
  ...crud("database"),
  // Not part of DigitalOcean's "Full Access" token either: needed to read the
  // password of a Kafka/MongoDB user the plugin mints for the peer tabs.
  "database:view_credentials",
  ...crud("dedicated_inference"),
  ...crud("domain"),
  ...crud("droplet"),
  ...crud("firewall"),
  ...crud("genai"),
  ...crud("image"),
  // Droplet logs from DigitalOcean Insights.
  "insights:read",
  ...crud("kubernetes"),
  // Kubeconfig download for the Kubernetes plugin.
  "kubernetes:access_cluster",
  ...crud("load_balancer"),
  "monitoring:read",
  ...crud("nat_gateway"),
  ...crud("nfs"),
  ...crud("project"),
  "project:assign_resource",
  "regions:read",
  ...crud("registry"),
  ...crud("reserved_ip"),
  "sizes:read",
  "snapshot:read",
  "snapshot:delete",
  // Bucket-scoped Spaces keys minted for bucket creation and credential export.
  "spaces_key:read",
  "spaces_key:create_credentials",
  "ssh_key:read",
  "tag:read",
  ...crud("uptime"),
  ...crud("vpc"),
  ...crud("vpc_peering"),
];

export const digitaloceanOAuth: OAuthDeclaration = {
  authorizeUrl: "https://cloud.digitalocean.com/v1/oauth/authorize",
  tokenUrl: "https://cloud.digitalocean.com/v1/oauth/token",
  scopes: DIGITALOCEAN_OAUTH_SCOPES,
  tokenField: "apiToken",
  clients: {
    server: { auth: "client_secret_post", pkce: true },
    desktop: { loopbackHost: "127.0.0.1" },
  },
  access: "read-write",
  refresh: "rotating",
  docsUrl: "https://docs.digitalocean.com/reference/api/oauth/",
};

interface DoTokenInfo {
  name?: string;
  email?: string;
  uuid?: string;
  team_uuid?: string;
  team_name?: string;
}

interface DoAccountResponse {
  account?: { email?: string; name?: string; team?: { name?: string } };
}

const nonEmpty = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

/**
 * Name the account after the DigitalOcean team the user authorized (an OAuth
 * grant is per team). The token response already says which; `/v2/account`
 * is the fallback when a response omits `info`.
 */
export async function completeDigitalOceanOAuth(
  tokens: OAuthTokenSet,
  context: OAuthCompletionContext,
): Promise<OAuthCompletionResult> {
  const info = (tokens.raw["info"] ?? {}) as DoTokenInfo;
  let team = nonEmpty(info.team_name);
  let person = nonEmpty(info.email) ?? nonEmpty(info.name);
  if (!team && !person) {
    try {
      const res = await context.fetch("https://api.digitalocean.com/v2/account", {
        headers: { Authorization: `Bearer ${tokens.accessToken}`, Accept: "application/json" },
      });
      if (res.ok) {
        const body = (await res.json()) as DoAccountResponse;
        team = nonEmpty(body.account?.team?.name);
        person = nonEmpty(body.account?.email) ?? nonEmpty(body.account?.name);
      }
    } catch {
      // The name is a convenience; the connection itself already succeeded.
    }
  }
  const accountName = team ?? person;
  return accountName ? { accountName } : {};
}
