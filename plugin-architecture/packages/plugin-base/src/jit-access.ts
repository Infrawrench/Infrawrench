/**
 * Just-in-time access: a plugin whose provider can hand a person a role for a
 * bounded window declares `manifest.jitAccess` and implements the optional
 * `PluginClient` methods below. The host owns policies, requests, approvals,
 * the audit trail and the expiry sweep; the plugin owns every provider-shaped
 * fact (what a permission set, an IAM binding or a RoleBinding is, and how a
 * person is named inside the provider). Nothing in the host knows any of it.
 *
 * The vocabulary, in provider-neutral terms:
 *
 * - A **scope** is where a role applies: an AWS account in an IAM Identity
 *   Center organization, a GCP project, a Kubernetes namespace (or the whole
 *   cluster). {@link PluginClient.listJitScopes} is the picker.
 * - A **role** is what is granted inside a scope: a permission set, an IAM
 *   role, a ClusterRole. {@link PluginClient.listJitRoles} is the picker, so
 *   nobody ever types an ARN or a role id.
 * - A **principal** is who receives it, named the way the provider names
 *   people. {@link PluginClient.resolveJitPrincipal} maps a host member (by
 *   email) to one; {@link PluginClient.listJitPrincipals} is the fallback
 *   picker for providers where the member's name there differs.
 *
 * Grant and revoke are **idempotent and keyed by the host's grant id**, which
 * is the property the whole safety story rests on. The host may call
 * `grantJitAccess` twice for one grant (a retry after a crash between the
 * provider call and the database write) and `revokeJitAccess` any number of
 * times, including for a grant whose `grantJitAccess` never finished or whose
 * returned `ref` was never stored. A plugin therefore names what it creates
 * deterministically from `grantId` (a binding name, a condition title) or
 * checks for an existing assignment before creating one, and treats "already
 * gone" as a successful revoke.
 *
 * Standing access is never touched. If the principal already holds the role
 * by some other means, `checkJitAccess` says so before anything is granted
 * and the host records the request as `preexisting`: nothing is created and
 * nothing is removed at expiry. A plugin whose grant cannot be told apart from
 * standing access (an assignment is a tuple with no name) must implement the
 * check; one whose grants are uniquely named (a RoleBinding, a conditional
 * IAM binding) may report `absent` because its revoke can only ever remove
 * what it created.
 */

/** What the host shows for this provider's half of a policy and a request. */
export interface JitAccessDeclaration {
  /** What one scope is called here, e.g. "AWS account", "Project", "Namespace". */
  scopeLabel: string;
  /** What one role is called here, e.g. "Permission set", "Role". */
  roleLabel: string;
  /** What a principal is called here, e.g. "Identity Center user". */
  principalLabel: string;
  /** One line under the pickers: what a grant actually does on this provider. */
  description?: string;
  /**
   * True when the provider enforces the expiry itself (a time-bound IAM
   * Condition), so access ends on time even if the host's revoke never runs.
   * The host still revokes; this only changes what the UI promises.
   */
  providerEnforcedExpiry: boolean;
  /**
   * True when `listJitPrincipals` is implemented and a requester may pick a
   * principal other than the one resolved from their email. Approvers are
   * always shown when a request names a principal that was not resolved from
   * the requester's own address.
   */
  principalPicker: boolean;
}

/** One place a role can be granted. */
export interface JitScope {
  id: string;
  name: string;
  /** Free text beside the name (an account id, a project number). */
  description?: string;
}

/** One grantable role inside a scope. */
export interface JitRole {
  id: string;
  name: string;
  description?: string;
  /**
   * The provider's own administrative roles (Owner, cluster-admin,
   * AdministratorAccess). The host only uses it to label the picker.
   */
  privileged?: boolean;
}

/** Who receives a grant, as the provider names them. */
export interface JitPrincipal {
  /** The provider's identifier: an Identity Store user id, `user:a@b.c`, a username. */
  id: string;
  /** Human name for the picker and the approval card. */
  name: string;
  /** Provider-neutral kind; only `user` is resolved from an email. */
  kind: "user" | "group";
  /** The email the provider has for this principal, when it reports one. */
  email?: string | null;
}

/** The host member a principal is resolved for. */
export interface JitIdentity {
  email: string;
  name?: string | null;
}

/** Everything a grant or revoke call needs, all of it host-stored. */
export interface JitGrantSpec {
  /**
   * The host's id for this grant. Stable across retries; plugins derive the
   * names of whatever they create from it so a retry finds its own work.
   */
  grantId: string;
  scopeId: string;
  roleId: string;
  principal: JitPrincipal;
  /** When the grant must end. Providers that can enforce it do. */
  expiresAt: Date;
  /** The requester's stated reason, for providers with somewhere to put it. */
  reason?: string;
  /**
   * The value an earlier `grantJitAccess` returned, when the host stored it.
   * Never required: revoke must work from the other fields alone, because a
   * grant can succeed upstream and still fail to be recorded.
   */
  ref?: string | null;
}

export interface JitGrantResult {
  /** Opaque handle the host stores beside the grant (a binding name, a request id). */
  ref?: string | null;
  /** Link to the grant in the provider's own console, when there is one. */
  url?: string | null;
}

/**
 * Whether a grant's access exists upstream.
 *
 * `present` from {@link PluginClient.checkJitAccess} *before* a grant means
 * the principal already holds the role by other means. After a revoke it
 * means the revoke did not take, which the host raises loudly.
 */
export type JitAccessPresence = "present" | "absent" | "unknown";

/**
 * The deterministic name a plugin gives whatever it creates for one grant:
 * `iw-jit-` plus the grant id with its dashes removed, lowercased. Valid as a
 * Kubernetes object name (DNS-1123), an IAM Condition title, and a label
 * value, and recognisable in the provider's own console as ours. Being a pure
 * function of the grant id is what makes a retried grant find its own work and
 * a revoke work without a stored ref.
 */
export function jitGrantName(grantId: string): string {
  const compact = grantId.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!compact) throw new Error("jitGrantName: empty grant id");
  return `iw-jit-${compact.slice(0, 48)}`;
}
