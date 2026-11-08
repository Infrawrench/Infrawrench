/**
 * OAuth discovery for the MCP endpoint: what `/.well-known/*` answers. The
 * routes themselves are an HttpApi domain (`http/domains/discovery/`); this
 * module holds the documents, and {@link buildResourceMetadataUrl} for the
 * `WWW-Authenticate` challenge `mcp/http-handler.ts` sends.
 */

/**
 * The AuthKit authorization server URL used for OAuth discovery. This must be
 * the AuthKit domain (e.g. `https://auth.example.com`): it is the only origin
 * that serves `/.well-known/oauth-authorization-server` with the `oauth2/*`
 * endpoints MCP clients need. `https://api.workos.com/user_management` does
 * *not* serve that document, so there is deliberately no fallback here: an
 * unset value fails loudly rather than advertising a dead authorization server.
 */
export function getAuthorizationServerUrl(): string | null {
  const explicit = process.env["WORKOS_AUTHKIT_DOMAIN"] ?? process.env["WORKOS_ISSUER"];
  if (!explicit) return null;
  return explicit.replace(/\/$/, "");
}

/**
 * The public origin this resource is reachable at. Behind the ingress the
 * request URL is plain http, so an explicit origin wins and `x-forwarded-proto`
 * is honoured before falling back to the request's own scheme. Getting this
 * wrong makes the advertised `resource` mismatch the URL the client connected
 * to, which MCP clients reject.
 */
export function getPublicBaseUrl(reqUrl: string, forwardedProto?: string | null): string {
  const fromEnv = process.env["PUBLIC_BASE_URL"] ?? process.env["APP_URL"];
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  const u = new URL(reqUrl);
  const proto = forwardedProto?.split(",")[0]?.trim();
  return `${proto ? `${proto}:` : u.protocol}//${u.host}`;
}

export function buildResourceMetadataUrl(reqUrl: string): string {
  return `${getPublicBaseUrl(reqUrl)}/.well-known/oauth-protected-resource/api/mcp`;
}

/**
 * The 500 every discovery document answers while no authorization server is
 * configured: an unset value fails loudly rather than advertising a dead one.
 */
export const DISCOVERY_UNCONFIGURED = {
  error: "server_error",
  error_description:
    "WORKOS_AUTHKIT_DOMAIN (or WORKOS_ISSUER) is not configured; MCP OAuth discovery is unavailable.",
} as const;

/**
 * RFC 9728: OAuth 2.0 Protected Resource Metadata. MCP clients fetch this
 * after a 401 with a `WWW-Authenticate: Bearer resource_metadata="…"` hint
 * to learn which authorization server backs this resource.
 *
 * Served at both the bare path and the resource-path-suffixed path
 * (`/.well-known/oauth-protected-resource/api/mcp`); RFC 9728 §3.1 defines the
 * latter for resources that live under a path, and clients derive it from the
 * MCP endpoint URL rather than reading the challenge header.
 */
export function protectedResourceMetadata(baseUrl: string, authServer: string) {
  return {
    resource: `${baseUrl}/api/mcp`,
    authorization_servers: [authServer],
    // Must be scopes the AuthKit authorization server actually grants:
    // advertising anything else makes the client's authorize call fail with
    // `invalid_scope`.
    scopes_supported: ["openid", "profile", "email", "offline_access"],
    bearer_methods_supported: ["header"],
    resource_documentation: `${baseUrl}/docs/features/mcp`,
    // The auth.md agent-registration block. Advertised beside the OAuth
    // metadata rather than instead of it: an agent with a human at the keyboard
    // should still use the interactive flow above, and this is for the one that
    // has nobody to send to a browser.
    agent_auth: agentAuthMetadata(baseUrl),
  };
}

/**
 * The `agent_auth` discovery block.
 *
 * `skill` points at the human- and agent-readable `auth.md`, which is what lets
 * an agent follow the flow by reading one document rather than by having its
 * vendor implement our API.
 */
function agentAuthMetadata(baseUrl: string) {
  return {
    identity_endpoint: `${baseUrl}/api/agent/identity`,
    claim_endpoint: `${baseUrl}/api/agent/identity/claim`,
    verification_uri: `${baseUrl}/claim`,
    identity_types_supported: ["anonymous"],
    skill: `${baseUrl}/auth.md`,
  };
}
