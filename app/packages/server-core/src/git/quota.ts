/**
 * What a namespace on git.infrawrench.com may hold, and what it holds now.
 *
 * Public repositories are free everywhere and count toward nothing. Private
 * repositories and the storage they take follow the owner's plan
 * (`GIT_FORGE_LIMITS` in client-core, the numbers the docs' plan table
 * states): an organisation's from {@link planAccess}, a person's own
 * namespace from a fixed allowance, since it has no plan to read.
 *
 * The forge asks here at three moments and words its refusal from the answer:
 * creating a private repository (or making one private, transferring or
 * forking one into the namespace), and a push to a private repository. The
 * app's Settings > Git shows the same numbers. Nothing is ever taken away
 * when a plan lapses: repositories over the limits stay readable and
 * clonable, and what stops is adding to them.
 */
import { and, eq, sql } from "drizzle-orm";
import {
  GIT_FORGE_LIMITS,
  formatGitForgeBytes,
  type GitForgeLimits,
  type GitForgePlan,
  type GitForgeUsage,
} from "@infrawrench/client-core";

import { db } from "../db/client.js";
import { gitNamespaces, gitRepositories } from "../db/schema.js";
import { planAccess } from "../entitlements.js";

export interface GitQuota {
  plan: GitForgePlan;
  limits: GitForgeLimits;
  usage: GitForgeUsage;
}

/** Who owns a namespace: exactly one of the two is set (`git_namespaces_owner_check`). */
export interface GitQuotaOwner {
  organizationId: string | null;
  userId: string | null;
}

const EMPTY_USAGE: GitForgeUsage = {
  repositories: 0,
  publicRepositories: 0,
  privateRepositories: 0,
  storageBytes: 0,
  privateStorageBytes: 0,
};

async function usageOf(
  owner: { organizationId: string } | { userId: string },
): Promise<GitForgeUsage> {
  const [row] = await db
    .select({
      repositories: sql<number>`count(*)::int`,
      privateRepositories: sql<number>`(count(*) filter (where ${gitRepositories.visibility} = 'private'))::int`,
      storageBytes: sql<number>`coalesce(sum(${gitRepositories.sizeBytes}), 0)::float8`,
      privateStorageBytes: sql<number>`coalesce(sum(${gitRepositories.sizeBytes}) filter (where ${gitRepositories.visibility} = 'private'), 0)::float8`,
    })
    .from(gitRepositories)
    .innerJoin(gitNamespaces, eq(gitNamespaces.id, gitRepositories.namespaceId))
    .where(
      "organizationId" in owner
        ? and(eq(gitNamespaces.kind, "org"), eq(gitNamespaces.organizationId, owner.organizationId))
        : and(eq(gitNamespaces.kind, "user"), eq(gitNamespaces.userId, owner.userId)),
    );
  if (!row) return EMPTY_USAGE;
  return {
    repositories: row.repositories,
    publicRepositories: row.repositories - row.privateRepositories,
    privateRepositories: row.privateRepositories,
    storageBytes: row.storageBytes,
    privateStorageBytes: row.privateStorageBytes,
  };
}

/** An organisation's limits on the forge, by its plan, and what its namespace uses. */
export async function gitQuota(organizationId: string): Promise<GitQuota> {
  const [access, usage] = await Promise.all([
    planAccess(organizationId),
    usageOf({ organizationId }),
  ]);
  const plan: GitForgePlan = access.paid ? "paid" : "free";
  return { plan, limits: GIT_FORGE_LIMITS[plan], usage };
}

/** A person's own namespace: the fixed allowance, whatever organisations they belong to. */
export async function gitPersonalQuota(userId: string): Promise<GitQuota> {
  return { plan: "personal", limits: GIT_FORGE_LIMITS.personal, usage: await usageOf({ userId }) };
}

/** The quota of whoever owns a namespace row. */
export function gitNamespaceQuota(owner: GitQuotaOwner): Promise<GitQuota> {
  if (owner.organizationId !== null) return gitQuota(owner.organizationId);
  if (owner.userId !== null) return gitPersonalQuota(owner.userId);
  throw new Error("A namespace is owned by a user or an organisation");
}

const UPGRADE = "upgrade under Settings > Billing in the Infrawrench app";

/**
 * Why the namespace may not take one more private repository, or null when
 * it may. A sentence for a person: the forge sends it as the 402's `error`.
 */
export function privateRepositoryRefusal(quota: GitQuota): string | null {
  const limit = quota.limits.privateRepositories;
  if (limit === null || quota.usage.privateRepositories < limit) return null;
  const count = `${limit} private ${limit === 1 ? "repository" : "repositories"}`;
  return quota.plan === "personal"
    ? `A personal namespace includes ${count}. Make this one public, or keep it in an organisation`
    : `The free plan includes ${count}. Make this one public, or ${UPGRADE}`;
}

/**
 * Why a push to one of the namespace's private repositories is refused, or
 * null when it is not: its private repositories already hold what the plan
 * allows. Pushes to public repositories are never refused for storage.
 * Worded for git's `! [remote rejected] main -> main (...)` line, so no
 * capital and no full stop.
 */
export function pushRefusal(quota: GitQuota): string | null {
  const limit = quota.limits.privateStorageBytes;
  if (quota.usage.privateStorageBytes < limit) return null;
  const used = formatGitForgeBytes(quota.usage.privateStorageBytes);
  const allowed = formatGitForgeBytes(limit);
  const way =
    quota.plan === "free"
      ? `delete or make public what you do not need, or ${UPGRADE}`
      : quota.plan === "personal"
        ? "delete or make public what you do not need, or move it to an organisation"
        : "delete what you do not need, or write to support@infrawrench.com for more";
  return `storage quota exceeded: private repositories here use ${used} of ${allowed}; ${way}`;
}

/** {@link privateRepositoryRefusal} for a namespace row, read fresh. */
export async function gitPrivateRepositoryRefusal(owner: GitQuotaOwner): Promise<string | null> {
  return privateRepositoryRefusal(await gitNamespaceQuota(owner));
}

/** {@link pushRefusal} for a push to a repository of this visibility in this namespace. */
export async function gitPushRefusal(
  owner: GitQuotaOwner,
  visibility: "public" | "private",
): Promise<string | null> {
  if (visibility !== "private") return null;
  return pushRefusal(await gitNamespaceQuota(owner));
}
