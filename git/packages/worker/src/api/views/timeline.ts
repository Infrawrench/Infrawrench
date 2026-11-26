/**
 * A thread's timeline: its comments, its events and, for a pull request, its
 * reviews, interleaved oldest first and paged by one `(time, id)` cursor.
 */
import type { CommitSummary, TimelineItem } from "@infrawrench/git-contract";
import { decodeCursor, encodeCursor, pageSize } from "../../db/cursor";
import {
  type PullRequestWithThread,
  listReviewComments,
  listReviews,
  pullRequestsFor,
} from "../../db/pulls";
import { getRepositoryById } from "../../db/repositories";
import {
  type CommentRow,
  type IssueRow,
  type TimelineEventRow,
  listComments,
  listTimelineEvents,
  threadsById,
} from "../../db/threads";
import type { ReviewRow } from "../../db/pulls";
import { RepoReaderError } from "../../repo/reader";
import type { RepoCx } from "../context";
import { commitDecorator } from "./commits";
import { reviewThreadViews, reviewViews } from "./pulls";
import { iso, peopleById } from "./repositories";
import { commentViews } from "./threads";

type Entry =
  | { readonly kind: "comment"; readonly at: Date; readonly id: string; readonly row: CommentRow }
  | {
      readonly kind: "event";
      readonly at: Date;
      readonly id: string;
      readonly row: TimelineEventRow;
    }
  | { readonly kind: "review"; readonly at: Date; readonly id: string; readonly row: ReviewRow };

const OID = /^[0-9a-f]{40}$/;

export const timelinePage = async (
  cx: RepoCx,
  thread: IssueRow,
  pull: PullRequestWithThread | null,
  query: { readonly cursor?: string; readonly limit?: number },
): Promise<{ items: TimelineItem[]; nextCursor: string | null }> => {
  const limit = pageSize(query.limit);
  const cursor = decodeCursor(query.cursor);
  const after = (at: Date, id: string) =>
    cursor === null || at.getTime() > cursor.at || (at.getTime() === cursor.at && id > cursor.id);

  const [comments, events, reviews, reviewComments] = await Promise.all([
    listComments(thread.id, { cursor: query.cursor, limit }),
    listTimelineEvents(thread.id, { cursor: query.cursor, limit }),
    pull ? listReviews(pull.pull.issueId, null) : Promise.resolve([]),
    pull ? listReviewComments(pull.pull.issueId, cx.userId) : Promise.resolve([]),
  ]);

  const entries: Entry[] = [
    ...comments.items.map((row) => ({
      kind: "comment" as const,
      at: row.createdAt,
      id: row.id,
      row,
    })),
    ...events.items.map((row) => ({ kind: "event" as const, at: row.createdAt, id: row.id, row })),
    ...reviews
      .map((row) => ({
        kind: "review" as const,
        at: row.submittedAt ?? row.createdAt,
        id: row.id,
        row,
      }))
      .filter((entry) => after(entry.at, entry.id)),
  ].sort((a, b) => a.at.getTime() - b.at.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const shown = entries.slice(0, limit);
  const last = shown[shown.length - 1];
  const more = entries.length > limit || comments.nextCursor !== null || events.nextCursor !== null;

  // Everything the shown entries name, looked up once.
  const shownEvents = shown.flatMap((entry) => (entry.kind === "event" ? [entry.row] : []));
  const oids = [
    ...new Set(
      shownEvents
        .flatMap((row) => [...(row.payload.commitOids ?? []), row.payload.commitOid])
        .filter((oid): oid is string => typeof oid === "string" && OID.test(oid)),
    ),
  ];
  let commits: readonly CommitSummary[] = [];
  if (oids.length > 0) {
    try {
      commits = await cx.git.commits(oids);
    } catch (error) {
      // Without the storage the entries that show commits are left out.
      if (!(error instanceof RepoReaderError)) throw error;
    }
  }
  const sourceIds = shownEvents.flatMap((row) =>
    row.payload.sourceIssueId ? [row.payload.sourceIssueId] : [],
  );
  const [decorate, person, commentItems, reviewItems, threads, sources, sourcePulls] =
    await Promise.all([
      commitDecorator(cx.repo.repository.id, commits),
      peopleById(shownEvents.flatMap((row) => [row.actorUserId, row.payload.assigneeUserId])),
      commentViews(
        cx,
        thread,
        shown.flatMap((entry) => (entry.kind === "comment" ? [entry.row] : [])),
      ),
      pull
        ? reviewViews(
            cx,
            pull,
            shown.flatMap((entry) => (entry.kind === "review" ? [entry.row] : [])),
            reviewComments,
          )
        : Promise.resolve([]),
      pull ? reviewThreadViews(cx, pull, reviewComments) : Promise.resolve([]),
      threadsById(sourceIds),
      pullRequestsFor(sourceIds),
    ]);
  const commitByOid = new Map(commits.map((commit) => [commit.oid, decorate(commit)]));
  const commentById = new Map(commentItems.map((comment) => [comment.id, comment]));
  const reviewById = new Map(reviewItems.map((review) => [review.id, review]));
  const rootReview = new Map(
    reviewComments
      .filter((comment) => comment.inReplyToId === null)
      .map((comment) => [comment.id, comment.reviewId]),
  );
  const sourceRepositories = new Map<string, { owner: string; name: string }>();
  for (const source of sources.values()) {
    if (sourceRepositories.has(source.repositoryId)) continue;
    const found =
      source.repositoryId === cx.repo.repository.id
        ? cx.repo
        : await getRepositoryById(source.repositoryId);
    // A mention from a private repository is only shown where it is this one.
    if (found && (found === cx.repo || found.repository.visibility === "public")) {
      sourceRepositories.set(source.repositoryId, {
        owner: found.owner.slug,
        name: found.repository.name,
      });
    }
  }

  const eventItem = (row: TimelineEventRow): TimelineItem | null => {
    const base = { id: row.id, actor: person(row.actorUserId), createdAt: iso(row.createdAt) };
    const payload = row.payload;
    switch (row.type) {
      case "labeled":
      case "unlabeled":
        return {
          type: row.type,
          ...base,
          label: {
            id: payload.labelId ?? "",
            name: payload.labelName ?? "",
            color: payload.labelColor ?? "888888",
            description: null,
          },
        };
      case "assigned":
      case "unassigned":
        return { type: row.type, ...base, assignee: person(payload.assigneeUserId) };
      case "milestoned":
      case "demilestoned":
        return { type: row.type, ...base, milestoneTitle: payload.milestoneTitle ?? "" };
      case "renamed":
      case "base_changed":
        return { type: row.type, ...base, from: payload.from ?? "", to: payload.to ?? "" };
      case "closed":
        return {
          type: "closed",
          ...base,
          stateReason: payload.stateReason ?? null,
          commitOid: payload.commitOid ?? null,
        };
      case "reopened":
      case "unlocked":
      case "ready_for_review":
      case "converted_to_draft":
        return { type: row.type, ...base };
      case "locked":
        return { type: "locked", ...base, reason: payload.lockReason ?? null };
      case "referenced": {
        const commit = payload.commitOid ? commitByOid.get(payload.commitOid) : undefined;
        return commit ? { type: "referenced", ...base, commit } : null;
      }
      case "cross_referenced": {
        const source = payload.sourceIssueId ? sources.get(payload.sourceIssueId) : undefined;
        const repository = source ? sourceRepositories.get(source.repositoryId) : undefined;
        if (!source || !repository) return null;
        const sourcePull = sourcePulls.get(source.id);
        return {
          type: "cross_referenced",
          ...base,
          source: {
            repository,
            number: source.number,
            title: source.title,
            isPullRequest: source.isPullRequest,
            state: sourcePull?.mergedAt ? "merged" : source.state,
          },
        };
      }
      case "merged":
        return payload.commitOid && payload.mergeMethod
          ? {
              type: "merged",
              ...base,
              commitOid: payload.commitOid,
              method: payload.mergeMethod,
              baseRef: payload.ref ?? "",
            }
          : null;
      case "committed": {
        const pushed = (payload.commitOids ?? []).flatMap((oid) => commitByOid.get(oid) ?? []);
        return pushed.length > 0
          ? { type: "commits", id: row.id, createdAt: iso(row.createdAt), commits: pushed }
          : null;
      }
      case "head_force_pushed":
        return payload.beforeOid && payload.afterOid
          ? {
              type: "head_force_pushed",
              ...base,
              beforeOid: payload.beforeOid,
              afterOid: payload.afterOid,
            }
          : null;
      case "head_branch_deleted":
      case "head_branch_restored":
        return { type: row.type, ...base, ref: payload.ref ?? "" };
      case "review_dismissed":
        return {
          type: "review_dismissed",
          ...base,
          reviewId: payload.reviewId ?? "",
          reason: payload.reason ?? null,
        };
      case "terraform_run":
        return payload.terraformRunId && payload.terraformOutcome
          ? {
              type: "terraform_run",
              ...base,
              runId: payload.terraformRunId,
              workspace: payload.terraformWorkspace ?? "",
              operation: payload.terraformKind ?? "plan",
              outcome: payload.terraformOutcome,
              add: payload.terraformAdd ?? null,
              change: payload.terraformChange ?? null,
              destroy: payload.terraformDestroy ?? null,
              reason: payload.reason ?? null,
            }
          : null;
    }
  };

  const items = shown.flatMap((entry): TimelineItem[] => {
    if (entry.kind === "comment") {
      const comment = commentById.get(entry.id);
      return comment ? [{ type: "comment", id: entry.id, comment }] : [];
    }
    if (entry.kind === "review") {
      const review = reviewById.get(entry.id);
      return review
        ? [
            {
              type: "review",
              id: entry.id,
              review,
              threads: threads.filter((item) => rootReview.get(item.id) === entry.id),
            },
          ]
        : [];
    }
    const item = eventItem(entry.row);
    return item ? [item] : [];
  });

  return {
    items,
    nextCursor: more && last ? encodeCursor({ at: last.at.getTime(), id: last.id }) : null,
  };
};
