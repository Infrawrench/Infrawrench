/**
 * Principals — the identities that live *inside the customer's clouds*.
 *
 * This is the declarative half of the cross-cloud access review: IAM users and
 * roles, GCP service accounts, Azure app registrations and managed identities,
 * directory users and groups, role/membership bindings, and the long-lived API
 * keys providers hand out. A type that declares `principalRole` says "instances
 * of me are somebody's standing access", and names the already-synced fields
 * that answer the review's questions.
 *
 * Three adjacent things are deliberately *not* this:
 *
 * - **Infrawrench's own team roles and permissions** (`permissions/catalog`) —
 *   who can use Infrawrench.
 * - **The credentials Infrawrench itself holds** (credential hygiene) — the
 *   org's API keys, SSH keys and members' unused permissions.
 * - **Posture checks** — per-resource exposure rules over any resource type.
 *
 * Same contract as `orphanRule`, `expiryFields`, `dnsRole`, `lifecycle` and
 * `postureChecks`: evaluated over already-synced `fields`, **never an extra
 * provider API call, ever**. Only declare a key the type's lister genuinely
 * populates. A type whose lister would need a second API call to know when a
 * principal was last used must simply not declare `lastUsedKey` — the review
 * then reports that principal's last use as *unknown*, which it renders as
 * such and never as "stale". Missing data must not accuse anybody.
 */

/**
 * What kind of identity this type is. Drives grouping and labels on the access
 * review; it is not a permission model.
 *
 * - `"user"` — a human sign-in identity (an IAM user, a directory user).
 * - `"group"` — a collection of users that grants through membership.
 * - `"role"` — an assumable/assignable set of permissions.
 * - `"service-account"` — a non-human workload identity.
 * - `"key"` — a long-lived credential (API key, database password, token).
 * - `"binding"` — the link that grants a principal a role somewhere.
 */
export type PrincipalRole = "user" | "group" | "role" | "service-account" | "key" | "binding";

/**
 * Marks a resource type as a principal inside the customer's cloud and names
 * the fields the access review reads.
 *
 * Every key defaults to the name most providers in this repo already use, so a
 * type whose lister stores `lastUsedAt`/`createdAt` needs only `{ role: "key" }`.
 * A defaulted key that the type does not declare is not an error — it just
 * means the review has no evidence for that question, which is a first-class
 * answer here.
 */
export interface PrincipalRoleDeclaration {
  /** What kind of identity instances of this type are. */
  role: PrincipalRole;
  /**
   * Field holding the last time this principal was actually used — a console
   * sign-in, a key's last request. Default `"lastUsedAt"`.
   *
   * **Only declare it when the lister already syncs it.** An absent or
   * unparseable value makes the principal's activity `unknown`; it never makes
   * it stale.
   */
  lastUsedKey?: string;
  /**
   * Field holding when the principal was created. Default `"createdAt"`. Used
   * to report a principal's age, and to say "created N days ago, never seen
   * used" without ever calling that stale.
   */
  createdKey?: string;
  /**
   * Field whose value says the principal holds administrative or wildcard
   * permissions — an attached policy name, a role slug, a permission list.
   * Without `adminValues` the field is read as a boolean (the `dnsRole`
   * `privateKey` convention: truthiness is the test).
   */
  adminIndicatorKey?: string;
  /**
   * Values of `adminIndicatorKey` (case-insensitive, compared against the
   * whole stored value) that mean administrative. Omit for a boolean field.
   */
  adminValues?: string[];
  /**
   * Field naming the principal this one hangs off — the user an access key
   * belongs to, the identity a binding grants to. Display only: the review
   * shows it beside the row so a reviewer can tell whose key this is without
   * opening it.
   */
  parentKey?: string;
  /**
   * Field that is truthy when the principal has multi-factor authentication
   * enrolled. Only meaningful on `role: "user"` — a key or a binding cannot
   * carry MFA, so declaring it elsewhere fails the manifest as dead config.
   *
   * A principal on a type that declares no `mfaKey` is never reported as
   * missing MFA: "we do not sync that" and "MFA is off" are different claims.
   */
  mfaKey?: string;
  /**
   * `actionId` of an existing `"plugin-action"` this type's `invokeAction`
   * accepts that **revokes** the principal — deactivate the membership,
   * deactivate the key. The review's Revoke button dispatches it through the
   * ordinary invoke-action path; there is deliberately no bespoke provider
   * call anywhere in this feature.
   *
   * Only name an action the plugin's `renderDetail` already offers for this
   * type, and only one that revokes rather than deletes: a review is a place
   * to withdraw access, not to destroy records an auditor may still need.
   */
  revokeActionId?: string;
}

/** Field key used for `lastUsedKey` when a declaration omits it. */
export const DEFAULT_PRINCIPAL_LAST_USED_KEY = "lastUsedAt";
/** Field key used for `createdKey` when a declaration omits it. */
export const DEFAULT_PRINCIPAL_CREATED_KEY = "createdAt";

/**
 * The declaration with its defaults applied — the one place the default key
 * names live, so the host, the registry test and any future surface can never
 * disagree about which field a bare `{ role: "key" }` reads.
 */
export interface ResolvedPrincipalKeys {
  role: PrincipalRole;
  lastUsedKey: string;
  createdKey: string;
  adminIndicatorKey: string | null;
  adminValues: readonly string[] | null;
  parentKey: string | null;
  mfaKey: string | null;
  revokeActionId: string | null;
}

/** Apply the documented defaults to a `PrincipalRoleDeclaration`. */
export function resolvePrincipalKeys(declaration: PrincipalRoleDeclaration): ResolvedPrincipalKeys {
  return {
    role: declaration.role,
    lastUsedKey: declaration.lastUsedKey ?? DEFAULT_PRINCIPAL_LAST_USED_KEY,
    createdKey: declaration.createdKey ?? DEFAULT_PRINCIPAL_CREATED_KEY,
    adminIndicatorKey: declaration.adminIndicatorKey ?? null,
    adminValues: declaration.adminValues ?? null,
    parentKey: declaration.parentKey ?? null,
    mfaKey: declaration.mfaKey ?? null,
    revokeActionId: declaration.revokeActionId ?? null,
  };
}
