/**
 * Issues, the comments and timeline every thread has (a branch page's
 * too), labels and milestones.
 */
import { HttpApiBuilder } from "effect/http-api";
import {
  GitApi,
  badRequest,
  conflict,
  forbidden,
  notFound,
  ok,
  unprocessable,
} from "@infrawrench/git-contract";
import { db } from "../../db/client";
import { getPullRequest } from "../../db/pulls";
import {
  type IssueRow,
  addComment,
  addTimelineEvent,
  countThreads,
  createIssue,
  createLabel,
  createMilestone,
  deleteComment,
  deleteLabel,
  deleteMilestone,
  editComment,
  getComment,
  getMilestone,
  getThread,
  listComments,
  listLabels,
  listMilestones,
  listThreads,
  setThreadLock,
  threadsById,
  updateLabel,
  updateMilestone,
} from "../../db/threads";
import { userByUsername } from "../../db/users";
import { type RepoCx, repoOp } from "../context";
import {
  applyState,
  applyText,
  applyTriage,
  canTriage,
  hasTriageEdit,
  isAuthor,
  labelIdsFor,
  milestoneIdFor,
  noteMentions,
  userIdsFor,
} from "../thread-edits";
import {
  commentViews,
  issueDetail,
  issueSummaries,
  labelView,
  mayChangeOwn,
  milestoneView,
} from "../views/threads";
import { timelinePage } from "../views/timeline";

/** `#number`, whichever kind it is, or a 404. */
export const threadOr404 = async (cx: RepoCx, number: number): Promise<IssueRow> => {
  const thread = await getThread(cx.repo.repository.id, number);
  if (!thread) throw notFound("No such issue or branch page");
  return thread;
};

const issueOr404 = async (cx: RepoCx, number: number): Promise<IssueRow> => {
  const thread = await getThread(cx.repo.repository.id, number);
  if (!thread || thread.isPullRequest) throw notFound("No such issue");
  return thread;
};

export interface ThreadFilterQuery {
  readonly label?: string;
  readonly assignee?: string;
  readonly author?: string;
  readonly milestone?: string;
  readonly q?: string;
  readonly sort?: "created" | "updated" | "comments";
  readonly direction?: "asc" | "desc";
  readonly cursor?: string;
  readonly limit?: number;
}

/** A filter that names something that does not exist matches nothing. */
const NOTHING = "00000000-0000-0000-0000-000000000000";

/** The list filters issues and branch pages share, resolved to ids. */
export const threadFilters = async (cx: RepoCx, query: ThreadFilterQuery) => {
  const repositoryId = cx.repo.repository.id;
  const person = async (name: string | undefined): Promise<string | undefined> => {
    if (name === undefined) return undefined;
    if (name === "@me") return cx.userId ?? NOTHING;
    return (await userByUsername(name))?.id ?? NOTHING;
  };
  const labelNames = (query.label ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const labels =
    labelNames.length === 0
      ? undefined
      : await labelIdsFor(repositoryId, labelNames).catch(() => [NOTHING]);
  const milestone =
    query.milestone === undefined
      ? undefined
      : query.milestone === "none"
        ? ("none" as const)
        : ((await getMilestone(repositoryId, Number(query.milestone)))?.id ?? NOTHING);
  return {
    repositoryId,
    authorUserId: await person(query.author),
    assignee: query.assignee === "none" ? ("none" as const) : await person(query.assignee),
    milestoneId: milestone,
    labelIds: labels,
    q: query.q,
  };
};

export const pageInput = (query: ThreadFilterQuery) => ({
  sort: query.sort,
  direction: query.direction,
  cursor: query.cursor,
  limit: query.limit,
});

const isDate = (value: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));

const checkDueOn = (dueOn: string | null | undefined): void => {
  if (typeof dueOn === "string" && !isDate(dueOn)) throw badRequest("The due date is YYYY-MM-DD");
};

export const IssuesHandlers = HttpApiBuilder.group(GitApi, "issues", (handlers) =>
  handlers
    .handle(
      "list",
      repoOp(async (cx, { query }) => {
        const filters = { ...(await threadFilters(cx, query)), isPullRequest: false };
        const [found, counts] = await Promise.all([
          listThreads({ ...filters, ...pageInput(query), state: query.state ?? "open" }),
          countThreads(filters),
        ]);
        return {
          items: await issueSummaries(found.items),
          nextCursor: found.nextCursor,
          counts,
        };
      }),
    )
    .handle(
      "create",
      repoOp(async (cx, { payload }) => {
        const { repository } = cx.repo;
        if (!repository.hasIssues) throw unprocessable("Issues are switched off here");
        const triage = canTriage(cx);
        // Labels, assignees and a milestone from someone without triage are left out, not refused.
        const issue = await createIssue({
          repositoryId: repository.id,
          title: payload.title,
          body: payload.body ?? "",
          authorUserId: cx.userId,
          labelIds:
            triage && payload.labels ? await labelIdsFor(repository.id, payload.labels) : [],
          assigneeUserIds: triage && payload.assignees ? await userIdsFor(payload.assignees) : [],
          milestoneId:
            triage && payload.milestone !== undefined
              ? await milestoneIdFor(repository.id, payload.milestone)
              : null,
        });
        await noteMentions(issue, `${issue.title}\n${issue.body}`, cx.userId);
        return issueDetail(cx, issue);
      }),
    )
    .handle(
      "get",
      repoOp(async (cx, { params }) => issueDetail(cx, await issueOr404(cx, params.number))),
    )
    .handle(
      "update",
      repoOp(async (cx, { params, payload }) => {
        const issue = await issueOr404(cx, params.number);
        const own = isAuthor(cx, issue);
        if (!own && !canTriage(cx))
          throw forbidden("Only its author or a maintainer can edit this");
        if (hasTriageEdit(payload) && !canTriage(cx)) {
          throw forbidden("Labels, assignees and milestones need triage access");
        }
        await applyText(cx, issue, payload);
        await applyTriage(cx, issue, payload);
        if (payload.state !== undefined && payload.state !== issue.state) {
          await applyState(issue, payload.state, {
            userId: cx.userId,
            reason: payload.state === "closed" ? (payload.stateReason ?? "completed") : null,
          });
        }
        return issueDetail(cx, await issueOr404(cx, params.number));
      }),
    )
    .handle(
      "lock",
      repoOp(async (cx, { params, payload }) => {
        const thread = await threadOr404(cx, params.number);
        const reason = payload.reason ?? null;
        if (!thread.locked || thread.lockReason !== reason) {
          await setThreadLock(thread.id, true, reason);
          if (!thread.locked) {
            await addTimelineEvent(db, {
              issueId: thread.id,
              repositoryId: thread.repositoryId,
              actorUserId: cx.userId,
              type: "locked",
              payload: { lockReason: reason },
            });
          }
        }
        return ok;
      }),
    )
    .handle(
      "unlock",
      repoOp(async (cx, { params }) => {
        const thread = await threadOr404(cx, params.number);
        if (thread.locked) {
          await setThreadLock(thread.id, false, null);
          await addTimelineEvent(db, {
            issueId: thread.id,
            repositoryId: thread.repositoryId,
            actorUserId: cx.userId,
            type: "unlocked",
          });
        }
        return ok;
      }),
    )
    .handle(
      "timeline",
      repoOp(async (cx, { params, query }) => {
        const thread = await threadOr404(cx, params.number);
        const pull = thread.isPullRequest
          ? await getPullRequest(cx.repo.repository.id, thread.number)
          : null;
        return timelinePage(cx, thread, pull, query);
      }),
    )
    .handle(
      "listComments",
      repoOp(async (cx, { params, query }) => {
        const thread = await threadOr404(cx, params.number);
        const found = await listComments(thread.id, query);
        return {
          items: await commentViews(cx, thread, found.items),
          nextCursor: found.nextCursor,
        };
      }),
    )
    .handle(
      "createComment",
      repoOp(async (cx, { params, payload }) => {
        const thread = await threadOr404(cx, params.number);
        if (thread.locked && !canTriage(cx)) {
          throw unprocessable("This conversation is locked", "locked");
        }
        const comment = await addComment({
          issueId: thread.id,
          repositoryId: thread.repositoryId,
          authorUserId: cx.userId,
          body: payload.body,
        });
        await noteMentions(thread, payload.body, cx.userId);
        const [view] = await commentViews(cx, thread, [comment]);
        return view!;
      }),
    )
    .handle(
      "updateComment",
      repoOp(async (cx, { params, payload }) => {
        const comment = await getComment(cx.repo.repository.id, params.commentId);
        if (!comment) throw notFound("No such comment");
        if (!mayChangeOwn(cx, comment.authorUserId)) {
          throw forbidden("Only its author or a maintainer can edit this comment");
        }
        const edited = (await editComment(comment.id, payload.body)) ?? comment;
        const thread = (await threadsById([comment.issueId])).get(comment.issueId);
        if (!thread) throw notFound("No such comment");
        const [view] = await commentViews(cx, thread, [edited]);
        return view!;
      }),
    )
    .handle(
      "deleteComment",
      repoOp(async (cx, { params }) => {
        const comment = await getComment(cx.repo.repository.id, params.commentId);
        if (!comment) throw notFound("No such comment");
        if (!mayChangeOwn(cx, comment.authorUserId)) {
          throw forbidden("Only its author or a maintainer can delete this comment");
        }
        await deleteComment(comment.id);
        return ok;
      }),
    ),
);

export const LabelsHandlers = HttpApiBuilder.group(GitApi, "labels", (handlers) =>
  handlers
    .handle(
      "list",
      repoOp(async (cx) => ({
        labels: (await listLabels(cx.repo.repository.id)).map(labelView),
      })),
    )
    .handle(
      "create",
      repoOp(async (cx, { payload }) => {
        const label = await createLabel({ repositoryId: cx.repo.repository.id, ...payload });
        if (!label) throw conflict("A label with that name exists", "name_taken");
        return labelView(label);
      }),
    )
    .handle(
      "update",
      repoOp(async (cx, { params, payload }) => {
        const label = await updateLabel(cx.repo.repository.id, params.labelId, payload);
        if (label === null) throw notFound("No such label");
        if (label === "conflict") throw conflict("A label with that name exists", "name_taken");
        return labelView(label);
      }),
    )
    .handle(
      "delete",
      repoOp(async (cx, { params }) => {
        if (!(await deleteLabel(cx.repo.repository.id, params.labelId))) {
          throw notFound("No such label");
        }
        return ok;
      }),
    ),
);

const milestoneOr404 = async (cx: RepoCx, number: number) => {
  const milestone = await getMilestone(cx.repo.repository.id, number);
  if (!milestone) throw notFound("No such milestone");
  return milestone;
};

export const MilestonesHandlers = HttpApiBuilder.group(GitApi, "milestones", (handlers) =>
  handlers
    .handle(
      "list",
      repoOp(async (cx, { query }) => ({
        milestones: (await listMilestones(cx.repo.repository.id, query.state ?? "open")).map(
          milestoneView,
        ),
      })),
    )
    .handle(
      "create",
      repoOp(async (cx, { payload }) => {
        checkDueOn(payload.dueOn);
        return milestoneView(
          await createMilestone({ repositoryId: cx.repo.repository.id, ...payload }),
        );
      }),
    )
    .handle(
      "get",
      repoOp(async (cx, { params }) => milestoneView(await milestoneOr404(cx, params.milestone))),
    )
    .handle(
      "update",
      repoOp(async (cx, { params, payload }) => {
        checkDueOn(payload.dueOn);
        const milestone = await milestoneOr404(cx, params.milestone);
        return milestoneView((await updateMilestone(milestone.id, payload)) ?? milestone);
      }),
    )
    .handle(
      "delete",
      repoOp(async (cx, { params }) => {
        const milestone = await milestoneOr404(cx, params.milestone);
        await deleteMilestone(milestone.id);
        return ok;
      }),
    ),
);
