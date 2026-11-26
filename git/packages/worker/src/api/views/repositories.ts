/**
 * Repository rows as the contract's `RepositorySummary` and `Repository`.
 */
import { sql } from "drizzle-orm";
import {
  type NamespaceRef,
  type Repository,
  type RepositoryRef,
  type RepositorySummary,
  type UserRef,
  accessAtLeast,
  httpCloneUrl,
  sshCloneUrl,
} from "@infrawrench/git-contract";
import { ciRuns, gitTerraformWorkspaces } from "@infrawrench/server-core/db/schema";
import { db } from "../../db/client";
import { type RepositoryWithOwner, starredAmong } from "../../db/repositories";
import { visibleRepositoriesById } from "../../db/repository-lists";
import { type UserRefRow, userRefs } from "../../db/users";
import { siteOrigin, sshHost } from "../../env";
import type { Cx, RepoCx } from "../context";

export const iso = (date: Date): string => date.toISOString();
export const isoOrNull = (date: Date | null): string | null => date?.toISOString() ?? null;

export const toUserRef = (row: UserRefRow | undefined | null): UserRef | null =>
  row
    ? { id: row.id, username: row.username, displayName: row.displayName, avatarUrl: row.avatarUrl }
    : null;

/** Look people up once and answer each by id. */
export const peopleById = async (
  ids: ReadonlyArray<string | null | undefined>,
): Promise<(id: string | null | undefined) => UserRef | null> => {
  const known = await userRefs(ids.filter((id): id is string => typeof id === "string"));
  return (id) => (id ? toUserRef(known.get(id)) : null);
};

export const toNamespaceRef = (owner: RepositoryWithOwner["owner"]): NamespaceRef => ({
  slug: owner.slug,
  kind: owner.kind,
  displayName: owner.displayName,
  avatarUrl: owner.avatarUrl,
});

export const toRepositoryRef = ({ repository, owner }: RepositoryWithOwner): RepositoryRef => ({
  id: repository.id,
  owner: owner.slug,
  name: repository.name,
  visibility: repository.visibility,
});

/** A page of repositories, with the viewer's stars and each fork's parent (when they may see it). */
export const repositorySummaries = async (
  cx: Cx,
  rows: readonly RepositoryWithOwner[],
): Promise<RepositorySummary[]> => {
  const viewer = await cx.viewer();
  const [starred, parents] = await Promise.all([
    cx.userId === null
      ? Promise.resolve(new Set<string>())
      : starredAmong(
          cx.userId,
          rows.map((row) => row.repository.id),
        ),
    visibleRepositoriesById(
      rows.flatMap((row) => (row.repository.forkOfId ? [row.repository.forkOfId] : [])),
      viewer,
    ),
  ]);
  return rows.map(({ repository, owner }) => {
    const parent = repository.forkOfId ? parents.get(repository.forkOfId) : undefined;
    return {
      id: repository.id,
      owner: toNamespaceRef(owner),
      name: repository.name,
      description: repository.description,
      visibility: repository.visibility,
      archived: repository.archived,
      isFork: repository.isFork,
      parent: parent ? toRepositoryRef(parent) : null,
      defaultBranch: repository.defaultBranch,
      primaryLanguage: repository.primaryLanguage,
      topics: repository.topics,
      starCount: repository.starsCount,
      forkCount: repository.forksCount,
      openIssueCount: repository.openIssuesCount,
      openBranchCount: repository.openPullRequestsCount,
      sizeBytes: repository.sizeBytes,
      pushedAt: isoOrNull(repository.pushedAt),
      createdAt: iso(repository.createdAt),
      updatedAt: iso(repository.updatedAt),
      viewerHasStarred: starred.has(repository.id),
    };
  });
};

const exists = async (query: ReturnType<typeof sql>): Promise<boolean> => {
  const rows = await db.execute<{ found: boolean }>(sql`select exists (${query}) as found`);
  return Array.from(rows)[0]?.found === true;
};

/** The repository page's header, for whoever `access` describes. */
export const repositoryDetail = async (
  cx: Cx,
  found: RepositoryWithOwner,
  level: Pick<RepoCx, "access" | "unarchived">,
): Promise<Repository> => {
  const { repository, owner } = found;
  const [summary] = await repositorySummaries(cx, [found]);
  const [hasCi, hasTerraform] = await Promise.all([
    exists(sql`select 1 from ${ciRuns} where ${ciRuns.gitRepositoryId} = ${repository.id}`),
    exists(
      sql`select 1 from ${gitTerraformWorkspaces} where ${gitTerraformWorkspaces.repositoryId} = ${repository.id}`,
    ),
  ]);
  const ref = { owner: owner.slug, repo: repository.name };
  return {
    ...summary!,
    homepageUrl: repository.homepageUrl,
    isEmpty: repository.isEmpty,
    languages: repository.languages,
    httpCloneUrl: httpCloneUrl(ref, siteOrigin(cx.env)),
    sshCloneUrl: sshCloneUrl(ref, sshHost(cx.env)),
    features: { issues: repository.hasIssues },
    merge: {
      allowMergeCommit: repository.allowMergeCommit,
      allowSquash: repository.allowSquash,
      allowRebase: repository.allowRebase,
      defaultMethod: repository.defaultMergeMethod,
      deleteBranchOnMerge: repository.deleteBranchOnMerge,
    },
    branchCount: repository.branchesCount,
    tagCount: repository.tagsCount,
    hasCi,
    hasTerraform,
    viewer: {
      access: level.access,
      canAdminister: accessAtLeast(level.unarchived, "admin"),
      canPush: accessAtLeast(level.access, "write"),
      canTriage: accessAtLeast(level.access, "triage"),
      canFork: cx.userId !== null && cx.username !== null,
      hasStarred: summary!.viewerHasStarred,
    },
  };
};
