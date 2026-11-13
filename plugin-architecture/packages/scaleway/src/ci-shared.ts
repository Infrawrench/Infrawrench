/**
 * What Scaleway's CI executors share: the REST surface they call, the
 * key's project, and what IAM says the key may do.
 */
import type { CiMissingPermission } from "@infrawrench/plugin-base";

import type { ScwRest } from "./products.js";

/** What the CI executors need: the REST surface, the access key (for IAM) and a waiter. */
export interface ScwCiContext {
  rest: ScwRest;
  accessKey: string;
  /** Waits between polls while a server goes; a test passes one that does not. */
  sleep?(ms: number): Promise<void>;
}

const FULL = "AllProductsFullAccess";

/** The key's project: the connection's default, else the key's own. */
export async function projectOf(ctx: ScwCiContext): Promise<string> {
  if (ctx.rest.projectId) return ctx.rest.projectId;
  const key = await ctx.rest.fetch<{ default_project_id?: string }>(
    `/iam/v1alpha1/api-keys/${encodeURIComponent(ctx.accessKey)}`,
  );
  if (!key.default_project_id) {
    throw new Error(
      "Set the connection's Default Project ID: the key names no project of its own.",
    );
  }
  return key.default_project_id;
}

/**
 * The permission sets the key's application holds, or null when IAM will
 * not say (no `IAMReadOnly`, or a user's key, whose groups and ownership
 * also count).
 */
export async function grantedSets(ctx: ScwCiContext): Promise<Set<string> | null> {
  try {
    const key = await ctx.rest.fetch<{ application_id?: string }>(
      `/iam/v1alpha1/api-keys/${encodeURIComponent(ctx.accessKey)}`,
    );
    const app = key.application_id;
    if (!app) return null;
    const sets = new Set<string>();
    const { policies } = await ctx.rest.fetch<{ policies?: Array<{ id?: string }> }>(
      `/iam/v1alpha1/policies?application_ids=${encodeURIComponent(app)}&page_size=100`,
    );
    const { groups } = await ctx.rest.fetch<{ groups?: Array<{ id?: string }> }>(
      `/iam/v1alpha1/groups?application_ids=${encodeURIComponent(app)}&page_size=100`,
    );
    const groupPolicies = await Promise.all(
      (groups ?? []).flatMap((g) =>
        g.id
          ? [
              ctx.rest.fetch<{ policies?: Array<{ id?: string }> }>(
                `/iam/v1alpha1/policies?group_ids=${encodeURIComponent(g.id)}&page_size=100`,
              ),
            ]
          : [],
      ),
    );
    const all = [...(policies ?? []), ...groupPolicies.flatMap((p) => p.policies ?? [])];
    for (const policy of all) {
      if (!policy.id) continue;
      const { rules } = await ctx.rest.fetch<{
        rules?: Array<{ permission_set_names?: string[] }>;
      }>(`/iam/v1alpha1/rules?policy_id=${encodeURIComponent(policy.id)}&page_size=100`);
      for (const rule of rules ?? [])
        for (const name of rule.permission_set_names ?? []) sets.add(name);
    }
    return sets;
  } catch {
    return null;
  }
}

/** Which of `needed` the sets lack; a `*FullAccess` set covers its product's finer ones. */
export function lacking(
  sets: ReadonlySet<string> | null,
  needed: readonly CiMissingPermission[],
): CiMissingPermission[] {
  if (!sets || sets.has(FULL)) return [];
  return needed.filter((p) => !sets.has(p.permission));
}
