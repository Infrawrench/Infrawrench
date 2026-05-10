import { Hono } from "hono";

/**
 * The WorkOS authorization server URL used for OAuth discovery. Defaults to
 * the AuthKit-hosted domain when `WORKOS_AUTHKIT_DOMAIN` is set; otherwise
 * falls back to `WORKOS_ISSUER` or the WorkOS API host.
 */
function getAuthorizationServerUrl(): string {
  const explicit = process.env["WORKOS_AUTHKIT_DOMAIN"] ?? process.env["WORKOS_ISSUER"];
  if (explicit) return explicit.replace(/\/$/, "");
  return "https://api.workos.com/user_management";
}

function getPublicBaseUrl(reqUrl: string): string {
  const fromEnv = process.env["PUBLIC_BASE_URL"];
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  const u = new URL(reqUrl);
  return `${u.protocol}//${u.host}`;
}

export function buildResourceMetadataUrl(reqUrl: string): string {
  return `${getPublicBaseUrl(reqUrl)}/.well-known/oauth-protected-resource`;
}

const app = new Hono();

/**
 * RFC 9728 — OAuth 2.0 Protected Resource Metadata. MCP clients fetch this
 * after a 401 with a `WWW-Authenticate: Bearer resource_metadata="…"` hint
 * to learn which authorization server backs this resource.
 */
app.get("/oauth-protected-resource", (c) => {
  const baseUrl = getPublicBaseUrl(c.req.url);
  const authServer = getAuthorizationServerUrl();
  return c.json({
    resource: `${baseUrl}/api/mcp`,
    authorization_servers: [authServer],
    scopes_supported: ["mcp"],
    bearer_methods_supported: ["header"],
    resource_documentation: `${baseUrl}/docs/features/mcp`,
  });
});

/**
 * Convenience proxy for clients that look for authorization-server metadata
 * on the resource host. Returns a redirect to the WorkOS-hosted document so
 * we don't have to keep the metadata in sync ourselves.
 */
app.get("/oauth-authorization-server", (c) => {
  const authServer = getAuthorizationServerUrl();
  return c.redirect(`${authServer}/.well-known/oauth-authorization-server`, 302);
});

export { app as wellKnownRoutes };
