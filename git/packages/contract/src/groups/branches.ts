/**
 * Branch pages: where a branch is read, reviewed and merged. Every branch but
 * the default one has a page, opened by its first push; a fork's branch gets
 * one in its parent when it is proposed there (`propose`). A page is named by
 * its branch (`BranchKey`): `/api/repos/:owner/:repo/branches/:branch`.
 *
 * A branch page's conversation (comments, timeline, labels, lock) is its
 * issue half: `issues.createComment`, `issues.timeline` and `issues.lock`
 * take its number. Everything here is what only a branch page has.
 */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { HandlerGate, RequiredAccess, RequiresUser, SuccessDescription } from "../http/annotations";
import { Authentication, RepositoryAccess } from "../http/auth";
import { BadRequest, Conflict, UnprocessableEntity } from "../http/errors";
import {
  BranchKey,
  BranchParams,
  NumberParams,
  Oid,
  Ok,
  Page,
  PageQuery,
  QueryFlag,
  RepoParams,
} from "../schemas/common";
import { CommitSummary, Diff, DiffQuery } from "../schemas/git";
import {
  MergeRequest,
  MergeResult,
  Mergeability,
  BranchPage,
  BranchPagePropose,
  BranchPageSummary,
  BranchPageUpdate,
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

const ReviewParams = { ...BranchParams, reviewId: Schema.String } as const;
const ReviewCommentParams = { ...RepoParams, commentId: Schema.String } as const;
const ThreadParams = { ...RepoParams, threadId: Schema.String } as const;

export class BranchesGroup extends HttpApiGroup.make("branches")
  .add(
    HttpApiEndpoint.get("list", "/branch-pages", {
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
      success: Schema.Struct({ ...Page(BranchPageSummary).fields, counts: ThreadCounts }),
    })
      .annotate(RequiredAccess, "read")
      .annotate(OpenApi.Summary, "List branch pages")
      .annotate(SuccessDescription, "Branch pages"),
    HttpApiEndpoint.post("propose", "/branch-pages", {
      params: RepoParams,
      payload: BranchPagePropose,
      success: BranchPage,
      error: [BadRequest, Conflict, UnprocessableEntity],
    })
      .annotate(RequiredAccess, "read")
      .annotate(RequiresUser, true)
      .annotate(
        HandlerGate,
        "Read access to the base repository and to the head repository, which is in the base's fork network and, when private, only proposed to a private base of the same owner; `write` is not needed to propose.",
      )
      .annotate(OpenApi.Summary, "Open the page of a branch that has none")
      .annotate(
        OpenApi.Description,
        "A fork's branch proposed to this repository, or a branch of this one that was pushed before pages were opened on push. 409 `branch_page_exists` when the branch has an open page; 422 `no_commits_between`, `ref_not_found`.",
      )
      .annotate(SuccessDescription, "The branch page"),
    HttpApiEndpoint.get("locate", "/branch-pages/:number", {
      params: NumberParams,
      success: Schema.Struct({ key: BranchKey }),
    })
      .annotate(RequiredAccess, "read")
      .annotate(OpenApi.Summary, "The branch page a thread number names")
      .annotate(
        OpenApi.Description,
        "A page shares its conversation's number sequence with issues (`#12` in a comment). This answers the key `branches.get` takes; 404 for an issue's number.",
      )
      .annotate(SuccessDescription, "The page's key"),
    HttpApiEndpoint.get("get", "/branches/:branch", { params: BranchParams, success: BranchPage })
      .annotate(RequiredAccess, "read")
      .annotate(OpenApi.Summary, "A branch page")
      .annotate(SuccessDescription, "The branch page, with its mergeability"),
    HttpApiEndpoint.patch("update", "/branches/:branch", {
      params: BranchParams,
      payload: BranchPageUpdate,
      success: BranchPage,
      error: [BadRequest, UnprocessableEntity],
    })
      .annotate(RequiredAccess, "read")
      .annotate(RequiresUser, true)
      .annotate(
        HandlerGate,
        "Title, body and base: the author or `write`. Labels, assignees, milestone: `triage`.",
      )
      .annotate(OpenApi.Summary, "Edit a branch page")
      .annotate(SuccessDescription, "The branch page"),
    HttpApiEndpoint.post("close", "/branches/:branch/close", {
      params: BranchParams,
      success: BranchPage,
      error: UnprocessableEntity,
    })
      .annotate(RequiredAccess, "read")
      .annotate(RequiresUser, true)
      .annotate(HandlerGate, "The author, or `triage`.")
      .annotate(OpenApi.Summary, "Close a branch page without merging")
      .annotate(SuccessDescription, "The branch page"),
    HttpApiEndpoint.post("reopen", "/branches/:branch/reopen", {
      params: BranchParams,
      success: BranchPage,
      error: UnprocessableEntity,
    })
      .annotate(RequiredAccess, "read")
      .annotate(RequiresUser, true)
      .annotate(HandlerGate, "The author, or `triage`.")
      .annotate(OpenApi.Summary, "Reopen a closed branch page")
      .annotate(
        OpenApi.Description,
        "422 `already_merged`, or `ref_not_found` when its head branch is gone.",
      )
      .annotate(SuccessDescription, "The branch page"),
    HttpApiEndpoint.put("setDraft", "/branches/:branch/draft", {
      params: BranchParams,
      payload: Schema.Struct({ draft: Schema.Boolean }),
      success: BranchPage,
      error: UnprocessableEntity,
    })
      .annotate(RequiredAccess, "read")
      .annotate(RequiresUser, true)
      .annotate(HandlerGate, "The author, or `write`.")
      .annotate(OpenApi.Summary, "Mark a branch as a draft, or as ready for review")
      .annotate(SuccessDescription, "The branch page"),
    HttpApiEndpoint.get("files", "/branches/:branch/files", {
      params: BranchParams,
      query: {
        ...PageQuery,
        ...DiffQuery,
        since: Schema.optionalKey(
          Oid.annotate({
            description:
              'Only what changed after this head, for "changes since my last review". Omitted: the whole change.',
          }),
        ),
      },
      success: Diff,
    })
      .annotate(RequiredAccess, "read")
      .annotate(OpenApi.Summary, "A branch page's diff, with hunks")
      .annotate(SuccessDescription, "The diff from the merge base to the head"),
    HttpApiEndpoint.get("commits", "/branches/:branch/commits", {
      params: BranchParams,
      query: PageQuery,
      success: Page(CommitSummary),
    })
      .annotate(RequiredAccess, "read")
      .annotate(OpenApi.Summary, "A branch page's commits")
      .annotate(SuccessDescription, "Commits, oldest first"),
    HttpApiEndpoint.get("mergeability", "/branches/:branch/mergeability", {
      params: BranchParams,
      success: Mergeability,
    })
      .annotate(RequiredAccess, "read")
      .annotate(OpenApi.Summary, "Whether a branch page can merge, and why not")
      .annotate(
        OpenApi.Description,
        "The same block `get` carries, on its own so the merge box can poll while `state` is `checking`.",
      )
      .annotate(SuccessDescription, "Mergeability"),
    HttpApiEndpoint.post("merge", "/branches/:branch/merge", {
      params: BranchParams,
      payload: MergeRequest,
      success: MergeResult,
      error: [BadRequest, Conflict, UnprocessableEntity],
    })
      .annotate(RequiredAccess, "write")
      .annotate(OpenApi.Summary, "Merge a branch page")
      .annotate(
        OpenApi.Description,
        "409 `head_moved` when `expectedHeadOid` is stale. 422 with the first blocker as `code`: `merge_conflict`, `checks_required`, `approvals_required`, `changes_requested`, `draft`, `already_merged`, `protected_branch`, `merge_method_not_allowed`.",
      )
      .annotate(SuccessDescription, "Merged"),
    HttpApiEndpoint.post("updateBranch", "/branches/:branch/update", {
      params: BranchParams,
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
      .annotate(OpenApi.Summary, "Bring a branch up to date with the branch it merges into")
      .annotate(SuccessDescription, "The head's new commit"),
    HttpApiEndpoint.post("restoreBranch", "/branches/:branch/restore", {
      params: BranchParams,
      success: Schema.Struct({ ref: Schema.String, oid: Oid }),
      error: [Conflict, UnprocessableEntity],
    })
      .annotate(RequiredAccess, "read")
      .annotate(RequiresUser, true)
      .annotate(HandlerGate, "`write` on the head repository.")
      .annotate(OpenApi.Summary, "Restore a merged or closed page's deleted branch")
      .annotate(SuccessDescription, "The branch"),
    HttpApiEndpoint.get("listReviews", "/branches/:branch/reviews", {
      params: BranchParams,
      success: Schema.Struct({ reviews: Schema.Array(Review) }),
    })
      .annotate(RequiredAccess, "read")
      .annotate(OpenApi.Summary, "A branch page's reviews")
      .annotate(
        OpenApi.Description,
        "Submitted reviews, oldest first, plus the caller's own pending one.",
      )
      .annotate(SuccessDescription, "Reviews"),
    HttpApiEndpoint.post("createReview", "/branches/:branch/reviews", {
      params: BranchParams,
      payload: ReviewCreate,
      success: Review,
      error: [BadRequest, UnprocessableEntity],
    })
      .annotate(RequiredAccess, "read")
      .annotate(RequiresUser, true)
      .annotate(OpenApi.Summary, "Review a branch page")
      .annotate(
        OpenApi.Description,
        "With `event`, submitted at once. Without, the caller's pending review is started or added to. An author cannot approve or request changes on their own branch page (422).",
      )
      .annotate(SuccessDescription, "The review"),
    HttpApiEndpoint.post("submitReview", "/branches/:branch/reviews/:reviewId/submit", {
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
    HttpApiEndpoint.delete("discardReview", "/branches/:branch/reviews/:reviewId", {
      params: ReviewParams,
      success: Ok,
      error: UnprocessableEntity,
    })
      .annotate(RequiredAccess, "read")
      .annotate(RequiresUser, true)
      .annotate(HandlerGate, "The review's author, while it is pending.")
      .annotate(OpenApi.Summary, "Discard a pending review and its comments")
      .annotate(SuccessDescription, "Discarded"),
    HttpApiEndpoint.put("dismissReview", "/branches/:branch/reviews/:reviewId/dismiss", {
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
    HttpApiEndpoint.get("listThreads", "/branches/:branch/threads", {
      params: BranchParams,
      success: Schema.Struct({ threads: Schema.Array(ReviewThread) }),
    })
      .annotate(RequiredAccess, "read")
      .annotate(OpenApi.Summary, "A branch page's review threads")
      .annotate(
        OpenApi.Description,
        "Every thread on the diff, outdated and resolved ones included, in file then line order. The files view places them by `path`, `side` and `line`.",
      )
      .annotate(SuccessDescription, "Review threads"),
    HttpApiEndpoint.post("createReviewComment", "/branches/:branch/comments", {
      params: BranchParams,
      payload: ReviewCommentCreate,
      success: Schema.Struct({ thread: ReviewThread, comment: ReviewComment }),
      error: [BadRequest, UnprocessableEntity],
    })
      .annotate(RequiredAccess, "read")
      .annotate(RequiresUser, true)
      .annotate(OpenApi.Summary, "Comment on lines of a branch page's diff, or reply in a thread")
      .annotate(
        OpenApi.Description,
        "A new thread needs `path`, `line` and `side`, on lines the diff shows (422 otherwise); a reply needs `inReplyTo`.",
      )
      .annotate(SuccessDescription, "The comment and its thread"),
    HttpApiEndpoint.patch("updateReviewComment", "/review-comments/:commentId", {
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
    HttpApiEndpoint.delete("deleteReviewComment", "/review-comments/:commentId", {
      params: ReviewCommentParams,
      success: Ok,
    })
      .annotate(RequiredAccess, "read")
      .annotate(RequiresUser, true)
      .annotate(HandlerGate, "The comment's author, or `write`.")
      .annotate(OpenApi.Summary, "Delete a review comment")
      .annotate(OpenApi.Description, "Deleting a thread's only comment deletes the thread.")
      .annotate(SuccessDescription, "Deleted"),
    HttpApiEndpoint.put("resolveThread", "/review-threads/:threadId/resolve", {
      params: ThreadParams,
      success: ReviewThread,
    })
      .annotate(RequiredAccess, "read")
      .annotate(RequiresUser, true)
      .annotate(HandlerGate, "The branch page's author, the thread's starter, or `write`.")
      .annotate(OpenApi.Summary, "Resolve a review thread")
      .annotate(SuccessDescription, "The thread"),
    HttpApiEndpoint.delete("unresolveThread", "/review-threads/:threadId/resolve", {
      params: ThreadParams,
      success: ReviewThread,
    })
      .annotate(RequiredAccess, "read")
      .annotate(RequiresUser, true)
      .annotate(HandlerGate, "The branch page's author, the thread's starter, or `write`.")
      .annotate(OpenApi.Summary, "Reopen a resolved review thread")
      .annotate(SuccessDescription, "The thread"),
  )
  .prefix("/api/repos/:owner/:repo")
  .middleware(RepositoryAccess)
  .middleware(Authentication)
  .annotate(OpenApi.Title, "Branches") {}
