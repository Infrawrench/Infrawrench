/**
 * Which git.infrawrench.com repositories an organization runs CI for.
 *
 * There is nothing to connect, unlike a GitHub account: every repository of
 * an organization's namespace runs CI on a paid plan, and
 * `ci_git_repositories.ci_enabled` is the per-repository switch. A row
 * appears with the first event the app is told of (`git-events.ts`) or the
 * first time someone uses the switch, and follows the repository's id, so a
 * rename or a transfer keeps its setting.
 *
 * The forge's repository settings own the switch's UI: its Worker imports
 * this module (`git/packages/worker/NOTES-ci.md`).
 */
import { and, asc, eq } from "drizzle-orm";

import { db } from "../db/client.js";
import { ciGitRepositories } from "../db/schema.js";
import { gitOwnerKey } from "./source.js";

/** A repository of the forge, as its Worker names it to CI. */
export interface GitRepositoryRef {
  /** `git_repositories.id`. */
  id: string;
  /** The namespace's slug and the repository's name, as the forge spells them. */
  namespace: string;
  name: string;
  defaultBranch: string;
  /**
   * The Infrawrench organization that owns the namespace, or `null` for a
   * person's own namespace, which runs no CI: a run is billed to an
   * organization and lent that organization's things.
   */
  organizationId: string | null;
}

export interface CiGitRepository {
  gitRepositoryId: string;
  /** `namespace/name`. */
  repoFullName: string;
  defaultBranch: string;
  ciEnabled: boolean;
}

const NAME = /^[A-Za-z0-9._-]{1,100}$/;

/** Whether the names are ones a clone URL and a runner's owner key can be built from. */
export function validGitRepositoryRef(ref: GitRepositoryRef): boolean {
  const plain = (text: string) => NAME.test(text) && !text.includes("..") && !/^[.-]/.test(text);
  return (
    typeof ref.id === "string" &&
    ref.id.length > 0 &&
    ref.id.length <= 200 &&
    plain(ref.namespace) &&
    plain(ref.name) &&
    !ref.name.toLowerCase().endsWith(".git") &&
    typeof ref.defaultBranch === "string" &&
    ref.defaultBranch.length > 0
  );
}

export const gitRepoFullName = (ref: Pick<GitRepositoryRef, "namespace" | "name">): string =>
  `${ref.namespace}/${ref.name}`;

const toWire = (row: typeof ciGitRepositories.$inferSelect): CiGitRepository => ({
  gitRepositoryId: row.gitRepositoryId,
  repoFullName: `${row.namespace}/${row.name}`,
  defaultBranch: row.defaultBranch,
  ciEnabled: row.ciEnabled,
});

/**
 * Records a repository an event named, keeping its names current, and says
 * whether it runs CI. A new one does.
 */
export async function noteGitRepository(
  ref: GitRepositoryRef & { organizationId: string },
): Promise<CiGitRepository> {
  const now = new Date();
  const [row] = await db
    .insert(ciGitRepositories)
    .values({
      id: crypto.randomUUID(),
      organizationId: ref.organizationId,
      gitRepositoryId: ref.id,
      namespace: ref.namespace,
      name: ref.name,
      defaultBranch: ref.defaultBranch,
    })
    .onConflictDoUpdate({
      target: ciGitRepositories.gitRepositoryId,
      set: {
        organizationId: ref.organizationId,
        namespace: ref.namespace,
        name: ref.name,
        defaultBranch: ref.defaultBranch,
        updatedAt: now,
      },
    })
    .returning();
  if (!row) throw new Error("The repository could not be recorded for CI.");
  return toWire(row);
}

/** Switches CI on or off for one repository of the organization's. */
export async function setCiGitRepository(
  ref: GitRepositoryRef & { organizationId: string },
  enabled: boolean,
  userId: string | null,
): Promise<CiGitRepository> {
  const now = new Date();
  const [row] = await db
    .insert(ciGitRepositories)
    .values({
      id: crypto.randomUUID(),
      organizationId: ref.organizationId,
      gitRepositoryId: ref.id,
      namespace: ref.namespace,
      name: ref.name,
      defaultBranch: ref.defaultBranch,
      ciEnabled: enabled,
      changedByUserId: userId,
    })
    .onConflictDoUpdate({
      target: ciGitRepositories.gitRepositoryId,
      set: {
        organizationId: ref.organizationId,
        namespace: ref.namespace,
        name: ref.name,
        defaultBranch: ref.defaultBranch,
        ciEnabled: enabled,
        changedByUserId: userId,
        updatedAt: now,
      },
    })
    .returning();
  if (!row) throw new Error("The repository's CI setting could not be saved.");
  return toWire(row);
}

/** One repository's setting, or `null` when CI has never heard of it (which means on). */
export async function ciGitRepository(
  organizationId: string,
  gitRepositoryId: string,
): Promise<CiGitRepository | null> {
  const [row] = await db
    .select()
    .from(ciGitRepositories)
    .where(
      and(
        eq(ciGitRepositories.organizationId, organizationId),
        eq(ciGitRepositories.gitRepositoryId, gitRepositoryId),
      ),
    )
    .limit(1);
  return row ? toWire(row) : null;
}

/** Every repository of the forge the organization's CI has heard of. */
export async function ciGitRepositoriesOf(organizationId: string): Promise<CiGitRepository[]> {
  const rows = await db
    .select()
    .from(ciGitRepositories)
    .where(eq(ciGitRepositories.organizationId, organizationId))
    .orderBy(asc(ciGitRepositories.namespace), asc(ciGitRepositories.name));
  return rows.map(toWire);
}

/**
 * The runner owners an organization's forge repositories are kept under:
 * one per namespace. Looked up from the organization's own rows, so it can
 * never name another organization's owner.
 */
export async function gitOwnerKeysOf(
  organizationId: string,
): Promise<Array<{ namespace: string; ownerKey: string }>> {
  const rows = await db
    .selectDistinct({ namespace: ciGitRepositories.namespace })
    .from(ciGitRepositories)
    .where(eq(ciGitRepositories.organizationId, organizationId))
    .orderBy(asc(ciGitRepositories.namespace));
  return rows.map((r) => ({ namespace: r.namespace, ownerKey: gitOwnerKey(r.namespace) }));
}
