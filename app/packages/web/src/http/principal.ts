/**
 * Who is calling, as Effect services the auth middleware provides.
 *
 * {@link OrgPrincipal} is the org tree's context: the same fields the Hono
 * middlewares set (`session`, `organizationId`, `permissions`, `role`,
 * `elevations`, `apiKey`, `costVisibility`) in one value. Whichever credential
 * authenticated (session cookie, WorkOS bearer, `iwk_` key, agent token), it
 * leaves this in the identical shape, so a permission gate means the same
 * thing for each.
 */
import { Context, Effect } from "effect";
import type { ActiveElevation, ResolvedRole } from "@infrawrench/server-core/permissions";
import { hasPermission } from "@infrawrench/server-core/permissions/catalog";
import type { CostVisibility } from "@infrawrench/server-core/cost/visibility-context";
import type { CostVisibilityPrincipal } from "@infrawrench/server-core/cost/visibility";
import type { AuthSession } from "../api/auth-middleware";
import { Forbidden } from "./errors";

/** The `iwk_` key or agent credential the request authenticated with, if any. */
export interface ApiKeyPrincipal {
  readonly id: string;
  readonly scopes: readonly string[];
  readonly agentRegistrationId?: string | undefined;
}

export interface OrgPrincipalValue {
  readonly session: AuthSession;
  readonly organizationId: string;
  readonly permissions: readonly string[];
  readonly role: ResolvedRole | null;
  readonly elevations: readonly ActiveElevation[];
  readonly apiKey: ApiKeyPrincipal | undefined;
  readonly costVisibility: CostVisibility;
}

export class OrgPrincipal extends Context.Service<OrgPrincipal, OrgPrincipalValue>()(
  "infrawrench/http/OrgPrincipal",
) {}

/** The user-scoped surface (`/api/profile`, `/api/orgs`, ...): a person, no org. */
export class SessionPrincipal extends Context.Service<SessionPrincipal, AuthSession>()(
  "infrawrench/http/SessionPrincipal",
) {}

/** The 403 `requirePermission` has always answered with. */
export const missingPermission = (permission: string) =>
  new Forbidden({ error: `Missing permission: ${permission}` });

/** Fail with 403 unless the org-tree caller holds `permission`. */
export const requirePermission = Effect.fnUntraced(function* (permission: string) {
  const principal = yield* OrgPrincipal;
  if (!hasPermission(principal.permissions, permission)) {
    return yield* missingPermission(permission);
  }
});

/** True when the caller holds `permission`; for handlers that branch rather than refuse. */
export const holdsPermission = Effect.fnUntraced(function* (permission: string) {
  const principal = yield* OrgPrincipal;
  return hasPermission(principal.permissions, permission);
});

/** True when the request's caller is cost-scoped. */
export const isCostScoped = Effect.gen(function* () {
  const principal = yield* OrgPrincipal;
  return principal.costVisibility.restricted === true;
});

/**
 * The value to store in an object's `visibility_user_id` when the caller
 * creates it: the caller when scoped, null (org-wide) otherwise.
 */
export const visibilityUserId = Effect.gen(function* () {
  const principal = yield* OrgPrincipal;
  return principal.costVisibility.restricted === true ? principal.session.userId : null;
});

/** The principal in the shape the cost visibility resolver takes. */
export function costVisibilityPrincipal(p: {
  readonly session: AuthSession;
  readonly apiKey: ApiKeyPrincipal | undefined;
}): CostVisibilityPrincipal {
  return {
    userId: p.session.userId,
    apiKeyId: p.apiKey && !p.apiKey.agentRegistrationId ? p.apiKey.id : null,
    agentRegistrationId: p.apiKey?.agentRegistrationId ?? null,
  };
}
