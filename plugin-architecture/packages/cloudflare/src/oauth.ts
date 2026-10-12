/**
 * "Connect with Cloudflare": the OAuth declaration and the identity hook.
 *
 * Cloudflare opened OAuth to third-party clients ("self-managed OAuth",
 * developers.cloudflare.com/fundamentals/oauth/, verified 2026-10):
 *   - Authorize `https://dash.cloudflare.com/oauth2/auth`, token
 *     `https://dash.cloudflare.com/oauth2/token` (also in the issuer's
 *     `/.well-known/openid-configuration`).
 *   - Authorization Code only. Server-side apps authenticate with a client
 *     secret (`client_secret_basic` or `client_secret_post`); desktop and CLI
 *     apps are public clients with `token_endpoint_auth_method: none` and
 *     PKCE S256 required. Redirect URIs are an exact-match allow list and a
 *     loopback `http://127.0.0.1:<port>/...` is accepted.
 *   - Scope IDs mirror API token permission groups in dotted form
 *     (`dns.read`, `workers-scripts.write`); the authorize request may only ask
 *     for scopes configured on the client. `offline_access` must be requested
 *     (with the refresh_token grant enabled on the client) to get a refresh
 *     token. The scope IDs here match the catalog Cloudflare's own Workers
 *     tooling keeps (`workers-sdk/packages/workers-auth/src/cf/scopes.ts`).
 *   - The user picks which Cloudflare account(s) the grant covers on the
 *     consent screen.
 *
 * The scope list mirrors the API-token template in `preflight.ts`
 * (`TEMPLATE_SCOPES`): the plugin creates, edits and deletes resources, so
 * most areas need write. Billing has no OAuth scope at all (the third-party
 * catalog has none, and Cloudflare's own registration lists `billing:read` as
 * registered but not grantable), so cost collection uses
 * `account-api-tokens.write` to mint a short-lived Billing Read token per run
 * (see billing-token.ts). That scope is marked optional on both registered
 * clients, so a user can decline it and lose only cost graphs.
 */
import type {
  OAuthCompletionContext,
  OAuthCompletionResult,
  OAuthDeclaration,
  OAuthTokenSet,
} from "@infrawrench/plugin-base";

const rw = (area: string) => [`${area}.read`, `${area}.write`];

/** Scopes requested on the consent screen (must all be configured on the client). */
export const CLOUDFLARE_OAUTH_SCOPES: string[] = [
  // Identity and account discovery (`/user`, `/accounts`).
  "user-details.read",
  "memberships.read",
  "account-settings.read",
  // Resources: one entry per `TEMPLATE_SCOPES.resources` permission group.
  ...rw("zone"),
  ...rw("zone-settings"),
  ...rw("dns"),
  ...rw("ssl-and-certificates"),
  ...rw("page-rules"),
  ...rw("load-balancers"),
  ...rw("load-balancing-monitors-and-pools"),
  ...rw("access"),
  ...rw("workers-scripts"),
  "ai.read",
  ...rw("workers-kv-storage"),
  ...rw("workers-r2"),
  ...rw("workers-routes"),
  ...rw("d1"),
  ...rw("queues"),
  ...rw("query-cache"),
  ...rw("argotunnel"),
  ...rw("waiting-rooms"),
  ...rw("firewall-services"),
  ...rw("logs"),
  ...rw("healthcheck"),
  ...rw("challenge-widgets"),
  ...rw("notifications"),
  ...rw("vectorize"),
  ...rw("aig"),
  ...rw("pipelines"),
  ...rw("r2-catalog"),
  "r2-catalog-sql.read",
  "cache.purge",
  ...rw("cache-settings"),
  ...rw("ai-search"),
  ...rw("zone-waf"),
  ...rw("dynamic-redirect"),
  ...rw("email-routing-rule"),
  ...rw("secrets-store"),
  // Worker logs and traces: the telemetry query endpoint demands write.
  ...rw("workers-observability"),
  // Metrics.
  "analytics.read",
  "account-analytics.read",
  // Costs: mints the per-run Billing Read token (billing-token.ts). Optional
  // on the consent screen.
  "account-api-tokens.write",
  // Refresh tokens.
  "offline_access",
];

export const cloudflareOAuth: OAuthDeclaration = {
  authorizeUrl: "https://dash.cloudflare.com/oauth2/auth",
  tokenUrl: "https://dash.cloudflare.com/oauth2/token",
  scopes: CLOUDFLARE_OAUTH_SCOPES,
  tokenField: "apiToken",
  clients: {
    server: { auth: "client_secret_basic", pkce: true },
    desktop: { loopbackHost: "127.0.0.1" },
  },
  access: "read-write",
  refresh: "rotating",
  docsUrl: "https://developers.cloudflare.com/fundamentals/oauth/",
};

const API = "https://api.cloudflare.com/client/v4";

interface Envelope<T> {
  success?: boolean;
  result?: T;
}

async function cfGet<T>(
  doFetch: typeof fetch,
  token: string,
  path: string,
): Promise<T | undefined> {
  try {
    const res = await doFetch(`${API}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as Envelope<T>;
    return body.success ? body.result : undefined;
  } catch {
    return undefined;
  }
}

const nonEmpty = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

/**
 * Name the account after the Cloudflare account the user granted (when they
 * picked exactly one), else after the user. The plugin has no account-id
 * field to pre-fill: it resolves the account from the token at runtime.
 */
export async function completeCloudflareOAuth(
  tokens: OAuthTokenSet,
  context: OAuthCompletionContext,
): Promise<OAuthCompletionResult> {
  const accounts = await cfGet<Array<{ id?: string; name?: string }>>(
    context.fetch,
    tokens.accessToken,
    "/accounts?per_page=50",
  );
  if (accounts && accounts.length === 1) {
    const name = nonEmpty(accounts[0]?.name);
    if (name) return { accountName: name };
  }
  const user = await cfGet<{ email?: string }>(context.fetch, tokens.accessToken, "/user");
  const email = nonEmpty(user?.email);
  return email ? { accountName: email } : {};
}
