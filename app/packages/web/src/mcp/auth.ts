import { verifyWorkosAccessToken } from "../auth/api-auth";
import { ensureUserFromClaims, ensureMembership } from "../api/auth-middleware";

export interface McpAuthContext {
  userId: string;
  organizationId: string;
  email?: string;
}

/**
 * Validates an Authorization: Bearer header against WorkOS and resolves the
 * caller's user + organization. Returns null if the token is missing/invalid
 * or has no `org_id` claim — the route should respond 401 with a
 * `WWW-Authenticate` header so MCP clients can discover the auth server.
 */
export async function authenticateMcpRequest(
  authHeader: string | null | undefined,
): Promise<McpAuthContext | null> {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);

  const claims = await verifyWorkosAccessToken(token);
  if (!claims?.sub || !claims.org_id) return null;

  const user = await ensureUserFromClaims(claims.sub, claims.email);
  if (!user) return null;

  await ensureMembership(user.id, claims.org_id);

  const ctx: McpAuthContext = {
    userId: user.id,
    organizationId: claims.org_id,
  };
  if (claims.email) ctx.email = claims.email;
  return ctx;
}

/**
 * Builds the `WWW-Authenticate` header that points MCP clients at our
 * protected-resource metadata document.
 */
export function buildWwwAuthenticate(resourceMetadataUrl: string): string {
  return `Bearer resource_metadata="${resourceMetadataUrl}"`;
}
