import type { Api, ProjectListItem } from "@neondatabase/api-client";

/** A project/branch pair — the scope every beta service is keyed by. */
export interface BranchRef {
  projectId: string;
  branchId: string;
}

/**
 * Neon's branch-scoped services (Object Storage, Functions, AI Gateway) are in
 * Private Beta behind a per-org entitlement flag and are limited to a subset of
 * regions. A branch without the entitlement answers 404 rather than an empty
 * list, so callers treat these statuses as "service not available here" and move
 * on instead of failing the whole listing.
 */
export function isServiceUnavailable(err: unknown): boolean {
  const status = (err as { response?: { status?: number } })?.response?.status;
  return status === 403 || status === 404 || status === 501;
}

/** Enumerate every branch across the given projects, skipping unreadable projects. */
export async function enumerateBranches(
  api: Api<unknown>,
  projects: ProjectListItem[],
): Promise<BranchRef[]> {
  const refs: BranchRef[] = [];
  for (const p of projects) {
    try {
      const resp = await api.listProjectBranches({ projectId: p.id });
      for (const b of resp.data.branches) {
        refs.push({ projectId: p.id, branchId: b.id });
      }
    } catch {
      /* skip projects whose branches we can't read */
    }
  }
  return refs;
}

/** `{accountId}:{typeId}:{externalId}` — the plugin-wide resource id convention. */
export function resourceId(accountId: string, typeId: string, externalId: string): string {
  return `${accountId}:${typeId}:${externalId}`;
}

/** Split a resource id back into its externalId, which may itself contain colons. */
export function externalIdOf(resourceIdValue: string): string {
  return resourceIdValue.split(":").slice(2).join(":");
}

/** Parse a `{projectId}/{branchId}` external id, tolerating extra trailing segments. */
export function parseBranchExternalId(externalId: string): BranchRef {
  const [projectId = "", branchId = ""] = externalId.split("/");
  return { projectId, branchId };
}
