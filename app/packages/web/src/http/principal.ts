/**
 * Who is calling: the server's half of the principal services.
 *
 * `OrgPrincipal` and `SessionPrincipal` are the contract's
 * (`@infrawrench/api-contract`, `http/principal.ts`), since the middleware
 * tags endpoint definitions name provide them. The contract types the part of
 * the org-tree caller any reader can (`session`, `organizationId`,
 * `permissions`, `apiKey`); the fields typed by server-core are added here, by
 * augmenting its `OrgPrincipalValue`, so every handler's `yield* OrgPrincipal`
 * is fully typed while the contract never imports server code. This module is
 * imported by every handler that reads the principal, which keeps the
 * augmentation in each program that needs it.
 */
import { Effect } from "effect";
import {
  Forbidden,
  OrgPrincipal,
  type ApiKeyPrincipal,
  type SessionPrincipalValue,
} from "@infrawrench/api-contract";
import type { ActiveElevation, ResolvedRole } from "@infrawrench/server-core/permissions";
import { hasPermission } from "@infrawrench/server-core/permissions/catalog";
import type { CostVisibility } from "@infrawrench/server-core/cost/visibility-context";
import type { CostVisibilityPrincipal } from "@infrawrench/server-core/cost/visibility";

declare module "@infrawrench/api-contract" {
  /** What the auth chain resolves beside the contract's fields, typed by server-core. */
  interface OrgPrincipalValue {
    readonly role: ResolvedRole | null;
    readonly elevations: readonly ActiveElevation[];
    readonly costVisibility: CostVisibility;
  }
}

export {
  OrgPrincipal,
  SessionPrincipal,
  type ApiKeyPrincipal,
  type OrgPrincipalValue,
} from "@infrawrench/api-contract";

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
  readonly session: SessionPrincipalValue;
  readonly apiKey: ApiKeyPrincipal | undefined;
}): CostVisibilityPrincipal {
  return {
    userId: p.session.userId,
    apiKeyId: p.apiKey && !p.apiKey.agentRegistrationId ? p.apiKey.id : null,
    agentRegistrationId: p.apiKey?.agentRegistrationId ?? null,
  };
}
