/**
 * The two documents an MCP client reads before it asks for anything: where
 * the MCP server's authorization server is (RFC 9728), and what that server
 * offers (RFC 8414). Here they are the same site.
 *
 * Every address in them is built from one origin, the site's own
 * (`SITE_ORIGIN`), never from the request: behind a proxy the request's
 * scheme and host are the proxy's, and a client refuses a `resource` or an
 * `issuer` that is not the address it asked.
 */
import { MCP_PATH, OAUTH_PATHS, WELL_KNOWN_PATHS } from "@infrawrench/git-contract";
import { OAUTH_SCOPES } from "./protocol";

/** The MCP server's canonical URI: what a client sends as `resource` (RFC 8707). */
export const resourceOf = (origin: string): string => `${origin}${MCP_PATH}`;

/** Where the protected resource metadata is: what the 401's `WWW-Authenticate` names. */
export const resourceMetadataUrl = (origin: string): string =>
  `${origin}${WELL_KNOWN_PATHS.protectedResource}${MCP_PATH}`;

/** RFC 9728. Served at the well-known path and at the same path with `/mcp` after it. */
export const protectedResourceMetadata = (origin: string) => ({
  resource: resourceOf(origin),
  authorization_servers: [origin],
  scopes_supported: [...OAUTH_SCOPES],
  bearer_methods_supported: ["header"],
  resource_name: new URL(origin).host,
});

/** RFC 8414, with what the MCP specification adds to it. */
export const authorizationServerMetadata = (origin: string) => ({
  issuer: origin,
  authorization_endpoint: `${origin}${OAUTH_PATHS.authorize}`,
  token_endpoint: `${origin}${OAUTH_PATHS.token}`,
  registration_endpoint: `${origin}${OAUTH_PATHS.register}`,
  revocation_endpoint: `${origin}${OAUTH_PATHS.revoke}`,
  scopes_supported: [...OAUTH_SCOPES],
  response_types_supported: ["code"],
  response_modes_supported: ["query"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  // PKCE with S256 is required of every client; `plain` is not taken.
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none"],
  revocation_endpoint_auth_methods_supported: ["none"],
  // A client id may be the address of a Client ID Metadata Document.
  client_id_metadata_document_supported: true,
  // Every authorization response carries `iss` (RFC 9207).
  authorization_response_iss_parameter_supported: true,
});

/**
 * Whether a `resource` parameter names this server. The MCP endpoint, or the
 * site (a client may send the less specific of the two); a trailing slash
 * and the case of the scheme and host are not held against it.
 */
export const isOurResource = (resource: string, origin: string): boolean => {
  let url: URL;
  try {
    url = new URL(resource);
  } catch {
    return false;
  }
  if (url.hash !== "" || url.search !== "") return false;
  if (url.origin !== new URL(origin).origin) return false;
  const path = url.pathname.replace(/\/+$/, "");
  return path === "" || path === MCP_PATH;
};

/** The `WWW-Authenticate` challenge of a 401 from the MCP endpoint (RFC 9728 section 5.1). */
export const bearerChallenge = (
  origin: string,
  problem?: { readonly error: string; readonly description: string },
): string =>
  [
    `Bearer resource_metadata="${resourceMetadataUrl(origin)}"`,
    `scope="${OAUTH_SCOPES.join(" ")}"`,
    ...(problem ? [`error="${problem.error}"`, `error_description="${problem.description}"`] : []),
  ].join(", ");
