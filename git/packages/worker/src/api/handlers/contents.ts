/**
 * `/api/repos/:owner/:repo`: what is in the repository. Every read and every
 * ref change goes through the `RepoReader` (`repo/reader.ts`); this file adds
 * what Postgres knows (people, statuses, pull requests, protected branches)
 * and decides who may change a branch.
 */
import { HttpApiBuilder } from "effect/http-api";
import {
  type Branch,
  type PullRequestBadge,
  GitApi,
  accessAtLeast,
  badRequest,
  isValidRefName,
  ok,
  unprocessable,
} from "@infrawrench/git-contract";
import { principalActor } from "../../auth/principal";
import { listProtectedBranches, protectionFor } from "../../db/policy";
import {
  type PullRequestWithThread,
  findOpenPullRequest,
  newestPullRequestsForBranches,
  pullRequestsForCommit,
} from "../../db/pulls";
import { getUser, userByUsername } from "../../db/users";
import { type ReaderBranch, RepoReaderError } from "../../repo/reader";
import { pageSize } from "../../db/cursor";
import { type RepoCx, repoOp } from "../context";
import { mayDelete, mayPush } from "../protection";
import { headRepository } from "../repos";
import { commitDecorator } from "../views/commits";

export const badgeOf = ({ thread, pull }: PullRequestWithThread): PullRequestBadge => ({
  number: thread.number,
  title: thread.title,
  state: pull.mergedAt ? "merged" : thread.state,
  draft: pull.draft,
});

/** `ref_not_found` from a ref a payload named is the payload's fault: a 422. */
const refInPayload = async <T>(work: Promise<T>): Promise<T> => {
  try {
    return await work;
  } catch (error) {
    if (error instanceof RepoReaderError && error.code === "ref_not_found") {
      throw unprocessable("No such branch, tag or commit", "ref_not_found");
    }
    throw error;
  }
};

/** The branches of a page as the contract's `Branch`. */
const branchViews = async (cx: RepoCx, branches: readonly ReaderBranch[]): Promise<Branch[]> => {
  const { repository } = cx.repo;
  const [rules, pulls, decorate] = await Promise.all([
    listProtectedBranches(repository.id),
    newestPullRequestsForBranches(
      repository.id,
      branches.map((branch) => branch.name),
    ),
    commitDecorator(
      repository.id,
      branches.map((branch) => branch.commit),
    ),
  ]);
  return branches.map((branch) => {
    const protection = protectionFor(rules, branch.name);
    const isDefault = branch.name === repository.defaultBranch;
    const pull = pulls.get(branch.name);
    return {
      name: branch.name,
      commit: decorate(branch.commit),
      isDefault,
      protected: protection !== null,
      ahead: isDefault ? null : branch.ahead,
      behind: isDefault ? null : branch.behind,
      pullRequest: pull ? badgeOf(pull) : null,
      viewerCanDelete:
        !isDefault && accessAtLeast(cx.access, "write") && mayDelete(protection, cx.access),
    };
  });
};

/** The email addresses history should match for `author`: a username's, or the text itself. */
const authorEmails = async (author: string | undefined): Promise<string[] | undefined> => {
  if (author === undefined || author === "") return undefined;
  if (author.includes("@")) return [author.toLowerCase()];
  const person = await userByUsername(author);
  const user = person ? await getUser(person.id) : null;
  // A username nobody has matches nothing, rather than everything.
  return user ? [user.email.toLowerCase()] : ["@"];
};

const compareInput = async (
  cx: RepoCx,
  query: { readonly base: string; readonly head: string; readonly headRepository?: string },
) => {
  const head = query.headRepository ? await headRepository(cx, query.headRepository) : cx.repo;
  return {
    head,
    input: {
      base: query.base,
      head: query.head,
      headRepositoryId:
        head.repository.id === cx.repo.repository.id ? undefined : head.repository.id,
    },
  };
};

const diffOptions = (query: {
  readonly cursor?: string;
  readonly limit?: number;
  readonly path?: string;
  readonly context?: number;
  readonly whitespace?: "show" | "ignore";
}) => ({
  cursor: query.cursor,
  limit: pageSize(query.limit),
  path: query.path,
  context: query.context,
  whitespace: query.whitespace,
});

export const ContentsHandlers = HttpApiBuilder.group(GitApi, "contents", (handlers) =>
  handlers
    .handle(
      "listRefs",
      repoOp(async (cx, { query }) => ({
        defaultBranch: cx.repo.repository.defaultBranch,
        ...(await cx.git.listRefs({ q: query.q, limit: pageSize(query.limit) })),
      })),
    )
    .handle(
      "listBranches",
      repoOp(async (cx, { query }) => {
        const user = query.view === "mine" && cx.userId ? await getUser(cx.userId) : null;
        const found = await cx.git.listBranches({
          cursor: query.cursor,
          limit: pageSize(query.limit),
          q: query.q,
          view: query.view,
          authorEmails: user ? [user.email.toLowerCase()] : undefined,
        });
        return { items: await branchViews(cx, found.items), nextCursor: found.nextCursor };
      }),
    )
    .handle(
      "createBranch",
      repoOp(async (cx, { payload }) => {
        if (!isValidRefName(payload.name)) {
          throw badRequest("That is not a valid branch name", "name_invalid");
        }
        const rules = await listProtectedBranches(cx.repo.repository.id);
        if (!mayPush(protectionFor(rules, payload.name), cx.access, cx.userId)) {
          throw unprocessable("A protected-branch rule reserves that name", "protected_branch");
        }
        const branch = await refInPayload(
          cx.git.createBranch({
            name: payload.name,
            from: payload.from,
            actor: principalActor(cx.principal),
          }),
        );
        const [view] = await branchViews(cx, [branch]);
        return view!;
      }),
    )
    .handle(
      "deleteBranch",
      repoOp(async (cx, { query }) => {
        const { repository } = cx.repo;
        if (query.name === repository.defaultBranch) {
          throw unprocessable("The default branch cannot be deleted");
        }
        const rules = await listProtectedBranches(repository.id);
        if (!mayDelete(protectionFor(rules, query.name), cx.access)) {
          throw unprocessable("This branch is protected from deletion", "protected_branch");
        }
        await cx.git.deleteBranch({
          name: query.name,
          expectedOid: query.expectedOid,
          actor: principalActor(cx.principal),
        });
        return ok;
      }),
    )
    .handle(
      "listTags",
      repoOp(async (cx, { query }) => {
        const found = await cx.git.listTags({
          cursor: query.cursor,
          limit: pageSize(query.limit),
          q: query.q,
        });
        const decorate = await commitDecorator(
          cx.repo.repository.id,
          found.items.map((tag) => tag.commit),
          { statuses: false },
        );
        return {
          items: found.items.map((tag) => ({
            ...tag,
            commit: tag.commit ? decorate(tag.commit) : null,
          })),
          nextCursor: found.nextCursor,
        };
      }),
    )
    .handle(
      "tree",
      repoOp(async (cx, { query }) => {
        const listing = await cx.git.tree({
          ref: query.ref,
          path: query.path ?? "",
          lastCommits: query.lastCommits !== "false",
        });
        const decorate = await commitDecorator(
          cx.repo.repository.id,
          [listing.lastCommit, ...listing.entries.map((entry) => entry.lastCommit)],
          { statuses: false },
        );
        return {
          ...listing,
          lastCommit: listing.lastCommit ? decorate(listing.lastCommit) : null,
          entries: listing.entries.map((entry) => ({
            ...entry,
            lastCommit: entry.lastCommit ? decorate(entry.lastCommit) : null,
          })),
        };
      }),
    )
    .handle(
      "treeLastCommits",
      repoOp(async (cx, { query }) => {
        const found = await cx.git.treeLastCommits({ ref: query.ref, path: query.path ?? "" });
        const decorate = await commitDecorator(
          cx.repo.repository.id,
          Object.values(found.commits),
          { statuses: false },
        );
        return {
          ...found,
          commits: Object.fromEntries(
            Object.entries(found.commits).map(([name, commit]) => [name, decorate(commit)]),
          ),
        };
      }),
    )
    .handle(
      "blob",
      repoOp((cx, { query }) => cx.git.blob({ ref: query.ref, path: query.path })),
    )
    .handle(
      "readme",
      repoOp(async (cx, { query }) => ({
        readme: await cx.git.readme({ ref: query.ref, path: query.path ?? "" }),
      })),
    )
    .handle(
      "listCommits",
      repoOp(async (cx, { query }) => {
        const found = await cx.git.listCommits({
          cursor: query.cursor,
          limit: pageSize(query.limit),
          ref: query.ref,
          path: query.path,
          authorEmails: await authorEmails(query.author),
          since: query.since,
          until: query.until,
          follow: query.follow === "true",
        });
        const decorate = await commitDecorator(cx.repo.repository.id, found.items);
        return { items: found.items.map(decorate), nextCursor: found.nextCursor };
      }),
    )
    .handle(
      "commit",
      repoOp(async (cx, { params }) => {
        const detail = await cx.git.commit(params.sha.toLowerCase());
        const [decorate, pullRequests] = await Promise.all([
          commitDecorator(cx.repo.repository.id, [detail.commit]),
          pullRequestsForCommit(cx.repo.repository.id, detail.commit.oid),
        ]);
        return { ...detail, commit: decorate(detail.commit), pullRequests };
      }),
    )
    .handle(
      "commitDiff",
      repoOp((cx, { params, query }) =>
        cx.git.commitDiff(params.sha.toLowerCase(), diffOptions(query)),
      ),
    )
    .handle(
      "compare",
      repoOp(async (cx, { query }) => {
        const { head, input } = await compareInput(cx, query);
        const found = await refInPayload(cx.git.compare(input));
        const [decorate, open] = await Promise.all([
          commitDecorator(cx.repo.repository.id, found.commits),
          // Only a comparison of two branches can have a pull request.
          found.base.kind === "branch" && found.head.kind === "branch"
            ? findOpenPullRequest(
                cx.repo.repository.id,
                found.base.name,
                head.repository.id,
                found.head.name,
              )
            : Promise.resolve(null),
        ]);
        return {
          ...found,
          commits: found.commits.map(decorate),
          headRepository: { owner: head.owner.slug, name: head.repository.name },
          pullRequest: open ? badgeOf(open) : null,
        };
      }),
    )
    .handle(
      "compareDiff",
      repoOp(async (cx, { query }) => {
        const { input } = await compareInput(cx, query);
        return refInPayload(cx.git.compareDiff(input, diffOptions(query)));
      }),
    )
    .handle(
      "blame",
      repoOp(async (cx, { query }) => {
        const blame = await cx.git.blame({ ref: query.ref, path: query.path });
        const decorate = await commitDecorator(
          cx.repo.repository.id,
          Object.values(blame.commits),
          {
            statuses: false,
          },
        );
        return {
          ...blame,
          commits: Object.fromEntries(
            Object.entries(blame.commits).map(([oid, commit]) => [oid, decorate(commit)]),
          ),
        };
      }),
    ),
);
