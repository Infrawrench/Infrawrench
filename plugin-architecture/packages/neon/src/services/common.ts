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
  const response = readProp(err, "response");
  const status = readProp(response, "status");
  return status === 403 || status === 404 || status === 501;
}

/**
 * Read one property off a value of unknown provenance, without asserting
 * anything about the value's shape. Returns `undefined` for non-objects.
 *
 * The cast is a widening of an already-proven `object`, not an assertion about
 * its contents: every object satisfies `Record<string, unknown>` at runtime.
 */
function readProp(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

/**
 * Pull an array property off a raw SDK payload, keeping only the elements that
 * pass `isElement`.
 *
 * `@neondatabase/api-client@2.7.3` mistypes several of the beta-service
 * responses (see `functions.ts` and `snapshots.ts`), so those callers have to
 * look past the generated types. Validating the payload at runtime — rather
 * than asserting the documented shape and hoping — means SDK or API drift
 * degrades to a short listing instead of a `TypeError` inside a mapper.
 */
export function validatedArray<T>(
  payload: unknown,
  key: string,
  isElement: (value: unknown) => value is T,
): T[] {
  const value = readProp(payload, key);
  return Array.isArray(value) ? value.filter(isElement) : [];
}

/** Single-object counterpart to {@link validatedArray}. */
export function validatedObject<T>(
  payload: unknown,
  key: string,
  isValue: (value: unknown) => value is T,
): T | undefined {
  const value = readProp(payload, key);
  return isValue(value) ? value : undefined;
}

/** True when every listed key is present on `value` as a string. */
export function hasStringFields(value: unknown, keys: readonly string[]): boolean {
  if (typeof value !== "object" || value === null) return false;
  return keys.every((key) => typeof readProp(value, key) === "string");
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
