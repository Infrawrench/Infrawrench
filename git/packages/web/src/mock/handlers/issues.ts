import type { ThreadComment } from "@infrawrench/git-contract";
import {
  badRequest,
  defineMockHandlers,
  notFound,
  ok,
  paginate,
  unprocessable,
  type Mutable,
} from "../define";
import { findRepository, requireUser, type RepositoryRecord } from "../db";
import { newId } from "../settings-data";
import {
  anyThread,
  event,
  filterThreads,
  findThread,
  presentComment,
  syncCounts,
  threadsOf,
  timelineOf,
  toIssue,
  toIssueSummary,
  touch,
  viewerOf,
  type ThreadRecord,
} from "../threads-data";
import { applyThreadChange } from "../threads-write";

function commentIn(repo: RepositoryRecord, commentId: string) {
  for (const thread of threadsOf(repo).threads) {
    const index = thread.items.findIndex(
      (item) => item.type === "comment" && item.id === commentId,
    );
    const item = thread.items[index];
    if (item && item.type === "comment") {
      return { thread, index, comment: item.comment as Mutable<ThreadComment> };
    }
  }
  throw notFound("Comment not found");
}

const commentsOf = (repo: RepositoryRecord, thread: ThreadRecord) =>
  thread.items.flatMap((item) =>
    item.type === "comment" ? [presentComment(repo, thread, item.comment)] : [],
  );

export default defineMockHandlers({
  issues: {
    list: ({ params, query }) => {
      const repo = findRepository(params.owner, params.repo);
      const issues = threadsOf(repo).threads.filter((thread) => thread.page === null);
      const matching = filterThreads(repo, issues, query ?? {});
      const state = query?.state ?? "open";
      const shown = state === "all" ? matching : matching.filter((t) => t.state === state);
      return {
        ...paginate(
          shown.map((thread) => toIssueSummary(repo, thread)),
          query,
        ),
        counts: {
          open: matching.filter((thread) => thread.state === "open").length,
          closed: matching.filter((thread) => thread.state === "closed").length,
        },
      };
    },
    create: ({ params, payload }) => {
      const repo = findRepository(params.owner, params.repo);
      const author = requireUser();
      if (payload.title.trim() === "") throw badRequest("A title is required");
      const store = threadsOf(repo);
      const now = new Date().toISOString();
      const thread: ThreadRecord = {
        id: newId("thread"),
        number: store.nextNumber++,
        title: payload.title.trim(),
        body: payload.body ?? "",
        bodyEditedAt: null,
        author,
        labelIds: [],
        assignees: [],
        milestone: null,
        state: "open",
        stateReason: null,
        locked: false,
        lockReason: null,
        createdAt: now,
        updatedAt: now,
        closedAt: null,
        closedBy: null,
        items: [],
        page: null,
      };
      store.threads.push(thread);
      if (viewerOf(repo).canTriage) {
        applyThreadChange(repo, thread, {
          labels: payload.labels,
          assignees: payload.assignees,
          milestone: payload.milestone,
        });
      }
      syncCounts(repo);
      return toIssue(repo, thread);
    },
    get: ({ params }) => {
      const repo = findRepository(params.owner, params.repo);
      return toIssue(repo, findThread(repo, params.number, false));
    },
    update: ({ params, payload }) => {
      const repo = findRepository(params.owner, params.repo);
      const thread = findThread(repo, params.number, false);
      applyThreadChange(repo, thread, payload);
      return toIssue(repo, thread);
    },
    lock: ({ params, payload }) => {
      const repo = findRepository(params.owner, params.repo);
      const thread = anyThread(repo, params.number);
      thread.locked = true;
      thread.lockReason = payload.reason ?? null;
      thread.items.push(
        event("locked", requireUser(), new Date().toISOString(), { reason: thread.lockReason }),
      );
      touch(thread);
      return ok;
    },
    unlock: ({ params }) => {
      const repo = findRepository(params.owner, params.repo);
      const thread = anyThread(repo, params.number);
      thread.locked = false;
      thread.lockReason = null;
      thread.items.push(event("unlocked", requireUser(), new Date().toISOString(), {}));
      touch(thread);
      return ok;
    },
    timeline: ({ params, query }) => {
      const repo = findRepository(params.owner, params.repo);
      return paginate(timelineOf(repo, anyThread(repo, params.number)), query);
    },
    listComments: ({ params, query }) => {
      const repo = findRepository(params.owner, params.repo);
      return paginate(commentsOf(repo, anyThread(repo, params.number)), query);
    },
    createComment: ({ params, payload }) => {
      const repo = findRepository(params.owner, params.repo);
      const author = requireUser();
      const thread = anyThread(repo, params.number);
      if (thread.locked && !viewerOf(repo).canTriage) {
        throw unprocessable("This conversation is locked", "locked");
      }
      const id = newId("c");
      const now = new Date().toISOString();
      const comment = {
        id,
        author,
        body: payload.body,
        createdAt: now,
        updatedAt: now,
        edited: false,
        authorAccess: null,
        viewerCanEdit: true,
        viewerCanDelete: true,
      };
      thread.items.push({ type: "comment", id, comment });
      touch(thread);
      return presentComment(repo, thread, comment);
    },
    updateComment: ({ params, payload }) => {
      const repo = findRepository(params.owner, params.repo);
      requireUser();
      const found = commentIn(repo, params.commentId);
      found.comment.body = payload.body;
      found.comment.edited = true;
      found.comment.updatedAt = new Date().toISOString();
      return presentComment(repo, found.thread, found.comment);
    },
    deleteComment: ({ params }) => {
      const repo = findRepository(params.owner, params.repo);
      requireUser();
      const found = commentIn(repo, params.commentId);
      found.thread.items.splice(found.index, 1);
      return ok;
    },
  },
});
