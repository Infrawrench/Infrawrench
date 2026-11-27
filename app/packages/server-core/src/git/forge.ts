/**
 * The app's side of git.infrawrench.com: what Settings > Git, the sidebar's
 * Git entry, the phone and the CLI read and change about an organisation's
 * namespace there. The forge is its own site and owns everything else
 * (`git/`); the two share these tables, so the app reads them rather than
 * calling the forge.
 *
 * Claiming and renaming follow the forge's own rules (`git/README.md`
 * "Identity, namespaces, access"): the name rules and the reserved list are
 * client-core's `git-names.ts`, which both use, and whether a slug is taken
 * is the unique index's answer, never a check before the insert.
 */
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import {
  GIT_NAME_MAX_LENGTH,
  gitForgeUrl,
  gitNameProblemMessage,
  gitNamespaceSlugProblem,
  type GitForgeNamespace,
  type GitForgeOverview,
  type GitForgeRepository,
  type GitForgeVisibility,
} from "@infrawrench/client-core";

import { gitBaseUrl } from "../ci/source.js";
import { db } from "../db/client.js";
import { organizations } from "../db/core-schema.js";
import { ciRuns, gitNamespaces, gitRepositories } from "../db/schema.js";
import { gitOrganizationClaimRefusal, gitQuota } from "./quota.js";
import { gitUsernameHeld } from "./short-usernames.js";

type NamespaceRow = typeof gitNamespaces.$inferSelect;

/**
 * A refusal the API answers as it is: 400 for a bad name, 409 for one that is
 * taken. `plan_required` is 402 here and a 400 on the wire, whose declared
 * errors have no 402; the sentence is the same either way.
 */
export class GitForgeError extends Error {
  constructor(
    readonly status: 400 | 402 | 404 | 409,
    readonly code: "name_invalid" | "namespace_taken" | "namespace_required" | "plan_required",
    message: string,
  ) {
    super(message);
    this.name = "GitForgeError";
  }
}

/** The forge's origin: `GIT_BASE_URL`, the one CI clones from and links to. */
export const gitForgeOrigin = gitBaseUrl;

/** Postgres's unique violation, as the driver or drizzle's wrapper reports it. */
function isUniqueViolation(error: unknown): boolean {
  for (let e = error, depth = 0; e !== null && typeof e === "object" && depth < 4; depth++) {
    if ("code" in e && e.code === "23505") return true;
    e = "cause" in e ? e.cause : null;
  }
  return false;
}

async function namespaceOf(organizationId: string): Promise<NamespaceRow | null> {
  const [row] = await db
    .select()
    .from(gitNamespaces)
    .where(eq(gitNamespaces.organizationId, organizationId))
    .limit(1);
  return row ?? null;
}

function namespaceView(row: NamespaceRow): GitForgeNamespace {
  return {
    slug: row.slug,
    url: gitForgeUrl(gitForgeOrigin(), row.slug),
    defaultVisibility: row.defaultVisibility,
    createdAt: row.createdAt.toISOString(),
    renamedAt: row.renamedAt?.toISOString() ?? null,
  };
}

/** The organisation's namespace (or null), its plan's limits and what it uses. */
export async function gitForgeOverview(organizationId: string): Promise<GitForgeOverview> {
  const [namespace, quota] = await Promise.all([
    namespaceOf(organizationId),
    gitQuota(organizationId),
  ]);
  return {
    forgeUrl: gitForgeOrigin(),
    namespace: namespace ? namespaceView(namespace) : null,
    plan: quota.plan === "paid" ? "paid" : "free",
    limits: quota.limits,
    usage: quota.usage,
  };
}

/**
 * Give the organisation its namespace, or rename the one it has. A rename
 * moves nothing (repositories are keyed by id) and old URLs stop resolving.
 * A first claim needs a paid plan (`gitOrganizationClaimRefusal`); a rename
 * never asks, so an organisation whose plan lapsed keeps managing its name.
 * Returns what changed so the caller can audit it.
 */
export async function setGitForgeNamespace(
  organizationId: string,
  slug: string,
  claimedByUserId: string | null,
  /** A platform admin may take a reserved name (`infrawrench`); the shape rules still hold. */
  options: { readonly allowReserved?: boolean } = {},
): Promise<{
  namespace: GitForgeNamespace;
  change: "claimed" | "renamed" | "none";
  from?: string;
}> {
  const problem = gitNamespaceSlugProblem(slug);
  if (problem !== null && !(problem === "reserved" && options.allowReserved === true)) {
    throw new GitForgeError(
      400,
      "name_invalid",
      gitNameProblemMessage(problem, GIT_NAME_MAX_LENGTH),
    );
  }
  const current = await namespaceOf(organizationId);
  if (current?.slug === slug) return { namespace: namespaceView(current), change: "none" };
  // A short username someone is paying for is taken, for an organisation too.
  if (await gitUsernameHeld(slug)) {
    throw new GitForgeError(409, "namespace_taken", "That name is taken");
  }
  const now = new Date();
  try {
    if (current) {
      const [row] = await db
        .update(gitNamespaces)
        .set({ slug, slugLower: slug.toLowerCase(), renamedAt: now, updatedAt: now })
        .where(eq(gitNamespaces.id, current.id))
        .returning();
      if (!row) throw new GitForgeError(404, "namespace_required", "The namespace is gone");
      return { namespace: namespaceView(row), change: "renamed", from: current.slug };
    }
    const planRefusal = await gitOrganizationClaimRefusal(organizationId);
    if (planRefusal !== null) throw new GitForgeError(402, "plan_required", planRefusal);
    const [org] = await db
      .select({ displayName: organizations.displayName })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);
    const [row] = await db
      .insert(gitNamespaces)
      .values({
        id: crypto.randomUUID(),
        slug,
        slugLower: slug.toLowerCase(),
        kind: "org",
        organizationId,
        displayName: org?.displayName ?? null,
        claimedByUserId,
      })
      .returning();
    return { namespace: namespaceView(row!), change: "claimed" };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Two people claiming at once: the organisation's own index refused the
    // second insert. Rename what the first one claimed instead.
    if (!current && (await namespaceOf(organizationId))) {
      return setGitForgeNamespace(organizationId, slug, claimedByUserId);
    }
    throw new GitForgeError(409, "namespace_taken", "That name is taken");
  }
}

/** What a new repository in the organisation's namespace starts as. */
export async function setGitForgeDefaultVisibility(
  organizationId: string,
  defaultVisibility: GitForgeVisibility,
): Promise<GitForgeNamespace> {
  const [row] = await db
    .update(gitNamespaces)
    .set({ defaultVisibility, updatedAt: new Date() })
    .where(eq(gitNamespaces.organizationId, organizationId))
    .returning();
  if (!row) {
    throw new GitForgeError(404, "namespace_required", "Claim a namespace first");
  }
  return namespaceView(row);
}

/** How many repositories one answer lists. An organisation past this reads the rest on the forge. */
export const GIT_FORGE_REPOSITORY_LIST_LIMIT = 500;

/**
 * The organisation's repositories, most recently pushed first, each with the
 * latest CI run of its default branch. Private ones included: the caller
 * holds `git:read`, which reads every repository of the organisation on the
 * forge too.
 */
export async function listGitForgeRepositories(
  organizationId: string,
): Promise<GitForgeRepository[]> {
  const namespace = await namespaceOf(organizationId);
  if (!namespace) return [];
  const rows = await db
    .select()
    .from(gitRepositories)
    .where(eq(gitRepositories.namespaceId, namespace.id))
    .orderBy(sql`${gitRepositories.pushedAt} desc nulls last`, gitRepositories.nameLower)
    .limit(GIT_FORGE_REPOSITORY_LIST_LIMIT);
  if (rows.length === 0) return [];

  // The newest run per repository on its default branch. `skipped` is a run
  // with nothing to run, which says nothing about the branch.
  const runs = await db
    .selectDistinctOn([ciRuns.gitRepositoryId], {
      gitRepositoryId: ciRuns.gitRepositoryId,
      id: ciRuns.id,
      status: ciRuns.status,
      sha: ciRuns.sha,
    })
    .from(ciRuns)
    .innerJoin(gitRepositories, eq(gitRepositories.id, ciRuns.gitRepositoryId))
    .where(
      and(
        eq(ciRuns.organizationId, organizationId),
        inArray(
          ciRuns.gitRepositoryId,
          rows.map((row) => row.id),
        ),
        // A branch page's run is on `pull/<n>`, so this leaves those out.
        eq(ciRuns.branch, gitRepositories.defaultBranch),
        ne(ciRuns.status, "skipped"),
      ),
    )
    .orderBy(ciRuns.gitRepositoryId, desc(ciRuns.createdAt));
  const ciByRepository = new Map(runs.map((run) => [run.gitRepositoryId, run]));

  const origin = gitForgeOrigin();
  return rows.map((row) => {
    const run = ciByRepository.get(row.id);
    return {
      id: row.id,
      name: row.name,
      fullName: `${namespace.slug}/${row.name}`,
      url: gitForgeUrl(origin, namespace.slug, row.name),
      description: row.description,
      visibility: row.visibility,
      archived: row.archived,
      isFork: row.isFork,
      defaultBranch: row.defaultBranch,
      pushedAt: row.pushedAt?.toISOString() ?? null,
      // The column keeps its name: it counts open branch pages.
      openBranches: row.openPullRequestsCount,
      openIssues: row.openIssuesCount,
      sizeBytes: row.sizeBytes,
      ci: run ? { status: run.status, runId: run.id, sha: run.sha } : null,
    };
  });
}
