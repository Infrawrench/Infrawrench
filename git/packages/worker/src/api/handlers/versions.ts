/**
 * A branch's versions and the diffs between them, the branch page's state,
 * and what has no repository in its path: the review inbox.
 *
 * Versions are recorded by the repository's Durable Object and copied to
 * Postgres by the queue consumer (`events/versions.ts`); everything here
 * reads those rows, and asks the head repository's reader for the diffs.
 */
import { HttpApiBuilder } from "effect/http-api";
import { GitApi, notFound, unprocessable } from "@infrawrench/git-contract";
import { pageKeys } from "../../db/branch-pages";
import { decodeCursor, pageSize } from "../../db/cursor";
import type { PullRequestWithThread } from "../../db/pulls";
import {
  type VersionRow,
  changesSince,
  getReviewedMark,
  reviewInbox,
  setReviewedMark,
  versionsForPull,
} from "../../db/review";
import type { RepoReader, VersionSide } from "../../repo/reader";
import { pageOr404 } from "../branch-page";
import { type RepoCx, locatorOf, op, repoOp } from "../context";
import { headRepositoryOf, mayProposeTo } from "../repos";
import { iso, isoOrNull, peopleById } from "../views/repositories";
import { branchPageState, versionViews } from "../views/review";

/** The version a path names: a number, or `latest`. */
const versionOr404 = (versions: readonly VersionRow[], selector: string): VersionRow => {
  const found =
    selector === "latest"
      ? versions.at(-1)
      : versions.find((version) => version.number === Number(selector));
  if (!found) throw notFound("No such version");
  return found;
};

const sideOf = (version: VersionRow): VersionSide => ({
  tipOid: version.tipOid,
  baseOid: version.baseOid,
});

/**
 * Where a page's versions are read: its head repository, which has
 * every version's commit (kept by the version's ref) and each one's base (an
 * ancestor of it). A fork that is gone, or that the base's readers may no
 * longer be shown, leaves the base repository, which has the heads it was
 * given.
 */
const versionReader = async (cx: RepoCx, found: PullRequestWithThread): Promise<RepoReader> => {
  const head = await headRepositoryOf(cx, found.pull.headRepositoryId);
  return head && mayProposeTo(cx.repo, head.repo) ? cx.reader(locatorOf(head.repo)) : cx.git;
};

export const VersionsHandlers = HttpApiBuilder.group(GitApi, "versions", (handlers) =>
  handlers
    .handle(
      "list",
      repoOp(async (cx, { params }) => {
        const found = await pageOr404(cx, params.branch);
        const [versions, mark] = await Promise.all([
          versionsForPull(found.pull),
          cx.userId ? getReviewedMark(found.pull.issueId, cx.userId) : null,
        ]);
        const latest = versions.at(-1) ?? null;
        return {
          branch: found.pull.headRef,
          versions: await versionViews(found.pull.issueId, versions),
          latest: latest?.number ?? null,
          viewerReviewed:
            mark && latest && mark.lineage === latest.lineage ? mark.versionNumber : null,
        };
      }),
    )
    .handle(
      "get",
      repoOp(async (cx, { params }) => {
        const found = await pageOr404(cx, params.branch);
        const versions = await versionsForPull(found.pull);
        const wanted = versionOr404(versions, params.version);
        // All of them, so `rebased` has the version before to compare with.
        const views = await versionViews(found.pull.issueId, versions);
        return views.find((view) => view.number === wanted.number)!;
      }),
    )
    .handle(
      "diff",
      repoOp(async (cx, { params, query }) => {
        const found = await pageOr404(cx, params.branch);
        const versions = await versionsForPull(found.pull);
        const to = versionOr404(versions, params.version);
        const selector = query.from ?? "base";
        let from: VersionRow | null = null;
        if (selector === "previous") {
          from = versions.find((version) => version.number === to.number - 1) ?? null;
        } else if (selector === "reviewed") {
          const mark = cx.userId ? await getReviewedMark(found.pull.issueId, cx.userId) : null;
          from =
            mark && mark.lineage === to.lineage
              ? (versions.find((version) => version.number === mark.versionNumber) ?? null)
              : null;
          // Reviewed past the version asked for: nothing of it is new to them.
          if (from && from.number > to.number) from = to;
        } else if (selector !== "base") {
          from = versions.find((version) => version.number === Number(selector)) ?? null;
          if (!from) throw unprocessable("There is no such version to compare from");
          if (from.number > to.number) {
            throw unprocessable("The version to compare from comes after the one asked for");
          }
        }
        const reader = await versionReader(cx, found);
        const answer = await reader.versionDiff(
          { from: from ? sideOf(from) : null, to: sideOf(to) },
          {
            cursor: query.cursor,
            limit: pageSize(query.limit),
            path: query.path,
            context: query.context,
            whitespace: query.whitespace,
          },
        );
        return {
          ...answer.diff,
          kind: from ? ("interdiff" as const) : ("whole" as const),
          from: from?.number ?? null,
          to: to.number,
          rebased: answer.rebased,
          exact: answer.exact,
        };
      }),
    )
    .handle(
      "markReviewed",
      repoOp(async (cx, { params }) => {
        const found = await pageOr404(cx, params.branch);
        const version = versionOr404(await versionsForPull(found.pull), params.version);
        const mark = await setReviewedMark(found.pull.issueId, cx.userId!, version);
        return { version: mark.versionNumber, reviewedAt: iso(mark.reviewedAt) };
      }),
    )
    .handle(
      "branchState",
      repoOp(async (cx, { params }) => branchPageState(cx, await pageOr404(cx, params.branch))),
    ),
);

export const ReviewHandlers = HttpApiBuilder.group(GitApi, "review", (handlers) =>
  handlers.handle(
    "inbox",
    op(async (cx, { query }) => {
      const viewer = await cx.viewer();
      const page = await reviewInbox(
        { ...viewer, userId: cx.userId! },
        { cursor: decodeCursor(query.cursor), limit: pageSize(query.limit) },
      );
      const [person, changes, keys] = await Promise.all([
        peopleById(page.items.map((row) => row.authorUserId)),
        changesSince(
          page.items.map((row) => ({ pullRequestId: row.pullRequestId, at: row.reviewedAt })),
        ),
        pageKeys(page.items.map((row) => ({ issueId: row.pullRequestId }))),
      ]);
      return {
        items: page.items.map((row) => {
          const since = changes.get(row.pullRequestId);
          return {
            repository: {
              id: row.repositoryId,
              owner: row.owner,
              name: row.repositoryName,
              visibility: row.visibility,
            },
            key: keys.get(row.pullRequestId)!,
            number: row.number,
            title: row.title,
            branch: row.branch,
            draft: row.draft,
            author: person(row.authorUserId),
            agent:
              row.agentKind && row.agentName
                ? { kind: row.agentKind, displayName: row.agentName }
                : null,
            latestVersion: row.latestVersion,
            reviewedVersion: row.reviewedVersion,
            waitingSince: isoOrNull(new Date(row.waitingSince))!,
            changes: {
              versions: row.versions,
              comments: since?.comments ?? 0,
              findings: since?.findings ?? 0,
            },
            mustFixOpen: since?.mustFixOpen ?? 0,
          };
        }),
        nextCursor: page.nextCursor,
      };
    }),
  ),
);
