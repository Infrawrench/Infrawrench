/**
 * Effective permissions for a principal, outside the Hono middleware chain.
 *
 * `requirePermission` (auth/permissions.ts) covers HTTP routes, where
 * `permissionsMiddleware` has already put the resolved set on the context.
 * Surfaces that authenticate themselves — the chat endpoint, MCP, the chat
 * agent's tool loop — have no such context and resolve through here instead,
 * so all four surfaces agree on what a principal may do.
 */
import { resolveEffectivePermissions } from "@infrawrench/server-core/permissions";
import { intersectPermissions } from "@infrawrench/server-core/permissions/catalog";

export interface PrincipalRef {
  userId: string;
  organizationId: string;
  /**
   * Present only for API-key principals. `[]` is meaningful — a key with no
   * scopes — and is not the same as `undefined`, which means "not a key" and
   * grants the user's full role permissions.
   */
  scopes?: readonly string[] | undefined;
}

/**
 * The permissions `principal` actually holds in its organization.
 *
 * For a session or OAuth principal that is their role's permission set. For an
 * API key it is that set INTERSECTED with the key's scopes: a key can never
 * exceed the scopes it was minted with, nor the role its owner holds right
 * now — whichever is narrower wins.
 *
 * Deliberately un-memoized; see the note on `tools/permissions.ts`.
 */
export async function effectivePermissions(principal: PrincipalRef): Promise<readonly string[]> {
  const access = await resolveEffectivePermissions(
    principal.organizationId,
    { kind: "user", userId: principal.userId },
    // A break-glass grant is authority handed to a *person* for a bounded
    // window on a stated reason. Letting it flow into an unattended key that
    // person minted last quarter would turn a supervised, expiring elevation
    // into an unsupervised one — the exact failure the feature exists to
    // prevent. Keys see the owner's role and nothing else.
    { includeElevation: principal.scopes === undefined },
  );
  return principal.scopes
    ? intersectPermissions(access.permissions, principal.scopes)
    : access.permissions;
}
