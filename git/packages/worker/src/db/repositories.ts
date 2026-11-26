/**
 * Repositories: resolving `owner/name`, the rows behind the lists, and the
 * counters and stars kept on the row.
 */
import { type SQL, and, desc, eq, inArray, or, sql } from "drizzle-orm";
import {
  type GitVisibility,
  gitCollaborators,
  gitNamespaces,
  gitRepositories,
  gitStars,
} from "@infrawrench/server-core/db/schema";
import type { RepoForAccess } from "../auth/access";
import { db, isUniqueViolation, newId } from "./client";
import {
  type PageOf,
  type TimeCursor,
  afterCursor,
  cursorTime,
  decodeCursor,
  pageSize,
  toPage,
} from "./cursor";

export type RepositoryRow = typeof gitRepositories.$inferSelect;

/** A repository with the namespace that owns it: what every request starts from. */
export interface RepositoryWithOwner {
  readonly repository: RepositoryRow;
  readonly owner: {
    readonly id: string;
    readonly slug: string;
    readonly kind: "user" | "org";
    readonly userId: string | null;
    readonly organizationId: string | null;
    readonly displayName: string | null;
    readonly avatarUrl: string | null;
  };
}

const ownerColumns = {
  id: gitNamespaces.id,
  slug: gitNamespaces.slug,
  kind: gitNamespaces.kind,
  userId: gitNamespaces.userId,
  organizationId: gitNamespaces.organizationId,
  displayName: gitNamespaces.displayName,
  avatarUrl: gitNamespaces.avatarUrl,
};

/**
 * Strip a trailing `.git`, which clone URLs carry and repository names never
 * do (`names.ts` refuses it).
 */
export const repositoryNameFromPath = (name: string): string =>
  name.toLowerCase().endsWith(".git") ? name.slice(0, -4) : name;

/** Resolve `owner/name`, both compared lowercased. One query: every Git request makes it. */
export const getRepository = async (
  owner: string,
  name: string,
): Promise<RepositoryWithOwner | null> => {
  const [row] = await db
    .select({ repository: gitRepositories, owner: ownerColumns })
    .from(gitRepositories)
    .innerJoin(gitNamespaces, eq(gitNamespaces.id, gitRepositories.namespaceId))
    .where(
      and(
        eq(gitNamespaces.slugLower, owner.toLowerCase()),
        eq(gitRepositories.nameLower, name.toLowerCase()),
      ),
    )
    .limit(1);
  return row ?? null;
};

/**
 * Whether a namespace has a repository by this name, compared as the unique
 * index compares it. `exceptId` leaves one repository out: its own name is
 * not taken from it.
 */
export const isRepositoryNameTaken = async (
  namespaceId: string,
  name: string,
  exceptId?: string,
): Promise<boolean> => {
  const [row] = await db
    .select({ id: gitRepositories.id })
    .from(gitRepositories)
    .where(
      and(
        eq(gitRepositories.namespaceId, namespaceId),
        eq(gitRepositories.nameLower, name.toLowerCase()),
      ),
    )
    .limit(1);
  return row !== undefined && row.id !== exceptId;
};

export const getRepositoryById = async (id: string): Promise<RepositoryWithOwner | null> => {
  const [row] = await db
    .select({ repository: gitRepositories, owner: ownerColumns })
    .from(gitRepositories)
    .innerJoin(gitNamespaces, eq(gitNamespaces.id, gitRepositories.namespaceId))
    .where(eq(gitRepositories.id, id))
    .limit(1);
  return row ?? null;
};

/** What `repoAccess` reads of a repository. */
export const toRepoForAccess = ({ repository, owner }: RepositoryWithOwner): RepoForAccess => ({
  id: repository.id,
  visibility: repository.visibility,
  archived: repository.archived,
  owner:
    owner.kind === "org" && owner.organizationId !== null
      ? { kind: "org", organizationId: owner.organizationId }
      : // The check constraint guarantees a user namespace has its user.
        { kind: "user", userId: owner.userId ?? "" },
});

export interface CreateRepositoryInput {
  readonly namespaceId: string;
  readonly name: string;
  readonly description?: string | null;
  readonly visibility: GitVisibility;
  readonly defaultBranch?: string;
  readonly createdByUserId: string | null;
  /** The parent, for a fork. */
  readonly forkOfId?: string | null;
}

/** Insert a repository. Null when the namespace already has one of that name. */
export const createRepository = async (
  input: CreateRepositoryInput,
): Promise<RepositoryRow | null> => {
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(gitRepositories)
        .values({
          id: newId(),
          namespaceId: input.namespaceId,
          name: input.name,
          nameLower: input.name.toLowerCase(),
          description: input.description ?? null,
          visibility: input.visibility,
          defaultBranch: input.defaultBranch ?? "main",
          createdByUserId: input.createdByUserId,
          forkOfId: input.forkOfId ?? null,
          isFork: Boolean(input.forkOfId),
        })
        .returning();
      if (input.forkOfId) {
        await tx
          .update(gitRepositories)
          .set({ forksCount: sql`${gitRepositories.forksCount} + 1` })
          .where(eq(gitRepositories.id, input.forkOfId));
      }
      return row!;
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return null;
  }
};

export type RepositoryPatch = Partial<
  Pick<
    RepositoryRow,
    | "name"
    | "namespaceId"
    | "description"
    | "homepageUrl"
    | "topics"
    | "visibility"
    | "defaultBranch"
    | "archived"
    | "hasIssues"
    | "hasPullRequests"
    | "allowMergeCommit"
    | "allowSquash"
    | "allowRebase"
    | "defaultMergeMethod"
    | "deleteBranchOnMerge"
    | "primaryLanguage"
  >
>;

/**
 * Change a repository's settings, name or owner. Null when the name is taken
 * where it would land, or the repository is gone.
 */
export const updateRepository = async (
  id: string,
  patch: RepositoryPatch,
): Promise<RepositoryRow | null> => {
  const now = new Date();
  try {
    const [row] = await db
      .update(gitRepositories)
      .set({
        ...patch,
        ...(patch.name !== undefined ? { nameLower: patch.name.toLowerCase() } : {}),
        ...(patch.archived !== undefined ? { archivedAt: patch.archived ? now : null } : {}),
        updatedAt: now,
      })
      .where(eq(gitRepositories.id, id))
      .returning();
    return row ?? null;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return null;
  }
};

/**
 * Delete a repository's row and everything that hangs off it. Its packs in R2
 * and its Durable Object are not this function's: the caller deletes those
 * by the id it gets back.
 */
export const deleteRepository = async (id: string): Promise<boolean> => {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .delete(gitRepositories)
      .where(eq(gitRepositories.id, id))
      .returning({ forkOfId: gitRepositories.forkOfId });
    if (!row) return false;
    if (row.forkOfId) {
      await tx
        .update(gitRepositories)
        .set({ forksCount: sql`greatest(${gitRepositories.forksCount} - 1, 0)` })
        .where(eq(gitRepositories.id, row.forkOfId));
    }
    return true;
  });
};

/** What the queue consumer records after a push. */
export const recordPush = async (
  id: string,
  push: {
    readonly at: Date;
    readonly sizeBytes?: number;
    readonly branchesCount?: number;
    readonly tagsCount?: number;
    readonly isEmpty?: boolean;
    readonly primaryLanguage?: string | null;
  },
): Promise<void> => {
  // Bound as text: a `Date` inside a raw fragment has no column to say how it is sent.
  const at = sql`${push.at.toISOString()}::timestamptz at time zone 'UTC'`;
  await db
    .update(gitRepositories)
    .set({
      // An event delivered late must not move the clock back.
      pushedAt: sql`greatest(coalesce(${gitRepositories.pushedAt}, ${at}), ${at})`,
      updatedAt: sql`greatest(${gitRepositories.updatedAt}, ${at})`,
      ...(push.sizeBytes !== undefined ? { sizeBytes: push.sizeBytes } : {}),
      ...(push.branchesCount !== undefined ? { branchesCount: push.branchesCount } : {}),
      ...(push.tagsCount !== undefined ? { tagsCount: push.tagsCount } : {}),
      ...(push.isEmpty !== undefined ? { isEmpty: push.isEmpty } : {}),
      ...(push.primaryLanguage !== undefined ? { primaryLanguage: push.primaryLanguage } : {}),
    })
    .where(eq(gitRepositories.id, id));
};

/**
 * Which repositories a viewer may see in a list, as SQL: the same answer
 * `repoAccess` would give for `read`, for a whole page at once.
 *
 * - everyone: public repositories;
 * - a person: also their own namespace's, the ones they collaborate on, and
 *   those of the organisations in `readableOrganizationIds` (where they hold
 *   `git:read`, resolved by the caller with the app's own resolver).
 */
export interface ListViewer {
  readonly userId: string | null;
  readonly readableOrganizationIds: readonly string[];
}

/**
 * Repositories the viewer has a tie to: their own namespace's, the ones they
 * collaborate on, their organisations'. Null when they have none to have
 * (signed out, in no organisation).
 */
const tiedTo = (viewer: ListViewer): SQL | null => {
  const ties: SQL[] = [];
  if (viewer.userId !== null) {
    ties.push(eq(gitNamespaces.userId, viewer.userId));
    ties.push(
      sql`exists (select 1 from ${gitCollaborators} where ${gitCollaborators.repositoryId} = ${gitRepositories.id} and ${gitCollaborators.userId} = ${viewer.userId})`,
    );
  }
  if (viewer.readableOrganizationIds.length > 0) {
    ties.push(inArray(gitNamespaces.organizationId, [...viewer.readableOrganizationIds]));
  }
  return ties.length === 0 ? null : (or(...ties) ?? null);
};

export const visibleTo = (viewer: ListViewer): SQL => {
  const tied = tiedTo(viewer);
  const isPublic = eq(gitRepositories.visibility, "public");
  return tied === null ? isPublic : (or(isPublic, tied) ?? isPublic);
};

export interface ListRepositoriesOptions {
  readonly viewer: ListViewer;
  /** Only this namespace's. */
  readonly namespaceId?: string;
  readonly type?: "all" | "sources" | "forks" | "archived" | "private";
  /** Only forks of this repository. */
  readonly forkOfId?: string;
  /** Leave out public repositories the viewer has no tie to ("my repositories"). */
  readonly onlyMine?: boolean;
  readonly cursor?: string;
  readonly limit?: number;
}

const pushedOrCreated = sql<Date>`coalesce(${gitRepositories.pushedAt}, ${gitRepositories.createdAt})`;

/**
 * Repositories, most recently pushed first. The other sorts and text search
 * the contract offers belong to the handler; this is the default listing
 * every page starts from.
 */
export const listRepositories = async (
  options: ListRepositoriesOptions,
): Promise<PageOf<RepositoryWithOwner>> => {
  const limit = pageSize(options.limit);
  const cursor = decodeCursor(options.cursor);
  const filters: (SQL | undefined)[] = [
    options.onlyMine ? (tiedTo(options.viewer) ?? sql`false`) : visibleTo(options.viewer),
    options.namespaceId ? eq(gitRepositories.namespaceId, options.namespaceId) : undefined,
    options.forkOfId ? eq(gitRepositories.forkOfId, options.forkOfId) : undefined,
    options.type === "sources" ? eq(gitRepositories.isFork, false) : undefined,
    options.type === "forks" ? eq(gitRepositories.isFork, true) : undefined,
    options.type === "archived" ? eq(gitRepositories.archived, true) : undefined,
    options.type === "private" ? eq(gitRepositories.visibility, "private") : undefined,
    cursor
      ? sql`(${pushedOrCreated}, ${gitRepositories.id}) < (${new Date(cursor.at).toISOString()}::timestamptz at time zone 'UTC', ${cursor.id})`
      : undefined,
  ];
  const rows = await db
    .select({ repository: gitRepositories, owner: ownerColumns, sortAt: pushedOrCreated })
    .from(gitRepositories)
    .innerJoin(gitNamespaces, eq(gitNamespaces.id, gitRepositories.namespaceId))
    .where(and(...filters))
    .orderBy(desc(pushedOrCreated), desc(gitRepositories.id))
    .limit(limit + 1);
  return toPage(
    rows.map(({ repository, owner }) => ({ repository, owner })),
    limit,
    ({ repository }): TimeCursor => ({
      at: (repository.pushedAt ?? repository.createdAt).getTime(),
      id: repository.id,
    }),
  );
};

/** Star a repository. Idempotent; the count moves only when the star is new. */
export const starRepository = async (userId: string, repositoryId: string): Promise<void> => {
  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(gitStars)
      .values({ userId, repositoryId })
      .onConflictDoNothing()
      .returning({ userId: gitStars.userId });
    if (inserted.length === 0) return;
    await tx
      .update(gitRepositories)
      .set({ starsCount: sql`${gitRepositories.starsCount} + 1` })
      .where(eq(gitRepositories.id, repositoryId));
  });
};

export const unstarRepository = async (userId: string, repositoryId: string): Promise<void> => {
  await db.transaction(async (tx) => {
    const deleted = await tx
      .delete(gitStars)
      .where(and(eq(gitStars.userId, userId), eq(gitStars.repositoryId, repositoryId)))
      .returning({ userId: gitStars.userId });
    if (deleted.length === 0) return;
    await tx
      .update(gitRepositories)
      .set({ starsCount: sql`greatest(${gitRepositories.starsCount} - 1, 0)` })
      .where(eq(gitRepositories.id, repositoryId));
  });
};

/** Which of these repositories the person has starred. */
export const starredAmong = async (
  userId: string,
  repositoryIds: readonly string[],
): Promise<Set<string>> => {
  if (repositoryIds.length === 0) return new Set();
  const rows = await db
    .select({ repositoryId: gitStars.repositoryId })
    .from(gitStars)
    .where(and(eq(gitStars.userId, userId), inArray(gitStars.repositoryId, [...repositoryIds])));
  return new Set(rows.map((row) => row.repositoryId));
};

/** A repository's stargazers' ids, newest first. */
export const listStargazerIds = async (
  repositoryId: string,
  options: { readonly cursor?: string; readonly limit?: number } = {},
): Promise<PageOf<{ readonly userId: string; readonly createdAt: Date }>> => {
  const limit = pageSize(options.limit);
  const rows = await db
    .select({ userId: gitStars.userId, createdAt: gitStars.createdAt })
    .from(gitStars)
    .where(
      and(
        eq(gitStars.repositoryId, repositoryId),
        afterCursor(gitStars.createdAt, gitStars.userId, decodeCursor(options.cursor), "desc"),
      ),
    )
    .orderBy(desc(cursorTime(gitStars.createdAt)), desc(gitStars.userId))
    .limit(limit + 1);
  return toPage(rows, limit, (row) => ({ at: row.createdAt.getTime(), id: row.userId }));
};
