/**
 * `/api/repos/:owner/:repo/pulls`: pull requests, their diff and commits,
 * reviews and review threads, and merging.
 *
 * A pull request's conversation (comments, timeline, labels, lock) is its
 * issue half: `issues.createComment`, `issues.timeline` and `issues.lock`
 * take its number. Everything here is what only a pull request has.
 */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { HandlerGate, RequiredAccess, RequiresUser, SuccessDescription } from "../http/annotations";
import { Authentication, RepositoryAccess } from "../http/auth";
import { BadRequest, Conflict, UnprocessableEntity } from "../http/errors";
import { NumberParams, Oid, Ok, Page, PageQuery, QueryFlag, RepoParams } from "../schemas/common";
import { CommitSummary, Diff, DiffQuery } from "../schemas/git";
import {
  MergeRequest,
  MergeResult,
  Mergeability,
  PullRequest,
  PullRequestCreate,
  PullRequestSummary,
  PullRequestUpdate,
  Review,
  ReviewComment,
  ReviewCommentCreate,
  ReviewCreate,
  ReviewSubmit,
  ReviewThread,
  ThreadCounts,
  CommentWrite,
} from "../schemas/threads";
import { threadFilterQuery } from "./issues";

const ReviewParams = { ...NumberParams, reviewId: Schema.String } as const;
const ReviewCommentParams = { ...RepoParams, commentId: Schema.String } as const;
const ThreadParams = { ...RepoParams, threadId: Schema.String } as const;

export class PullsGroup extends HttpApiGroup.make("pulls")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: RepoParams,
      query: {
        ...threadFilterQuery,
        state: Schema.optionalKey(
          Schema.Literals(["open", "closed", "merged", "all"]).annotate({
            description: "`closed` includes merged ones. Default `open`.",
          }),
        ),
        base: Schema.optionalKey(Schema.String.annotate({ description: "A base branch." })),
        head: Schema.optionalKey(
          Schema.String.annotate({
            description: "A head branch, or `owner:branch` for one in a fork.",
          }),
        ),
        draft: Schema.optionalKey(QueryFlag),
        reviewer: Schema.optionalKey(
          Schema.String.annotate({ description: "Reviewed by this username, or `@me`." }),
        ),
      },
      success: Schema.Struct({ ...Page(PullRequestSummary).fields, counts: ThreadCounts }),
    })
      .annotate(RequiredAccess, "read")
      .annotate(OpenApi.Summary, "List pull requests")
      .annotate(SuccessDescription, "Pull requests"),
    HttpApiEndpoint.post("create", "/", {
      params: RepoParams,
      payload: PullRequestCreate,
      success: PullRequest,
      error: [BadRequest, Conflict, UnprocessableEntity],
    })
      .annotate(RequiredAccess, "read")
      .annotate(RequiresUser, true)
      .annotate(
        HandlerGate,
        "Read access to the base repository and to the head repository, which is in the base's fork network and, when private, only proposed to a private base of the same owner; `write` is not needed to propose.",
      )
      .annotate(OpenApi.Summary, "Open a pull request")
      .annotate(
        OpenApi.Description,
        "409 `pull_request_exists` when one is already open for the same base and head; 422 `no_commits_between`, `ref_not_found`.",
      )
      .annotate(SuccessDescription, "The pull request"),
    HttpApiEndpoint.get("get", "/:number", { params: NumberParams, success: PullRequest })
      .annotate(RequiredAccess, "read")
      .annotate(OpenApi.Summary, "A pull request")
      .annotate(SuccessDescription, "The pull request, with its mergeability"),
    HttpApiEndpoint.patch("update", "/:number", {
      params: NumberParams,
      payload: PullRequestUpdate,
      success: PullRequest,
      error: [BadRequest, UnprocessableEntity],
    })
      .annotate(RequiredAccess, "read")
      .annotate(RequiresUser, true)
      .annotate(
        HandlerGate,
        "Title, body and base: the author or `write`. Labels, assignees, milestone: `triage`.",
      )
      .annotate(OpenApi.Summary, "Edit a pull request")
      .annotate(SuccessDescription, "The pull request"),
    HttpApiEndpoint.post("close", "/:number/close", {
      params: NumberParams,
      success: PullRequest,
      error: UnprocessableEntity,
    })
      .annotate(RequiredAccess, "read")
      .annotate(RequiresUser, true)
      .annotate(HandlerGate, "The author, or `triage`.")
      .annotate(OpenApi.Summary, "Close a pull request without merging")
      .annotate(SuccessDescription, "The pull request"),
    HttpApiEndpoint.post("reopen", "/:number/reopen", {
      params: NumberParams,
      success: PullRequest,
      error: UnprocessableEntity,
    })
      .annotate(RequiredAccess, "read")
      .annotate(RequiresUser, true)
      .annotate(HandlerGate, "The author, or `triage`.")
      .annotate(OpenApi.Summary, "Reopen a closed pull request")
      .annotate(
        OpenApi.Description,
        "422 `already_merged`, or `ref_not_found` when its head branch is gone.",
      )
      .annotate(SuccessDescription, "The pull request"),
    HttpApiEndpoint.put("setDraft", "/:number/draft", {
      params: NumberParams,
      payload: Schema.Struct({ draft: Schema.Boolean }),
      success: PullRequest,
      error: UnprocessableEntity,
    })
      .annotate(RequiredAccess, "read")
      .annotate(RequiresUser, true)
      .annotate(HandlerGate, "The author, or `write`.")
      .annotate(OpenApi.Summary, "Mark a pull request as a draft, or as ready for review")
      .annotate(SuccessDescription, "The pull request"),
    HttpApiEndpoint.get("files", "/:number/files", {
      params: NumberParams,
      query: {
        ...PageQuery,
        ...DiffQuery,
        since: Schema.optionalKey(
          Oid.annotate({
            description:
              'Only what changed after this head, for "changes since my last review". Omitted: the whole pull request.',
          }),
        ),
      },
      success: Diff,
    })
      .annotate(RequiredAccess, "read")
      .annotate(OpenApi.Summary, "A pull request's diff, with hunks")
      .annotate(SuccessDescription, "The diff from the merge base to the head"),
    HttpApiEndpoint.get("commits", "/:number/commits", {
      params: NumberParams,
      query: PageQuery,
      success: Page(CommitSummary),
    })
      .annotate(RequiredAccess, "read")
      .annotate(OpenApi.Summary, "A pull request's commits")
      .annotate(SuccessDescription, "Commits, oldest first"),
    HttpApiEndpoint.get("mergeability", "/:number/mergeability", {
      params: NumberParams,
      success: Mergeability,
    })
      .annotate(RequiredAccess, "read")
      .annotate(OpenApi.Summary, "Whether a pull request can merge, and why not")
      .annotate(
        OpenApi.Description,
        "The same block `get` carries, on its own so the merge box can poll while `state` is `checking`.",
      )
      .annotate(SuccessDescription, "Mergeability"),
    HttpApiEndpoint.post("merge", "/:number/merge", {
      params: NumberParams,
      payload: MergeRequest,
      success: MergeResult,
      error: [BadRequest, Conflict, UnprocessableEntity],
    })
      .annotate(RequiredAccess, "write")
      .annotate(OpenApi.Summary, "Merge a pull request")
      .annotate(
        OpenApi.Description,
        "409 `head_moved` when `expectedHeadOid` is stale. 422 with the first blocker as `code`: `merge_conflict`, `checks_required`, `approvals_required`, `changes_requested`, `draft`, `already_merged`, `protected_branch`, `merge_method_not_allowed`.",
      )
      .annotate(SuccessDescription, "Merged"),
    HttpApiEndpoint.post("updateBranch", "/:number/update-branch", {
      params: NumberParams,
      payload: Schema.Struct({
        method: Schema.optionalKey(
          Schema.Literals(["merge", "rebase"]).annotate({
            description: "Merge the base into the head (default), or rebase the head onto it.",
          }),
        ),
        expectedHeadOid: Schema.optionalKey(Oid),
      }),
      success: Schema.Struct({ headOid: Oid }),
      error: [BadRequest, Conflict, UnprocessableEntity],
    })
      .annotate(RequiredAccess, "read")
      .annotate(RequiresUser, true)
      .annotate(HandlerGate, "`write` on the head repository.")
      .annotate(OpenApi.Summary, "Bring a pull request's head up to date with its base")
      .annotate(SuccessDescription, "The head's new commit"),
    HttpApiEndpoint.post("restoreBranch", "/:number/restore-branch", {
      params: NumberParams,
      success: Schema.Struct({ ref: Schema.String, oid: Oid }),
      error: [Conflict, UnprocessableEntity],
    })
      .annotate(RequiredAccess, "read")
      .annotate(RequiresUser, true)
      .annotate(HandlerGate, "`write` on the head repository.")
      .annotate(OpenApi.Summary, "Restore a pull request's deleted head branch")
      .annotate(SuccessDescription, "The branch"),
    HttpApiEndpoint.get("listReviews", "/:number/reviews", {
      params: NumberParams,
      success: Schema.Struct({ reviews: Schema.Array(Review) }),
    })
      .annotate(RequiredAccess, "read")
      .annotate(OpenApi.Summary, "A pull request's reviews")
      .annotate(
        OpenApi.Description,
        "Submitted reviews, oldest first, plus the caller's own pending one.",
      )
      .annotate(SuccessDescription, "Reviews"),
    HttpApiEndpoint.post("createReview", "/:number/reviews", {
      params: NumberParams,
      payload: ReviewCreate,
      success: Review,
      error: [BadRequest, UnprocessableEntity],
    })
      .annotate(RequiredAccess, "read")
      .annotate(RequiresUser, true)
      .annotate(OpenApi.Summary, "Review a pull request")
      .annotate(
        OpenApi.Description,
        "With `event`, submitted at once. Without, the caller's pending review is started or added to. An author cannot approve or request changes on their own pull request (422).",
      )
      .annotate(SuccessDescription, "The review"),
    HttpApiEndpoint.post("submitReview", "/:number/reviews/:reviewId/submit", {
      params: ReviewParams,
      payload: ReviewSubmit,
      success: Review,
      error: [BadRequest, UnprocessableEntity],
    })
      .annotate(RequiredAccess, "read")
      .annotate(RequiresUser, true)
      .annotate(HandlerGate, "The review's author.")
      .annotate(OpenApi.Summary, "Submit a pending review")
      .annotate(SuccessDescription, "The review"),
    HttpApiEndpoint.delete("discardReview", "/:number/reviews/:reviewId", {
      params: ReviewParams,
      success: Ok,
      error: UnprocessableEntity,
    })
      .annotate(RequiredAccess, "read")
      .annotate(RequiresUser, true)
      .annotate(HandlerGate, "The review's author, while it is pending.")
      .annotate(OpenApi.Summary, "Discard a pending review and its comments")
      .annotate(SuccessDescription, "Discarded"),
    HttpApiEndpoint.put("dismissReview", "/:number/reviews/:reviewId/dismiss", {
      params: ReviewParams,
      payload: Schema.Struct({
        reason: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
      }),
      success: Review,
      error: [BadRequest, UnprocessableEntity],
    })
      .annotate(RequiredAccess, "write")
      .annotate(OpenApi.Summary, "Dismiss an approval or a request for changes")
      .annotate(SuccessDescription, "The review, dismissed"),
    HttpApiEndpoint.get("listThreads", "/:number/threads", {
      params: NumberParams,
      success: Schema.Struct({ threads: Schema.Array(ReviewThread) }),
    })
      .annotate(RequiredAccess, "read")
      .annotate(OpenApi.Summary, "A pull request's review threads")
      .annotate(
        OpenApi.Description,
        "Every thread on the diff, outdated and resolved ones included, in file then line order. The files view places them by `path`, `side` and `line`.",
      )
      .annotate(SuccessDescription, "Review threads"),
    HttpApiEndpoint.post("createReviewComment", "/:number/comments", {
      params: NumberParams,
      payload: ReviewCommentCreate,
      success: Schema.Struct({ thread: ReviewThread, comment: ReviewComment }),
      error: [BadRequest, UnprocessableEntity],
    })
      .annotate(RequiredAccess, "read")
      .annotate(RequiresUser, true)
      .annotate(OpenApi.Summary, "Comment on lines of a pull request's diff, or reply in a thread")
      .annotate(
        OpenApi.Description,
        "A new thread needs `path`, `line` and `side`, on lines the diff shows (422 otherwise); a reply needs `inReplyTo`.",
      )
      .annotate(SuccessDescription, "The comment and its thread"),
    HttpApiEndpoint.patch("updateReviewComment", "/comments/:commentId", {
      params: ReviewCommentParams,
      payload: CommentWrite,
      success: ReviewComment,
      error: BadRequest,
    })
      .annotate(RequiredAccess, "read")
      .annotate(RequiresUser, true)
      .annotate(HandlerGate, "The comment's author, or `write`.")
      .annotate(OpenApi.Summary, "Edit a review comment")
      .annotate(SuccessDescription, "The comment"),
    HttpApiEndpoint.delete("deleteReviewComment", "/comments/:commentId", {
      params: ReviewCommentParams,
      success: Ok,
    })
      .annotate(RequiredAccess, "read")
      .annotate(RequiresUser, true)
      .annotate(HandlerGate, "The comment's author, or `write`.")
      .annotate(OpenApi.Summary, "Delete a review comment")
      .annotate(OpenApi.Description, "Deleting a thread's only comment deletes the thread.")
      .annotate(SuccessDescription, "Deleted"),
    HttpApiEndpoint.put("resolveThread", "/threads/:threadId/resolve", {
      params: ThreadParams,
      success: ReviewThread,
    })
      .annotate(RequiredAccess, "read")
      .annotate(RequiresUser, true)
      .annotate(HandlerGate, "The pull request's author, the thread's starter, or `write`.")
      .annotate(OpenApi.Summary, "Resolve a review thread")
      .annotate(SuccessDescription, "The thread"),
    HttpApiEndpoint.delete("unresolveThread", "/threads/:threadId/resolve", {
      params: ThreadParams,
      success: ReviewThread,
    })
      .annotate(RequiredAccess, "read")
      .annotate(RequiresUser, true)
      .annotate(HandlerGate, "The pull request's author, the thread's starter, or `write`.")
      .annotate(OpenApi.Summary, "Reopen a resolved review thread")
      .annotate(SuccessDescription, "The thread"),
  )
  .prefix("/api/repos/:owner/:repo/pulls")
  .middleware(RepositoryAccess)
  .middleware(Authentication)
  .annotate(OpenApi.Title, "Pull requests") {}
