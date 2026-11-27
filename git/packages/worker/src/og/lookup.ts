/**
 * What a page's link preview may say, read as a signed-out visitor
 * (`ANONYMOUS`) and nobody else: a crawler fetching a link someone pasted
 * is a stranger, whoever is signed in to the browser that loads the page.
 *
 * The same reads the API makes: the repository by `getRepository`, then
 * `repoAccess` for the anonymous principal, which is the only place access
 * is decided, so a private repository and a missing one both answer null
 * here, and the page and its image fall back to the site's (`./meta.ts`).
 * Then the one row the page is about. Nothing here writes: `branches.get`
 * may open a page for a branch that has none, and a crawler must not.
 *
 * Call inside `withDb` (`db/client.ts`).
 */
import { botByUsername, botForEmail, parseBranchKey } from "@infrawrench/git-contract";
import { hasAccess, repoAccess } from "../auth/repo-access";
import { ANONYMOUS } from "../auth/principal";
import { pageByNumber, pageKeys, resolveBranchKey } from "../db/branch-pages";
import { listFindings } from "../db/findings";
import { avatarOfNamespace, getNamespaceBySlug } from "../db/namespaces";
import { getRepository, type RepositoryWithOwner, toRepoForAccess } from "../db/repositories";
import { countVisibleRepositories } from "../db/repository-lists";
import { getAgentLink, versionsForPull } from "../db/review";
import { getThread } from "../db/threads";
import { userRefs } from "../db/users";
import { RepoReaderError } from "../repo/reader";
import type { RepoReaderFactory } from "../repo/select";
import type { Env } from "../env";
import {
  type BranchState,
  type OgFacts,
  type PersonFacts,
  type RepositoryFacts,
  MAX_LANGUAGES,
  firstLine,
} from "./facts";
import type { OgPage } from "./pages";

export interface LookupOptions {
  readonly env: Env;
  /** The storage, for a commit. The Worker's is `repoReaderFor`. */
  readonly reader: RepoReaderFactory;
}

/** A signed-out visitor sees nothing of a namespace's private repositories. */
const NOBODY = { userId: null, readableOrganizationIds: [] } as const;

/** The repository, when a signed-out visitor may read it. */
const readable = async (owner: string, name: string): Promise<RepositoryWithOwner | null> => {
  const found = await getRepository(owner, name);
  if (!found) return null;
  return hasAccess(await repoAccess(ANONYMOUS, toRepoForAccess(found)), "read") ? found : null;
};

const repositoryFacts = ({ repository, owner }: RepositoryWithOwner): RepositoryFacts => ({
  owner: owner.slug,
  ownerKind: owner.kind,
  ownerAvatarUrl: owner.avatarUrl,
  name: repository.name,
  description: repository.description,
  defaultBranch: repository.defaultBranch,
  languages: repository.languages
    .filter((language) => language.bytes > 0)
    .slice(0, MAX_LANGUAGES)
    .map(({ name, bytes }) => ({ name, bytes })),
  stars: repository.starsCount,
  forks: repository.forksCount,
  openIssues: repository.openIssuesCount,
  openBranches: repository.openPullRequestsCount,
  archived: repository.archived,
  issues: repository.hasIssues,
});

const person = async (userId: string | null): Promise<PersonFacts | null> => {
  if (userId === null) return null;
  const row = (await userRefs([userId])).get(userId);
  if (!row) return null;
  const name = row.displayName ?? row.username;
  return name ? { name, avatarUrl: row.avatarUrl } : null;
};

/** An agent shown as the bot it is when its name says which (`Claude Code`), else by name alone. */
const agentFacts = (displayName: string): PersonFacts => {
  const bot = botByUsername(displayName.trim().split(/\s+/)[0] ?? "");
  return { name: displayName, avatarUrl: bot?.avatar ?? null };
};

/** The facts `page` shows, or null: the site's own page, or nothing a stranger may see. */
export async function lookupFacts(page: OgPage, options: LookupOptions): Promise<OgFacts | null> {
  switch (page.kind) {
    case "home":
    case "explore":
    case "generic":
      return null;
    case "namespace": {
      const bot = botByUsername(page.owner);
      if (bot) {
        return {
          kind: "namespace",
          slug: bot.username,
          namespaceKind: "bot",
          displayName: bot.displayName,
          description: null,
          avatarUrl: bot.avatar,
          repositories: null,
        };
      }
      const namespace = await getNamespaceBySlug(page.owner);
      if (!namespace) return null;
      const [avatarUrl, repositories] = await Promise.all([
        avatarOfNamespace(namespace),
        countVisibleRepositories(namespace.id, NOBODY),
      ]);
      return {
        kind: "namespace",
        slug: namespace.slug,
        namespaceKind: namespace.kind,
        displayName: namespace.displayName,
        description: namespace.description,
        avatarUrl,
        repositories,
      };
    }
    case "repository": {
      const found = await readable(page.owner, page.repo);
      return found ? { kind: "repository", repository: repositoryFacts(found) } : null;
    }
    case "commit": {
      const found = await readable(page.owner, page.repo);
      if (!found) return null;
      const locator = {
        id: found.repository.id,
        owner: found.owner.slug,
        name: found.repository.name,
      };
      // No such commit is nothing to show (and kept as that); the storage being away throws.
      const detail = await options
        .reader(options.env, locator)
        .commit(page.sha)
        .catch((error: unknown) => {
          if (error instanceof RepoReaderError && error.code === "ref_not_found") return null;
          throw error;
        });
      if (detail === null) return null;
      const { commit, stats } = detail;
      const bot = botForEmail(commit.author.email);
      return {
        kind: "commit",
        repository: repositoryFacts(found),
        sha: commit.oid,
        summary: commit.summary,
        author: bot
          ? { name: bot.displayName, avatarUrl: bot.avatar }
          : { name: commit.author.name, avatarUrl: null },
        authoredAt: commit.author.when,
        filesChanged: stats.filesChanged,
        additions: stats.additions,
        deletions: stats.deletions,
      };
    }
    case "issue": {
      const found = await readable(page.owner, page.repo);
      if (!found || !found.repository.hasIssues) return null;
      const issue = await getThread(found.repository.id, page.number);
      // A branch page's number is not an issue's (`issues.get` answers 404 for it too).
      if (!issue || issue.isPullRequest) return null;
      return {
        kind: "issue",
        repository: repositoryFacts(found),
        number: issue.number,
        title: issue.title,
        state: issue.state,
        closedAs: issue.state === "closed" ? issue.stateReason : null,
        comments: issue.commentsCount,
        author: await person(issue.authorUserId),
      };
    }
    case "branch":
    case "branch-number": {
      const found = await readable(page.owner, page.repo);
      if (!found) return null;
      let key: string;
      if (page.kind === "branch") {
        if (!parseBranchKey(page.key)) return null;
        key = page.key;
      } else {
        const numbered = await pageByNumber(found.repository.id, page.number);
        if (!numbered) return null;
        const keys = await pageKeys([numbered]);
        const named = keys.get(numbered.issueId);
        if (named === undefined) return null;
        key = named;
      }
      const resolved = await resolveBranchKey(found.repository.id, key);
      if (!resolved) return null;
      const { thread, pull } = resolved;
      const [versions, open, agent, author, keys] = await Promise.all([
        versionsForPull(pull),
        listFindings(pull.issueId, { status: "open" }),
        getAgentLink(pull.issueId),
        person(thread.authorUserId),
        pageKeys([pull]),
      ]);
      const state: BranchState = pull.mergedAt
        ? "merged"
        : thread.state !== "open"
          ? "closed"
          : pull.draft
            ? "draft"
            : "open";
      return {
        kind: "branch",
        repository: repositoryFacts(found),
        key: keys.get(pull.issueId) ?? key,
        title: thread.title,
        state,
        headRef: pull.headRef,
        baseRef: pull.baseRef,
        versions: versions.at(-1)?.number ?? null,
        findings: {
          mustFix: open.filter((finding) => finding.severity === "must_fix").length,
          shouldFix: open.filter((finding) => finding.severity === "should_fix").length,
          note: open.filter((finding) => finding.severity === "note").length,
        },
        ask: firstLine(thread.body),
        author,
        agent: agent ? agentFacts(agent.displayName) : null,
        commits: pull.commitsCount,
        additions: pull.additions,
        deletions: pull.deletions,
      };
    }
  }
}
