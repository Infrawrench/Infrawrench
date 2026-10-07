/**
 * Just-in-time access for Kubernetes: one RoleBinding (or ClusterRoleBinding,
 * for the whole cluster) per grant, named after the grant, deleted when the
 * window ends.
 *
 * RBAC (`rbac.authorization.k8s.io/v1`, stable since 1.8):
 * - `POST /apis/rbac.authorization.k8s.io/v1/namespaces/{ns}/rolebindings`
 *   and `POST .../v1/clusterrolebindings` create; a name that already exists
 *   answers 409 AlreadyExists, which a retried grant treats as its own work.
 * - `DELETE .../rolebindings/{name}` / `.../clusterrolebindings/{name}`; 404
 *   on a binding that is already gone is a successful revoke.
 * - A RoleBinding may reference a `Role` in its namespace or any
 *   `ClusterRole` (granting that ClusterRole's rules within the namespace);
 *   a ClusterRoleBinding may only reference a `ClusterRole`.
 * - Subjects are `{kind: "User" | "Group", apiGroup: "rbac.authorization.k8s.io", name}`.
 *
 * Kubernetes has no user directory: a "user" is whatever name the cluster's
 * authenticator puts on a request (an OIDC email claim on most managed
 * clusters, an IAM ARN mapped through an access entry on EKS). The member's
 * email is the default and the subjects already named in the cluster's
 * bindings are offered as the picker, so a cluster whose users are not emails
 * still works without anybody typing a name.
 *
 * Grants are uniquely named, so a revoke can only ever delete what a grant
 * created; standing access granted by any other binding is never touched.
 * Bindings carry `app.kubernetes.io/managed-by: infrawrench` and the expiry
 * as an annotation, so somebody reading the cluster with `kubectl` can see
 * what they are and when they lapse.
 */

import {
  jitGrantName,
  type JitAccessDeclaration,
  type JitAccessPresence,
  type JitGrantResult,
  type JitGrantSpec,
  type JitIdentity,
  type JitPrincipal,
  type JitRole,
  type JitScope,
} from "@infrawrench/plugin-base";

export const KUBERNETES_JIT_ACCESS: JitAccessDeclaration = {
  scopeLabel: "Namespace",
  roleLabel: "Role",
  principalLabel: "Kubernetes user",
  description:
    "Creates a RoleBinding in the namespace (or a ClusterRoleBinding for the whole cluster) for " +
    "the user, and deletes it when the window ends. The kubeconfig needs permission to create " +
    "and delete RoleBindings and ClusterRoleBindings, and to bind the roles offered.",
  providerEnforcedExpiry: false,
  principalPicker: true,
};

/** The scope id for a ClusterRoleBinding. Not a valid namespace name, so it cannot collide. */
export const CLUSTER_SCOPE = "*cluster*";

const RBAC = "/apis/rbac.authorization.k8s.io/v1";
const RBAC_GROUP = "rbac.authorization.k8s.io";
const PRIVILEGED_ROLES = new Set(["cluster-admin", "admin"]);

export interface K8sJitContext {
  fetch<T>(path: string, options?: RequestInit): Promise<T>;
}

interface K8sList<T> {
  items?: T[];
}

interface K8sRoleLike {
  metadata?: { name?: string; namespace?: string; labels?: Record<string, string> };
}

interface K8sSubject {
  kind?: string;
  name?: string;
  apiGroup?: string;
}

interface K8sBinding {
  metadata?: { name?: string; namespace?: string };
  subjects?: K8sSubject[];
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function hasStatus(err: unknown, status: number): boolean {
  const s = (err as { status?: unknown; statusCode?: unknown } | null) ?? null;
  if (s && (s.status === status || s.statusCode === status)) return true;
  return new RegExp(`\\b${status}\\b`).test(errorText(err));
}

export async function listK8sJitScopes(ctx: K8sJitContext): Promise<JitScope[]> {
  const namespaces = await ctx.fetch<K8sList<K8sRoleLike>>("/api/v1/namespaces");
  const scopes: JitScope[] = (namespaces.items ?? [])
    .map((n) => n.metadata?.name)
    .filter((n): n is string => Boolean(n))
    .sort()
    .map((name) => ({ id: name, name }));
  return [
    {
      id: CLUSTER_SCOPE,
      name: "Whole cluster",
      description: "A ClusterRoleBinding: the role applies in every namespace",
    },
    ...scopes,
  ];
}

/** Role ids carry their kind, since a namespace offers both Roles and ClusterRoles. */
export function parseRoleId(roleId: string): { kind: "Role" | "ClusterRole"; name: string } {
  const idx = roleId.indexOf(":");
  const kind = roleId.slice(0, idx);
  const name = roleId.slice(idx + 1);
  if (idx < 1 || !name || (kind !== "Role" && kind !== "ClusterRole")) {
    throw new Error(`Not a Kubernetes role reference: ${roleId}`);
  }
  return { kind, name };
}

/**
 * ClusterRoles worth offering: the user-facing ones. The `system:` roles are
 * the control plane's own (kube-scheduler, node bootstrap), and binding a
 * person to one is never what a just-in-time request means.
 */
function isOfferedClusterRole(role: K8sRoleLike): boolean {
  const name = role.metadata?.name ?? "";
  return Boolean(name) && !name.startsWith("system:");
}

export async function listK8sJitRoles(ctx: K8sJitContext, scopeId: string): Promise<JitRole[]> {
  const clusterRoles = await ctx.fetch<K8sList<K8sRoleLike>>(`${RBAC}/clusterroles`);
  const roles: JitRole[] = (clusterRoles.items ?? []).filter(isOfferedClusterRole).map((r) => {
    const name = r.metadata!.name!;
    return {
      id: `ClusterRole:${name}`,
      name,
      description: "ClusterRole",
      privileged: PRIVILEGED_ROLES.has(name),
    };
  });
  if (scopeId !== CLUSTER_SCOPE) {
    const local = await ctx.fetch<K8sList<K8sRoleLike>>(
      `${RBAC}/namespaces/${encodeURIComponent(scopeId)}/roles`,
    );
    for (const r of local.items ?? []) {
      const name = r.metadata?.name;
      if (!name) continue;
      roles.push({ id: `Role:${name}`, name, description: `Role in ${scopeId}` });
    }
  }
  return roles.sort((a, b) => a.name.localeCompare(b.name));
}

export async function resolveK8sJitPrincipal(
  _ctx: K8sJitContext,
  identity: JitIdentity,
): Promise<JitPrincipal | null> {
  const email = identity.email.trim();
  if (!email) return null;
  return { id: email, name: identity.name || email, kind: "user", email };
}

export async function listK8sJitPrincipals(
  ctx: K8sJitContext,
  query?: string,
): Promise<JitPrincipal[]> {
  const [roleBindings, clusterRoleBindings] = await Promise.all([
    ctx.fetch<K8sList<K8sBinding>>(`${RBAC}/rolebindings`),
    ctx.fetch<K8sList<K8sBinding>>(`${RBAC}/clusterrolebindings`),
  ]);
  const needle = query?.trim().toLowerCase() ?? "";
  const seen = new Map<string, JitPrincipal>();
  for (const b of [...(roleBindings.items ?? []), ...(clusterRoleBindings.items ?? [])]) {
    for (const s of b.subjects ?? []) {
      if ((s.kind !== "User" && s.kind !== "Group") || !s.name) continue;
      if (s.name.startsWith("system:")) continue;
      if (needle && !s.name.toLowerCase().includes(needle)) continue;
      const kind = s.kind === "Group" ? "group" : "user";
      seen.set(`${kind}:${s.name}`, {
        id: s.name,
        name: s.name,
        kind,
        email: s.name.includes("@") ? s.name : null,
      });
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function bindingPath(spec: JitGrantSpec, name?: string): string {
  const tail = name ? `/${encodeURIComponent(name)}` : "";
  return spec.scopeId === CLUSTER_SCOPE
    ? `${RBAC}/clusterrolebindings${tail}`
    : `${RBAC}/namespaces/${encodeURIComponent(spec.scopeId)}/rolebindings${tail}`;
}

export function buildJitBinding(spec: JitGrantSpec): Record<string, unknown> {
  const role = parseRoleId(spec.roleId);
  const cluster = spec.scopeId === CLUSTER_SCOPE;
  if (cluster && role.kind === "Role") {
    throw new Error("A namespaced Role cannot be granted across the whole cluster.");
  }
  const name = jitGrantName(spec.grantId);
  return {
    apiVersion: `${RBAC_GROUP}/v1`,
    kind: cluster ? "ClusterRoleBinding" : "RoleBinding",
    metadata: {
      name,
      ...(cluster ? {} : { namespace: spec.scopeId }),
      labels: {
        "app.kubernetes.io/managed-by": "infrawrench",
        "infrawrench.com/jit-grant": name,
      },
      annotations: {
        "infrawrench.com/jit-expires-at": spec.expiresAt.toISOString(),
        ...(spec.reason ? { "infrawrench.com/jit-reason": spec.reason.slice(0, 500) } : {}),
      },
    },
    roleRef: { apiGroup: RBAC_GROUP, kind: role.kind, name: role.name },
    subjects: [
      {
        kind: spec.principal.kind === "group" ? "Group" : "User",
        apiGroup: RBAC_GROUP,
        name: spec.principal.id,
      },
    ],
  };
}

export async function grantK8sJitAccess(
  ctx: K8sJitContext,
  spec: JitGrantSpec,
): Promise<JitGrantResult> {
  const body = buildJitBinding(spec);
  const name = jitGrantName(spec.grantId);
  try {
    await ctx.fetch(bindingPath(spec), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // A retry after the first create landed: the binding is ours by name.
    // An extension also arrives here; the expiry annotation is informational
    // (the host's sweep is what ends access), so it is refreshed best-effort.
    if (!hasStatus(err, 409)) throw err;
    await ctx
      .fetch(bindingPath(spec, name), {
        method: "PATCH",
        headers: { "Content-Type": "application/merge-patch+json" },
        body: JSON.stringify({
          metadata: {
            annotations: { "infrawrench.com/jit-expires-at": spec.expiresAt.toISOString() },
          },
        }),
      })
      .catch(() => undefined);
  }
  return { ref: name };
}

export async function revokeK8sJitAccess(ctx: K8sJitContext, spec: JitGrantSpec): Promise<void> {
  try {
    await ctx.fetch(bindingPath(spec, jitGrantName(spec.grantId)), { method: "DELETE" });
  } catch (err) {
    if (hasStatus(err, 404)) return;
    throw err;
  }
}

export async function checkK8sJitAccess(
  ctx: K8sJitContext,
  spec: JitGrantSpec,
): Promise<JitAccessPresence> {
  try {
    await ctx.fetch(bindingPath(spec, jitGrantName(spec.grantId)));
    return "present";
  } catch (err) {
    if (hasStatus(err, 404)) return "absent";
    throw err;
  }
}
