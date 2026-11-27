/**
 * Protected branches as the API applies them to what a person does from the
 * UI: creating or deleting a branch, merging into one. The rules themselves
 * are `db/policy-rules.ts`; the push hook reads the same ones.
 */
import { accessAtLeast, type RepoAccessLevel } from "@infrawrench/git-contract";
import { type BranchProtection, listProtectedBranches, protectionFor } from "../db/policy";

export const branchProtection = async (
  repositoryId: string,
  branch: string,
): Promise<BranchProtection | null> =>
  protectionFor(await listProtectedBranches(repositoryId), branch);

/** An administrator, on a rule that does not bind administrators. */
export const bypasses = (protection: BranchProtection, access: RepoAccessLevel): boolean =>
  accessAtLeast(access, "admin") && !protection.enforceAdmins;

/** Whether the person may push to (create, update, merge into) a protected branch. */
export const mayPush = (
  protection: BranchProtection | null,
  access: RepoAccessLevel,
  userId: string | null,
): boolean => {
  if (!protection || !protection.restrictPushers) return true;
  if (bypasses(protection, access)) return true;
  return userId !== null && protection.pusherUserIds.includes(userId);
};

/** Whether the person may delete a branch. */
export const mayDelete = (protection: BranchProtection | null, access: RepoAccessLevel): boolean =>
  !protection || protection.allowDeletion || bypasses(protection, access);
