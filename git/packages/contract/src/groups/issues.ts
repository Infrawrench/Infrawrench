/**
 * `/api/repos/:owner/:repo`: issues, the comments and timeline every thread
 * has (a branch page's too), labels and milestones.
 *
 * Commenting, opening an issue and editing one's own need only `read` and a
 * signed-in person. Labels, assignees, milestones, closing someone else's
 * thread and locking need `triage`. The handler owns the rules that depend on
 * who wrote what (`HandlerGate`).
 */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { HandlerGate, RequiredAccess, RequiresUser, SuccessDescription } from "../http/annotations";
import { Authentication, RepositoryAccess } from "../http/auth";
import { BadRequest, Conflict, UnprocessableEntity } from "../http/errors";
import { NumberParams, Ok, Page, PageQuery, RepoParams, SortDirection } from "../schemas/common";
import {
  ThreadComment,
  CommentWrite,
  ISSUE_SORTS,
  Issue,
  IssueCreate,
  IssueSummary,
  IssueUpdate,
  Label,
  LabelCreate,
  LabelUpdate,
  Milestone,
  MilestoneCreate,
  MilestoneUpdate,
  ThreadCounts,
  TimelineItem,
} from "../schemas/threads";

/** The filters issue and branch page lists share. */
export const threadFilterQuery = {
  ...PageQuery,
  label: Schema.optionalKey(
    Schema.String.annotate({
      description: "Label names separated by commas; a thread must carry all of them.",
    }),
  ),
  assignee: Schema.optionalKey(
    Schema.String.annotate({
      description: "A username, `@me`, or `none` for unassigned.",
    }),
  ),
  author: Schema.optionalKey(Schema.String.annotate({ description: "A username, or `@me`." })),
  milestone: Schema.optionalKey(
    Schema.String.annotate({ description: "A milestone's number, or `none`." }),
  ),
  q: Schema.optionalKey(
    Schema.String.annotate({ description: "Words to find in the title and body." }),
  ),
  sort: Schema.optionalKey(
    Schema.Literals(ISSUE_SORTS).annotate({ description: "Default `created`." }),
  ),
  direction: Schema.optionalKey(SortDirection.annotate({ description: "Default `desc`." })),
} as const;

const CommentParams = { ...RepoParams, commentId: Schema.String } as const;
const LabelParams = { ...RepoParams, labelId: Schema.String } as const;
const MilestoneParams = {
  ...RepoParams,
  milestone: Schema.NumberFromString.check(Schema.isInt()).annotate({
    description: "Milestone number.",
  }),
} as const;

export class IssuesGroup extends HttpApiGroup.make("issues")
  .add(
    HttpApiEndpoint.get("list", "/issues", {
      params: RepoParams,
      query: {
        ...threadFilterQuery,
        state: Schema.optionalKey(
          Schema.Literals(["open", "closed", "all"]).annotate({ description: "Default `open`." }),
        ),
      },
      success: Schema.Struct({ ...Page(IssueSummary).fields, counts: ThreadCounts }),
    })
      .annotate(RequiredAccess, "read")
      .annotate(OpenApi.Summary, "List issues")
      .annotate(OpenApi.Description, "Branch pages are not listed here; see `branches.list`.")
      .annotate(SuccessDescription, "Issues"),
    HttpApiEndpoint.post("create", "/issues", {
      params: RepoParams,
      payload: IssueCreate,
      success: Issue,
      error: [BadRequest, UnprocessableEntity],
    })
      .annotate(RequiredAccess, "read")
      .annotate(RequiresUser, true)
      .annotate(OpenApi.Summary, "Open an issue")
      .annotate(SuccessDescription, "The issue"),
    HttpApiEndpoint.get("get", "/issues/:number", { params: NumberParams, success: Issue })
      .annotate(RequiredAccess, "read")
      .annotate(OpenApi.Summary, "An issue")
      .annotate(
        OpenApi.Description,
        "404 for a number that is a branch page: the UI redirects on `branches.locate` instead.",
      )
      .annotate(SuccessDescription, "The issue"),
    HttpApiEndpoint.patch("update", "/issues/:number", {
      params: NumberParams,
      payload: IssueUpdate,
      success: Issue,
      error: [BadRequest, UnprocessableEntity],
    })
      .annotate(RequiredAccess, "read")
      .annotate(RequiresUser, true)
      .annotate(
        HandlerGate,
        "Title, body and closing one's own: the author. Everything else, and anyone else's: `triage`.",
      )
      .annotate(OpenApi.Summary, "Edit an issue, or close or reopen it")
      .annotate(SuccessDescription, "The issue"),
    HttpApiEndpoint.put("lock", "/issues/:number/lock", {
      params: NumberParams,
      payload: Schema.Struct({
        reason: Schema.optionalKey(
          Schema.NullOr(Schema.Literals(["off-topic", "too heated", "resolved", "spam"])),
        ),
      }),
      success: Ok,
    })
      .annotate(RequiredAccess, "triage")
      .annotate(OpenApi.Summary, "Lock a thread")
      .annotate(
        OpenApi.Description,
        "An issue or a branch page. Only `triage` and above can comment on a locked thread.",
      )
      .annotate(SuccessDescription, "Locked"),
    HttpApiEndpoint.delete("unlock", "/issues/:number/lock", {
      params: NumberParams,
      success: Ok,
    })
      .annotate(RequiredAccess, "triage")
      .annotate(OpenApi.Summary, "Unlock a thread")
      .annotate(SuccessDescription, "Unlocked"),
    HttpApiEndpoint.get("timeline", "/issues/:number/timeline", {
      params: NumberParams,
      query: PageQuery,
      success: Page(TimelineItem),
    })
      .annotate(RequiredAccess, "read")
      .annotate(OpenApi.Summary, "A thread's timeline")
      .annotate(
        OpenApi.Description,
        "An issue's or a branch page's: comments, events, and for a branch page its reviews and pushed commits, oldest first.",
      )
      .annotate(SuccessDescription, "Timeline entries"),
    HttpApiEndpoint.get("listComments", "/issues/:number/comments", {
      params: NumberParams,
      query: PageQuery,
      success: Page(ThreadComment),
    })
      .annotate(RequiredAccess, "read")
      .annotate(OpenApi.Summary, "A thread's comments")
      .annotate(SuccessDescription, "Comments, oldest first"),
    HttpApiEndpoint.post("createComment", "/issues/:number/comments", {
      params: NumberParams,
      payload: CommentWrite,
      success: ThreadComment,
      error: [BadRequest, UnprocessableEntity],
    })
      .annotate(RequiredAccess, "read")
      .annotate(RequiresUser, true)
      .annotate(OpenApi.Summary, "Comment on an issue or branch page")
      .annotate(OpenApi.Description, "422 `locked` on a locked thread without `triage`.")
      .annotate(SuccessDescription, "The comment"),
    HttpApiEndpoint.patch("updateComment", "/issues/comments/:commentId", {
      params: CommentParams,
      payload: CommentWrite,
      success: ThreadComment,
      error: BadRequest,
    })
      .annotate(RequiredAccess, "read")
      .annotate(RequiresUser, true)
      .annotate(HandlerGate, "The comment's author, or `write`.")
      .annotate(OpenApi.Summary, "Edit a comment")
      .annotate(SuccessDescription, "The comment"),
    HttpApiEndpoint.delete("deleteComment", "/issues/comments/:commentId", {
      params: CommentParams,
      success: Ok,
    })
      .annotate(RequiredAccess, "read")
      .annotate(RequiresUser, true)
      .annotate(HandlerGate, "The comment's author, or `write`.")
      .annotate(OpenApi.Summary, "Delete a comment")
      .annotate(SuccessDescription, "Deleted"),
  )
  .prefix("/api/repos/:owner/:repo")
  .middleware(RepositoryAccess)
  .middleware(Authentication)
  .annotate(OpenApi.Title, "Issues") {}

export class LabelsGroup extends HttpApiGroup.make("labels")
  .add(
    HttpApiEndpoint.get("list", "/labels", {
      params: RepoParams,
      success: Schema.Struct({ labels: Schema.Array(Label) }),
    })
      .annotate(RequiredAccess, "read")
      .annotate(OpenApi.Summary, "A repository's labels")
      .annotate(SuccessDescription, "Labels, by name"),
    HttpApiEndpoint.post("create", "/labels", {
      params: RepoParams,
      payload: LabelCreate,
      success: Label,
      error: [BadRequest, Conflict],
    })
      .annotate(RequiredAccess, "triage")
      .annotate(OpenApi.Summary, "Create a label")
      .annotate(SuccessDescription, "The label"),
    HttpApiEndpoint.patch("update", "/labels/:labelId", {
      params: LabelParams,
      payload: LabelUpdate,
      success: Label,
      error: [BadRequest, Conflict],
    })
      .annotate(RequiredAccess, "triage")
      .annotate(OpenApi.Summary, "Edit a label")
      .annotate(SuccessDescription, "The label"),
    HttpApiEndpoint.delete("delete", "/labels/:labelId", { params: LabelParams, success: Ok })
      .annotate(RequiredAccess, "triage")
      .annotate(OpenApi.Summary, "Delete a label")
      .annotate(OpenApi.Description, "It comes off every thread that carries it.")
      .annotate(SuccessDescription, "Deleted"),
  )
  .prefix("/api/repos/:owner/:repo")
  .middleware(RepositoryAccess)
  .middleware(Authentication)
  .annotate(OpenApi.Title, "Labels") {}

export class MilestonesGroup extends HttpApiGroup.make("milestones")
  .add(
    HttpApiEndpoint.get("list", "/milestones", {
      params: RepoParams,
      query: {
        state: Schema.optionalKey(
          Schema.Literals(["open", "closed", "all"]).annotate({ description: "Default `open`." }),
        ),
      },
      success: Schema.Struct({ milestones: Schema.Array(Milestone) }),
    })
      .annotate(RequiredAccess, "read")
      .annotate(OpenApi.Summary, "A repository's milestones")
      .annotate(SuccessDescription, "Milestones, soonest due first"),
    HttpApiEndpoint.post("create", "/milestones", {
      params: RepoParams,
      payload: MilestoneCreate,
      success: Milestone,
      error: [BadRequest, Conflict],
    })
      .annotate(RequiredAccess, "triage")
      .annotate(OpenApi.Summary, "Create a milestone")
      .annotate(SuccessDescription, "The milestone"),
    HttpApiEndpoint.get("get", "/milestones/:milestone", {
      params: MilestoneParams,
      success: Milestone,
    })
      .annotate(RequiredAccess, "read")
      .annotate(OpenApi.Summary, "A milestone")
      .annotate(SuccessDescription, "The milestone"),
    HttpApiEndpoint.patch("update", "/milestones/:milestone", {
      params: MilestoneParams,
      payload: MilestoneUpdate,
      success: Milestone,
      error: [BadRequest, Conflict],
    })
      .annotate(RequiredAccess, "triage")
      .annotate(OpenApi.Summary, "Edit a milestone, or close or reopen it")
      .annotate(SuccessDescription, "The milestone"),
    HttpApiEndpoint.delete("delete", "/milestones/:milestone", {
      params: MilestoneParams,
      success: Ok,
    })
      .annotate(RequiredAccess, "triage")
      .annotate(OpenApi.Summary, "Delete a milestone")
      .annotate(OpenApi.Description, "Its threads stay, without a milestone.")
      .annotate(SuccessDescription, "Deleted"),
  )
  .prefix("/api/repos/:owner/:repo")
  .middleware(RepositoryAccess)
  .middleware(Authentication)
  .annotate(OpenApi.Title, "Milestones") {}
