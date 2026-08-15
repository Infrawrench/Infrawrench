import { verifyWorkosAccessToken } from "../auth/api-auth";
import { ensureUserFromClaims, hasMembership, listUserOrganizations } from "../api/auth-middleware";
import {
  resolveAgentPrincipal,
  touchAgentRegistration,
} from "@infrawrench/server-core/trials/principal";

export interface McpAuthContext {
  userId: string;
  organizationId: string;
  email?: string;
  /**
   * Set when the caller is an agent-auth registration rather than a person.
   *
   * Two things downstream must branch on it: the agent is bound to exactly one
   * org (so the `org_id` tool parameter must not move it), and its permissions
   * are already final (so they are not re-derived from a role).
   */
  agent?: {
    registrationId: string;
    claimed: boolean;
    permissions: readonly string[];
    /** Milliseconds until the trial org is destroyed; null once claimed. */
    trialExpiresInMs: number | null;
  };
}

/**
 * Validates an Authorization: Bearer header against WorkOS and resolves the
 * caller's user + organization. Returns null if the token is missing/invalid
 * or the caller belongs to no organization — the route should respond 401 with
 * a `WWW-Authenticate` header so MCP clients can discover the auth server.
 *
 * Unlike the browser session, the AuthKit OAuth tokens issued to MCP clients
 * are not guaranteed to carry an `org_id` claim (WorkOS does not document one
 * for this flow, and there is no org picker in an MCP client). When the claim
 * is absent we fall back to the caller's own membership rows. That grants no
 * new access: every candidate org is one the user is already a member of.
 */
export async function authenticateMcpRequest(
  authHeader: string | null | undefined,
): Promise<McpAuthContext | null> {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);

  const claims = await verifyWorkosAccessToken(token);
  if (!claims) {
    console.warn("[mcp-auth] rejected: access token failed JWT verification");
    return null;
  }
  if (!claims.sub) {
    console.warn("[mcp-auth] rejected: token has no sub claim");
    return null;
  }

  // Agent credentials first. `sub` is a registration id here, and the org it
  // acts in comes from our own binding rather than from the token — an agent
  // has exactly one tenant and no membership rows to fall back on.
  const agent = await resolveAgentPrincipal(claims.sub, { actorUserId: claims.act?.sub });
  if (agent) {
    void touchAgentRegistration(agent.registrationId);
    return {
      userId: agent.userId,
      organizationId: agent.organizationId,
      agent: {
        registrationId: agent.registrationId,
        claimed: agent.claimed,
        permissions: agent.permissions,
        trialExpiresInMs: agent.trialExpiresInMs,
      },
    };
  }

  const user = await ensureUserFromClaims(claims.sub, claims.email);
  if (!user) {
    console.warn(`[mcp-auth] rejected: could not resolve a user for sub ${claims.sub}`);
    return null;
  }

  let organizationId: string;
  if (claims.org_id) {
    // Verify the caller is already a member of the WorkOS-supplied org. We
    // never auto-provision memberships here — org creation is exclusive to
    // `POST /api/orgs` and memberships are added via explicit invites.
    if (!(await hasMembership(user.id, claims.org_id))) {
      console.warn(
        `[mcp-auth] rejected: user ${user.id} is not a member of token org ${claims.org_id}`,
      );
      return null;
    }
    organizationId = claims.org_id;
  } else {
    const orgs = await listUserOrganizations(user.id);
    const first = orgs[0];
    if (!first) {
      console.warn(`[mcp-auth] rejected: user ${user.id} belongs to no organization`);
      return null;
    }
    if (orgs.length > 1) {
      console.warn(
        `[mcp-auth] token for user ${user.id} carries no org_id and the user belongs to ` +
          `${orgs.length} orgs; defaulting to the oldest membership (${first.id}). ` +
          `Callers can override per call with the org_id tool parameter.`,
      );
    }
    organizationId = first.id;
  }

  const ctx: McpAuthContext = {
    userId: user.id,
    organizationId,
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
