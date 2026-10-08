/**
 * Just-in-time access for Google Cloud: a project IAM binding with a
 * time-bound IAM Condition, so the expiry is enforced by Google as well as by
 * the host's revoke.
 *
 * Each grant is its own conditional binding, `{role, members: [principal],
 * condition: {title: "iw-jit-<grant>", expression: request.time < ...}}`.
 * Because a binding is keyed by (role, condition), ours is always distinct
 * from any unconditional binding the principal already has for the same role:
 * revoking removes the binding titled with our grant id and nothing else, so
 * standing access can never be taken away by an expiry. Extending rewrites the
 * expression of that same binding.
 *
 * **Wire shapes verified against live Google Cloud documentation, October 2026:**
 * - `POST https://cloudresourcemanager.googleapis.com/v3/projects/{project}:getIamPolicy`
 *   with `{options: {requestedPolicyVersion: 3}}`; conditions are only
 *   returned (and only preserved on write) at version 3.
 * - `POST .../v3/projects/{project}:setIamPolicy` with `{policy, updateMask}`;
 *   the policy's `etag` makes the write a compare-and-swap, answered with 409
 *   (`ABORTED`) when somebody else wrote first, so the read-modify-write is
 *   retried.
 * - IAM Conditions cannot be attached to the basic roles (`roles/owner`,
 *   `roles/editor`, `roles/viewer`), so those are left out of the picker
 *   rather than offered and refused at approval time.
 * - Google advises at most 100 conditional bindings per policy, which bounds
 *   how many grants can be live in one project at once.
 * - Roles: `GET https://iam.googleapis.com/v1/roles` (predefined) and
 *   `GET https://iam.googleapis.com/v1/projects/{project}/roles` (custom).
 * - Projects: `GET https://cloudresourcemanager.googleapis.com/v1/projects`.
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

export const GCP_JIT_ACCESS: JitAccessDeclaration = {
  scopeLabel: "Project",
  roleLabel: "Role",
  principalLabel: "Google account",
  description:
    "Adds a project IAM binding with a time-bound IAM Condition, so Google ends the access on " +
    "time even if nothing else runs, and removes the binding when the window ends. The service " +
    "account needs resourcemanager.projects.getIamPolicy and setIamPolicy on the project.",
  providerEnforcedExpiry: true,
  principalPicker: true,
};

/** Roles IAM Conditions cannot be attached to. */
const BASIC_ROLES = new Set(["roles/owner", "roles/editor", "roles/viewer"]);
const PRIVILEGED_ROLE = /admin|owner|\.editor$/i;

export interface GcpJitContext {
  /** The project the key belongs to (or the override). */
  project: string;
  get<T>(url: string): Promise<T>;
  paginate<T>(baseUrl: string, key: string, params?: Record<string, string>): Promise<T[]>;
  /** Authenticated JSON POST; throws an error carrying `status` on non-2xx. */
  post<T>(url: string, body: unknown): Promise<T>;
}

interface IamBinding {
  role: string;
  members?: string[];
  condition?: { title?: string; description?: string; expression?: string };
}

interface IamPolicy {
  version?: number;
  etag?: string;
  bindings?: IamBinding[];
  [key: string]: unknown;
}

function crm(project: string, op: "getIamPolicy" | "setIamPolicy"): string {
  return `https://cloudresourcemanager.googleapis.com/v3/projects/${encodeURIComponent(project)}:${op}`;
}

/** CEL timestamp literal: RFC 3339, whole seconds. */
export function expiryExpression(expiresAt: Date): string {
  const iso = expiresAt.toISOString().replace(/\.\d{3}Z$/, "Z");
  return `request.time < timestamp("${iso}")`;
}

function memberFor(principal: JitPrincipal): string {
  if (/^(user|group|serviceAccount|domain):/.test(principal.id)) return principal.id;
  return `${principal.kind === "group" ? "group" : "user"}:${principal.id}`;
}

export async function listGcpJitScopes(ctx: GcpJitContext): Promise<JitScope[]> {
  try {
    const projects = await ctx.paginate<{
      projectId?: string;
      name?: string;
      projectNumber?: string;
      lifecycleState?: string;
    }>("https://cloudresourcemanager.googleapis.com/v1/projects", "projects", {
      filter: "lifecycleState:ACTIVE",
    });
    const scopes = projects
      .filter((p) => p.projectId)
      .map((p) => ({
        id: p.projectId!,
        name: p.name || p.projectId!,
        description: p.projectNumber ? `${p.projectId} (${p.projectNumber})` : p.projectId!,
      }));
    if (!scopes.some((s) => s.id === ctx.project)) {
      scopes.push({ id: ctx.project, name: ctx.project, description: ctx.project });
    }
    return scopes.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    // A key scoped to one project often cannot list projects at all; that
    // project is still a valid target.
    return [{ id: ctx.project, name: ctx.project, description: ctx.project }];
  }
}

interface GcpRole {
  name?: string;
  title?: string;
  description?: string;
  stage?: string;
  deleted?: boolean;
}

let predefinedRoles: { at: number; roles: Promise<GcpRole[]> } | null = null;

export async function listGcpJitRoles(ctx: GcpJitContext, scopeId: string): Promise<JitRole[]> {
  // The predefined catalog is ~2,000 roles and the same for everyone; fetch
  // it once an hour per process rather than per picker open.
  if (!predefinedRoles || Date.now() - predefinedRoles.at > 3_600_000) {
    const roles = ctx.paginate<GcpRole>("https://iam.googleapis.com/v1/roles", "roles", {
      pageSize: "1000",
    });
    predefinedRoles = { at: Date.now(), roles };
    roles.catch(() => {
      predefinedRoles = null;
    });
  }
  const [predefined, custom] = await Promise.all([
    predefinedRoles.roles,
    ctx
      .paginate<GcpRole>(
        `https://iam.googleapis.com/v1/projects/${encodeURIComponent(scopeId)}/roles`,
        "roles",
        { pageSize: "1000" },
      )
      .catch(() => [] as GcpRole[]),
  ]);
  const out: JitRole[] = [];
  for (const r of [...custom, ...predefined]) {
    if (!r.name || r.deleted || r.stage === "DISABLED") continue;
    if (BASIC_ROLES.has(r.name)) continue;
    out.push({
      id: r.name,
      name: r.title || r.name,
      description: r.description ? `${r.name}: ${r.description}` : r.name,
      privileged: PRIVILEGED_ROLE.test(r.name),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function resolveGcpJitPrincipal(
  _ctx: GcpJitContext,
  identity: JitIdentity,
): Promise<JitPrincipal | null> {
  const email = identity.email.trim().toLowerCase();
  if (!email) return null;
  // Google identities are the email address itself; there is no directory
  // lookup to do, and IAM rejects a member that is not a real account at
  // write time, which is the honest place for that error.
  return { id: `user:${email}`, name: identity.name || email, kind: "user", email };
}

async function getPolicy(ctx: GcpJitContext, project: string): Promise<IamPolicy> {
  return ctx.post<IamPolicy>(crm(project, "getIamPolicy"), {
    options: { requestedPolicyVersion: 3 },
  });
}

export async function listGcpJitPrincipals(
  ctx: GcpJitContext,
  query?: string,
): Promise<JitPrincipal[]> {
  const policy = await getPolicy(ctx, ctx.project);
  const needle = query?.trim().toLowerCase() ?? "";
  const seen = new Map<string, JitPrincipal>();
  for (const b of policy.bindings ?? []) {
    for (const m of b.members ?? []) {
      const match = /^(user|group):(.+)$/.exec(m);
      if (!match) continue;
      if (needle && !match[2]!.toLowerCase().includes(needle)) continue;
      seen.set(m, {
        id: m,
        name: match[2]!,
        kind: match[1] === "group" ? "group" : "user",
        email: match[2]!,
      });
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function isOurs(binding: IamBinding, spec: JitGrantSpec, title: string): boolean {
  return binding.role === spec.roleId && binding.condition?.title === title;
}

function errorStatus(err: unknown): number | null {
  const s = (err as { status?: unknown } | null)?.status;
  return typeof s === "number" ? s : null;
}

/**
 * Read, modify and compare-and-swap the policy, retrying when another writer
 * changed it in between. `mutate` returns false when there is nothing to
 * write, which ends the loop without a setIamPolicy call.
 */
async function updatePolicy(
  ctx: GcpJitContext,
  project: string,
  mutate: (policy: IamPolicy) => boolean,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const policy = await getPolicy(ctx, project);
    if (!mutate(policy)) return;
    // Conditional bindings require version 3; writing a lower version would
    // be refused, and writing 3 over a policy without conditions is harmless.
    policy.version = 3;
    try {
      await ctx.post(crm(project, "setIamPolicy"), { policy, updateMask: "bindings,etag" });
      return;
    } catch (err) {
      if (errorStatus(err) === 409 && attempt < 4) continue;
      throw err;
    }
  }
}

export async function grantGcpJitAccess(
  ctx: GcpJitContext,
  spec: JitGrantSpec,
): Promise<JitGrantResult> {
  if (BASIC_ROLES.has(spec.roleId)) {
    throw new Error(
      `${spec.roleId} is a basic role, and Google Cloud does not allow IAM Conditions on basic ` +
        "roles. Pick a predefined or custom role instead.",
    );
  }
  const title = jitGrantName(spec.grantId);
  const member = memberFor(spec.principal);
  const expression = expiryExpression(spec.expiresAt);
  await updatePolicy(ctx, spec.scopeId, (policy) => {
    const bindings = (policy.bindings ??= []);
    const existing = bindings.find((b) => isOurs(b, spec, title));
    if (existing) {
      // A retry, or an extension: make the binding say exactly this.
      const members = existing.members ?? [];
      const unchanged = members.includes(member) && existing.condition?.expression === expression;
      if (unchanged) return false;
      existing.members = members.includes(member) ? members : [...members, member];
      existing.condition = { ...existing.condition, title, expression };
      return true;
    }
    bindings.push({
      role: spec.roleId,
      members: [member],
      condition: {
        title,
        description:
          `Infrawrench just-in-time access${spec.reason ? `: ${spec.reason}` : ""}`.slice(0, 256),
        expression,
      },
    });
    return true;
  });
  return {
    ref: title,
    url: `https://console.cloud.google.com/iam-admin/iam?project=${encodeURIComponent(spec.scopeId)}`,
  };
}

export async function revokeGcpJitAccess(ctx: GcpJitContext, spec: JitGrantSpec): Promise<void> {
  const title = jitGrantName(spec.grantId);
  await updatePolicy(ctx, spec.scopeId, (policy) => {
    const before = policy.bindings?.length ?? 0;
    policy.bindings = (policy.bindings ?? []).filter((b) => !isOurs(b, spec, title));
    return policy.bindings.length !== before;
  });
}

export async function checkGcpJitAccess(
  ctx: GcpJitContext,
  spec: JitGrantSpec,
): Promise<JitAccessPresence> {
  const title = jitGrantName(spec.grantId);
  const policy = await getPolicy(ctx, spec.scopeId);
  return (policy.bindings ?? []).some((b) => isOurs(b, spec, title)) ? "present" : "absent";
}
