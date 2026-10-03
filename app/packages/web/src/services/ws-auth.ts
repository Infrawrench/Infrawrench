/**
 * Who is on the other end of a WebSocket, and what they may do there.
 *
 * The HTTP org tree resolves a principal once per request and every route
 * reads the result (`apiKeyOrgMiddleware`, `agentOrgMiddleware`). A socket is
 * the same principal for its whole life, so it is resolved once at the upgrade
 * and the whole of it (key scopes, agent registration) travels with the socket
 * into every channel handler. Reducing it to `{organizationId, userId}` is what
 * let a key holding only `resources:execute` start workflow runs and deploys
 * with its owner's full role: `userId` alone resolves to that role.
 */
import { hasPermission } from "@infrawrench/server-core/permissions/catalog";

import { authenticateApiRequest } from "../auth/api-auth";
import { effectivePermissions, type PrincipalRef } from "../auth/effective-permissions";
import { validateWsToken } from "./ws-tokens";

export interface WsPrincipal extends PrincipalRef {
  /**
   * Present for API keys and agents: the ceiling `effectivePermissions`
   * intersects with (key) or the final answer (agent). Absent for a person.
   */
  scopes?: readonly string[];
  agentRegistrationId?: string;
}

/** What every channel on a gateway socket shares; see the upgrade in `server.ts`. */
export const WS_GATEWAY_PERMISSION = "resources:execute";

export type WsAuthOutcome = { ok: true; principal: WsPrincipal } | { ok: false; status: 401 | 403 };

/**
 * Resolve the `?token=` on an upgrade: a one-time ws-token from
 * `POST /ws-token`, or a bearer credential (API key, agent credential, WorkOS
 * access token) presented directly. Either way the principal must hold
 * `resources:execute` *effectively*: a key's scopes intersected with its
 * owner's current role, exactly as on HTTP, not the key's stored scopes alone.
 */
export async function authenticateWsUpgrade(token: string): Promise<WsAuthOutcome> {
  const principal = await resolveWsPrincipal(token);
  if (!principal) return { ok: false, status: 401 };
  if (!(await wsPrincipalCan(principal, WS_GATEWAY_PERMISSION))) {
    return { ok: false, status: 403 };
  }
  return { ok: true, principal };
}

async function resolveWsPrincipal(token: string): Promise<WsPrincipal | null> {
  const minted = await validateWsToken(token);
  if (minted) return minted;
  const auth = await authenticateApiRequest(
    new Request("http://localhost", { headers: { authorization: `Bearer ${token}` } }),
  );
  if (!auth) return null;
  return {
    organizationId: auth.organizationId,
    userId: auth.userId,
    // A key with no scopes is `[]`, never `undefined` (which means a person).
    ...(auth.apiKeyId ? { scopes: auth.scopes ?? [] } : {}),
    ...(auth.agentRegistrationId
      ? { scopes: auth.scopes ?? [], agentRegistrationId: auth.agentRegistrationId }
      : {}),
  };
}

/**
 * Whether `principal` holds `permission` right now. The same resolution the
 * HTTP middleware uses, so a socket can never do what the equivalent request
 * would be refused.
 */
export async function wsPrincipalCan(principal: WsPrincipal, permission: string): Promise<boolean> {
  const granted = await effectivePermissions(principal);
  return hasPermission(granted, permission);
}

/**
 * True for an API key or an agent: a principal with no person behind the
 * socket. Some channels are acts only a person performs; see
 * `API_KEY_DENY_RULES` in `auth/api-key-route-policy.ts`.
 */
export function isMachinePrincipal(principal: WsPrincipal): boolean {
  return principal.scopes !== undefined || principal.agentRegistrationId !== undefined;
}
