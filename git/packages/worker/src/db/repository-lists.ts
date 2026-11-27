/**
 * The repository lists the API serves: a namespace's, a person's own,
 * explore and search, forks and starred. One query with the contract's
 * filters and sorts, always behind `visibleTo` (or the stricter "has a tie
 * to"), so a private repository the caller cannot read is in no list.
 */
import { type SQL, and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import {
  gitCollaborators,
  gitNamespaces,
  gitRepositories,
  gitStars,
} from "@infrawrench/server-core/db/schema";
import { liveGitWorkspaceId } from "@infrawrench/server-core/git/workspace";
import { namespaceAvatarUrl } from "./namespaces";
import { db } from "./client";
import { type PageOf, pageSize } from "./cursor";
import { type ListViewer, type RepositoryWithOwner, visibleTo } from "./repositories";

export type RepositorySort = "pushed" | "name" | "stars" | "created" | "starred";

export interface SearchRepositoriesOptions {
  readonly viewer: ListViewer;
  readonly namespaceId?: string | undefined;
  readonly type?: "all" | "sources" | "forks" | "archived" | "private" | undefined;
  readonly forkOfId?: string | undefined;
  /** Only repositories this person has starred; `sort: "starred"` orders by when. */
  readonly starredByUserId?: string | undefined;
  /**
   * Only repositories the viewer has a tie to (their own, their
   * organisations', the ones they collaborate on), at this level or above.
   */
  readonly mine?:
    | {
        readonly access: "read" | "write" | "admin";
        /** Organisations where the viewer's `git:*` permissions give at least `access`. */
        readonly organizationIds: readonly string[];
      }
    | undefined;
  /** Words to find in the name and description. */
  readonly q?: string | undefined;
  readonly language?: string | undefined;
  readonly topic?: string | undefined;
  readonly includeForks?: boolean | undefined;
  readonly sort?: RepositorySort | undefined;
  readonly direction?: "asc" | "desc" | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

const ownerColumns = {
  id: gitNamespaces.id,
  slug: gitNamespaces.slug,
  kind: gitNamespaces.kind,
  userId: gitNamespaces.userId,
  organizationId: gitNamespaces.organizationId,
  workspaceOrganizationId: liveGitWorkspaceId,
  displayName: gitNamespaces.displayName,
  avatarUrl: namespaceAvatarUrl,
};

/** Milliseconds since the epoch, so a cursor made in JavaScript compares exactly. */
const millis = (column: SQL | typeof gitRepositories.createdAt) =>
  sql<number>`floor(extract(epoch from ${column}) * 1000)::bigint`;

const sortKey = (sort: RepositorySort): SQL => {
  switch (sort) {
    case "name":
      return sql`${gitRepositories.nameLower}`;
    case "stars":
      return sql`${gitRepositories.starsCount}`;
    case "created":
      return millis(gitRepositories.createdAt);
    case "starred":
      return millis(sql`${gitStars.createdAt}`);
    case "pushed":
      return millis(sql`coalesce(${gitRepositories.pushedAt}, ${gitRepositories.createdAt})`);
  }
};

type CursorValue = readonly [string | number, string];

const encode = (value: CursorValue): string =>
  btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const decode = (cursor: string | undefined): CursorValue | null => {
  if (!cursor) return null;
  try {
    const value: unknown = JSON.parse(atob(cursor.replace(/-/g, "+").replace(/_/g, "/")));
    if (!Array.isArray(value) || value.length !== 2) return null;
    const [key, id] = value as [unknown, unknown];
    return (typeof key === "string" || typeof key === "number") && typeof id === "string"
      ? [key, id]
      : null;
  } catch {
    return null;
  }
};

/** `%` and `_` are literal in what a person typed. */
const likePattern = (text: string): string => `%${text.replace(/[\\%_]/g, "\\$&")}%`;

const mineFilter = (
  viewer: ListViewer,
  mine: NonNullable<SearchRepositoriesOptions["mine"]>,
): SQL => {
  if (viewer.userId === null) return sql`false`;
  const roles =
    mine.access === "admin"
      ? ["admin"]
      : mine.access === "write"
        ? ["write", "admin"]
        : ["read", "triage", "write", "admin"];
  const ties: SQL[] = [
    eq(gitNamespaces.userId, viewer.userId),
    sql`exists (select 1 from ${gitCollaborators} where ${gitCollaborators.repositoryId} = ${gitRepositories.id} and ${gitCollaborators.userId} = ${viewer.userId} and ${inArray(gitCollaborators.role, roles as Array<"read" | "triage" | "write" | "admin">)})`,
  ];
  if (mine.organizationIds.length > 0) {
    ties.push(inArray(gitNamespaces.organizationId, [...mine.organizationIds]));
  }
  // An archived repository is read-only for everyone.
  const tied = or(...ties) ?? sql`false`;
  return mine.access === "read"
    ? tied
    : (and(tied, eq(gitRepositories.archived, false)) ?? sql`false`);
};

export const searchRepositories = async (
  options: SearchRepositoriesOptions,
): Promise<PageOf<RepositoryWithOwner>> => {
  const limit = pageSize(options.limit);
  const sort = options.sort ?? "pushed";
  const direction = options.direction ?? (sort === "name" ? "asc" : "desc");
  const key = sortKey(sort);
  const cursor = decode(options.cursor);
  const words = (options.q ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 8);

  const filters: (SQL | undefined)[] = [
    visibleTo(options.viewer),
    options.mine ? mineFilter(options.viewer, options.mine) : undefined,
    options.namespaceId ? eq(gitRepositories.namespaceId, options.namespaceId) : undefined,
    options.forkOfId ? eq(gitRepositories.forkOfId, options.forkOfId) : undefined,
    options.type === "sources" ? eq(gitRepositories.isFork, false) : undefined,
    options.type === "forks" ? eq(gitRepositories.isFork, true) : undefined,
    options.type === "archived" ? eq(gitRepositories.archived, true) : undefined,
    options.type === "private" ? eq(gitRepositories.visibility, "private") : undefined,
    options.includeForks === false ? eq(gitRepositories.isFork, false) : undefined,
    options.language
      ? sql`lower(${gitRepositories.primaryLanguage}) = ${options.language.toLowerCase()}`
      : undefined,
    options.topic
      ? sql`${gitRepositories.topics} @> ${JSON.stringify([options.topic.toLowerCase()])}::jsonb`
      : undefined,
    ...words.map(
      (word) =>
        sql`(${gitRepositories.nameLower} like ${likePattern(word.toLowerCase())} or lower(coalesce(${gitRepositories.description}, '')) like ${likePattern(word.toLowerCase())})`,
    ),
    cursor
      ? direction === "desc"
        ? sql`(${key}, ${gitRepositories.id}) < (${cursor[0]}, ${cursor[1]})`
        : sql`(${key}, ${gitRepositories.id}) > (${cursor[0]}, ${cursor[1]})`
      : undefined,
  ];

  const order = direction === "desc" ? desc : asc;
  const base = db
    .select({ repository: gitRepositories, owner: ownerColumns, key: sql<string | number>`${key}` })
    .from(gitRepositories)
    .innerJoin(gitNamespaces, eq(gitNamespaces.id, gitRepositories.namespaceId));
  const joined =
    options.starredByUserId !== undefined
      ? base.innerJoin(
          gitStars,
          and(
            eq(gitStars.repositoryId, gitRepositories.id),
            eq(gitStars.userId, options.starredByUserId),
          ),
        )
      : base;
  const rows = await joined
    .where(and(...filters))
    .orderBy(order(key), order(gitRepositories.id))
    .limit(limit + 1);

  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return {
    items: items.map(({ repository, owner }) => ({ repository, owner })),
    nextCursor:
      rows.length > limit && last !== undefined
        ? encode([
            typeof last.key === "string" && sort !== "name" ? Number(last.key) : last.key,
            last.repository.id,
          ])
        : null,
  };
};

/** How many of a namespace's repositories the viewer can see. */
export const countVisibleRepositories = async (
  namespaceId: string,
  viewer: ListViewer,
): Promise<number> => {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(gitRepositories)
    .innerJoin(gitNamespaces, eq(gitNamespaces.id, gitRepositories.namespaceId))
    .where(and(eq(gitRepositories.namespaceId, namespaceId), visibleTo(viewer)));
  return row?.count ?? 0;
};

/** These repositories, as far as the viewer can see them, by id. */
export const visibleRepositoriesById = async (
  ids: readonly string[],
  viewer: ListViewer,
): Promise<Map<string, RepositoryWithOwner>> => {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ repository: gitRepositories, owner: ownerColumns })
    .from(gitRepositories)
    .innerJoin(gitNamespaces, eq(gitNamespaces.id, gitRepositories.namespaceId))
    .where(and(inArray(gitRepositories.id, unique), visibleTo(viewer)));
  return new Map(rows.map((row) => [row.repository.id, row]));
};
