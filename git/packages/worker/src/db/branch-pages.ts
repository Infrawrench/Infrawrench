/**
 * What names a branch's page: its key (`BranchKey`, `@infrawrench/git-contract`),
 * resolved to the page row within a base repository, and each page's canonical
 * key computed back from its row.
 *
 * A page's row is `git_pull_requests` (the storage keeps its name). The pages
 * that share a head, that is a base repository, a head repository (null once
 * a fork is deleted) and a head branch, are counted by thread number, oldest
 * first: `feature/a~2` is the second. The bare name is the open page of that
 * head, or the newest one when none is open, and a page's canonical key is
 * the bare name when the bare name resolves to it, `~n` otherwise.
 *
 * Neither function checks access: the page is in the base repository, which
 * the caller can read (the `RepositoryAccess` gate, or the caller's own check
 * for a repository named elsewhere). A fork's `owner/name` is resolved by its
 * namespace and name alone, since the page lives in the base.
 */
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { parseBranchKey } from "@infrawrench/git-contract";
import { gitIssues, gitPullRequests } from "@infrawrench/server-core/db/schema";
import { db } from "./client";
import type { PullRequestWithThread } from "./pulls";
import { getRepository } from "./repositories";

/** A page of a head, as {@link pickPage} and {@link canonicalOrdinal} read it. */
export interface HeadPage {
  readonly number: number;
  readonly open: boolean;
}

/**
 * The page a key's ordinal names among the pages of one head, sorted by
 * number: the `n`-th for `~n`, else the open one (the newest open, should
 * older data hold two), else the newest. Undefined when there is none.
 */
export const pickPage = <P extends HeadPage>(
  pages: readonly P[],
  ordinal: number | null,
): P | undefined => {
  if (ordinal !== null) return pages[ordinal - 1];
  for (let index = pages.length - 1; index >= 0; index--) {
    if (pages[index]!.open) return pages[index];
  }
  return pages.at(-1);
};

/**
 * The ordinal a page's canonical key carries: null when the bare name
 * resolves to it, else its place (1 for the first) among its head's pages.
 */
export const canonicalOrdinal = (pages: readonly HeadPage[], number: number): number | null => {
  const index = pages.findIndex((page) => page.number === number);
  if (index === -1) return null;
  return pickPage(pages, null)?.number === number ? null : index + 1;
};

/** The page a key names in a base repository, or null: no such page, or no key at all. */
export const resolveBranchKey = async (
  baseRepositoryId: string,
  key: string,
): Promise<PullRequestWithThread | null> => {
  const parsed = parseBranchKey(key);
  if (!parsed) return null;
  let headRepositoryId: string | null;
  if (parsed.fork === null) headRepositoryId = baseRepositoryId;
  else if (parsed.fork === "gone") headRepositoryId = null;
  else {
    const fork = await getRepository(parsed.fork.owner, parsed.fork.name);
    if (!fork) return null;
    headRepositoryId = fork.repository.id;
  }
  const pages = await db
    .select({ thread: gitIssues, pull: gitPullRequests })
    .from(gitPullRequests)
    .innerJoin(gitIssues, eq(gitIssues.id, gitPullRequests.issueId))
    .where(
      and(
        eq(gitPullRequests.repositoryId, baseRepositoryId),
        headRepositoryId === null
          ? isNull(gitPullRequests.headRepositoryId)
          : eq(gitPullRequests.headRepositoryId, headRepositoryId),
        eq(gitPullRequests.headRef, parsed.branch),
      ),
    )
    .orderBy(asc(gitIssues.number));
  return (
    pickPage(
      pages.map((page) => ({
        ...page,
        number: page.thread.number,
        open: page.thread.state === "open",
      })),
      parsed.ordinal,
    ) ?? null
  );
};

/** What {@link pageKeys} needs of a page: its row's id. */
export interface KeyedPage {
  readonly issueId: string;
}

/**
 * Each page's canonical key, by its thread id, in one query: every page that
 * shares a head with one asked for is ranked by a window over that head, and
 * a fork's `owner/name` is joined in. Pages that are not found are left out.
 */
export const pageKeys = async (pages: readonly KeyedPage[]): Promise<Map<string, string>> => {
  const ids = [...new Set(pages.map((page) => page.issueId))];
  const keys = new Map<string, string>();
  if (ids.length === 0) return keys;
  const idList = sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
  const rows = await db.execute<{
    issue_id: string;
    head_ref: string;
    base_id: string;
    head_id: string | null;
    ordinal: number;
    current_id: string;
    fork_owner: string | null;
    fork_name: string | null;
  }>(sql`
    with wanted as (
      select repository_id, head_repository_id, head_ref
      from git_pull_requests
      where issue_id in (${idList})
    ),
    ranked as (
      select
        p.issue_id,
        p.repository_id as base_id,
        p.head_repository_id as head_id,
        p.head_ref,
        (row_number() over head_pages)::int as ordinal,
        first_value(p.issue_id) over (
          partition by p.repository_id, p.head_repository_id, p.head_ref
          order by (i.state = 'open') desc, i.number desc
        ) as current_id
      from git_pull_requests p
      inner join git_issues i on i.id = p.issue_id
      where exists (
        select 1 from wanted w
        where w.repository_id = p.repository_id
          and w.head_repository_id is not distinct from p.head_repository_id
          and w.head_ref = p.head_ref
      )
      window head_pages as (
        partition by p.repository_id, p.head_repository_id, p.head_ref
        order by i.number
      )
    )
    select r.issue_id, r.head_ref, r.base_id, r.head_id, r.ordinal, r.current_id,
      n.slug as fork_owner, h.name as fork_name
    from ranked r
    left join git_repositories h on h.id = r.head_id
    left join git_namespaces n on n.id = h.namespace_id
    where r.issue_id in (${idList})
  `);
  for (const row of Array.from(rows)) {
    const fork =
      row.head_id === row.base_id
        ? ""
        : row.head_id === null || row.fork_owner === null || row.fork_name === null
          ? "-:"
          : `${row.fork_owner}/${row.fork_name}:`;
    const ordinal = row.current_id === row.issue_id ? "" : `~${Number(row.ordinal)}`;
    keys.set(row.issue_id, `${fork}${row.head_ref}${ordinal}`);
  }
  return keys;
};

/** One page's canonical key. */
export const pageKey = async (page: KeyedPage): Promise<string> => {
  const key = (await pageKeys([page])).get(page.issueId);
  if (key === undefined) throw new Error(`No branch page ${page.issueId}`);
  return key;
};

/**
 * The open page of a head in a base repository, whatever branch it merges
 * into: a head has at most one.
 */
export const openPageOfHead = async (
  baseRepositoryId: string,
  headRepositoryId: string,
  headRef: string,
): Promise<PullRequestWithThread | null> => {
  const [row] = await db
    .select({ thread: gitIssues, pull: gitPullRequests })
    .from(gitPullRequests)
    .innerJoin(gitIssues, eq(gitIssues.id, gitPullRequests.issueId))
    .where(
      and(
        eq(gitPullRequests.repositoryId, baseRepositoryId),
        eq(gitPullRequests.headRepositoryId, headRepositoryId),
        eq(gitPullRequests.headRef, headRef),
        eq(gitIssues.state, "open"),
      ),
    )
    .orderBy(sql`${gitIssues.number} desc`)
    .limit(1);
  return row ?? null;
};

/** Whether a head has ever had a page in a base repository, open or not. */
export const headHasPage = async (
  baseRepositoryId: string,
  headRepositoryId: string,
  headRef: string,
): Promise<boolean> => {
  const [row] = await db
    .select({ id: gitPullRequests.issueId })
    .from(gitPullRequests)
    .where(
      and(
        eq(gitPullRequests.repositoryId, baseRepositoryId),
        eq(gitPullRequests.headRepositoryId, headRepositoryId),
        eq(gitPullRequests.headRef, headRef),
      ),
    )
    .limit(1);
  return row !== undefined;
};

/**
 * The canonical keys of the pages these thread numbers name in a repository,
 * by number: what a CI or Terraform run, which records its page's number,
 * answers. A number that is no page's is left out.
 */
export const pageKeysByNumber = async (
  repositoryId: string,
  numbers: readonly number[],
): Promise<Map<number, string>> => {
  const out = new Map<number, string>();
  const wanted = [...new Set(numbers)];
  if (wanted.length === 0) return out;
  const pages = await db
    .select({ issueId: gitPullRequests.issueId, number: gitIssues.number })
    .from(gitPullRequests)
    .innerJoin(gitIssues, eq(gitIssues.id, gitPullRequests.issueId))
    .where(and(eq(gitIssues.repositoryId, repositoryId), inArray(gitIssues.number, wanted)));
  const keys = await pageKeys(pages);
  for (const page of pages) {
    const key = keys.get(page.issueId);
    if (key !== undefined) out.set(page.number, key);
  }
  return out;
};

/** The thread number of the page a key names, for filters over what records numbers. */
export const pageNumberOf = async (repositoryId: string, key: string): Promise<number | null> =>
  (await resolveBranchKey(repositoryId, key))?.thread.number ?? null;

/** The page a thread number names in a repository, when it is a page's. */
export const pageByNumber = async (
  repositoryId: string,
  number: number,
): Promise<{ readonly issueId: string } | null> => {
  const [row] = await db
    .select({ issueId: gitPullRequests.issueId })
    .from(gitPullRequests)
    .innerJoin(gitIssues, eq(gitIssues.id, gitPullRequests.issueId))
    .where(and(eq(gitIssues.repositoryId, repositoryId), eq(gitIssues.number, number)))
    .limit(1);
  return row ?? null;
};
