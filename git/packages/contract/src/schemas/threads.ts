/**
 * Issues and branch pages. The two share one number sequence per repository
 * and everything a conversation has (title, body, labels, assignees,
 * milestone, comments, timeline, lock), so a branch page is an issue's
 * fields plus its own: `/issues/:number/comments` and `/issues/:number/timeline`
 * serve both.
 */
import { Schema } from "effect";
import { BranchKey, IsoDateTime, Oid } from "./common";
import { CommitStatus, CommitSummary, DiffHunk, DiffStats, StatusState } from "./git";
import { ImportedFrom } from "./imports";
import { UserRef } from "./people";
import { MergeMethod, RepositoryRef } from "./repository";

export const Label = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  color: Schema.String.annotate({
    description: "Six hex digits, no `#`.",
    examples: ["d73a4a"],
  }),
  description: Schema.NullOr(Schema.String),
}).annotate({ identifier: "Label" });
export type Label = typeof Label.Type;

const LabelColor = Schema.String.check(Schema.isPattern(/^[0-9a-fA-F]{6}$/));

export const LabelCreate = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(50)),
  color: LabelColor,
  description: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(200)))),
}).annotate({ identifier: "LabelCreate" });
export type LabelCreate = typeof LabelCreate.Type;

export const LabelUpdate = Schema.Struct({
  name: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(50))),
  color: Schema.optionalKey(LabelColor),
  description: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(200)))),
}).annotate({ identifier: "LabelUpdate" });
export type LabelUpdate = typeof LabelUpdate.Type;

export const MilestoneState = Schema.Literals(["open", "closed"]);
export type MilestoneState = typeof MilestoneState.Type;

export const Milestone = Schema.Struct({
  id: Schema.String,
  number: Schema.Int,
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  state: MilestoneState,
  dueOn: Schema.NullOr(Schema.String.annotate({ format: "date" })),
  openCount: Schema.Int.annotate({ description: "Open issues and branch pages in it." }),
  closedCount: Schema.Int,
  createdAt: IsoDateTime,
  closedAt: Schema.NullOr(IsoDateTime),
}).annotate({ identifier: "Milestone" });
export type Milestone = typeof Milestone.Type;

export const MilestoneRef = Schema.Struct({
  id: Schema.String,
  number: Schema.Int,
  title: Schema.String,
}).annotate({ identifier: "MilestoneRef" });
export type MilestoneRef = typeof MilestoneRef.Type;

export const MilestoneCreate = Schema.Struct({
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  description: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(5000)))),
  dueOn: Schema.optionalKey(Schema.NullOr(Schema.String.annotate({ format: "date" }))),
}).annotate({ identifier: "MilestoneCreate" });
export type MilestoneCreate = typeof MilestoneCreate.Type;

export const MilestoneUpdate = Schema.Struct({
  title: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
  description: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(5000)))),
  dueOn: Schema.optionalKey(Schema.NullOr(Schema.String.annotate({ format: "date" }))),
  state: Schema.optionalKey(MilestoneState),
}).annotate({ identifier: "MilestoneUpdate" });
export type MilestoneUpdate = typeof MilestoneUpdate.Type;

export const BODY_MAX_LENGTH = 262_144;
export const TITLE_MAX_LENGTH = 256;
const Title = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(TITLE_MAX_LENGTH));
const Body = Schema.String.check(Schema.isMaxLength(BODY_MAX_LENGTH)).annotate({
  description: "Markdown.",
});

export const ISSUE_STATES = ["open", "closed"] as const;
export const IssueState = Schema.Literals(ISSUE_STATES).annotate({ identifier: "IssueState" });
export type IssueState = typeof IssueState.Type;

export const IssueStateReason = Schema.Literals(["completed", "not_planned"]).annotate({
  identifier: "IssueStateReason",
});
export type IssueStateReason = typeof IssueStateReason.Type;

/** The fields an issue and a branch page share. */
const threadFields = {
  id: Schema.String,
  number: Schema.Int,
  title: Schema.String,
  author: Schema.NullOr(UserRef).annotate({
    description: "Null when the account is gone.",
  }),
  labels: Schema.Array(Label),
  assignees: Schema.Array(UserRef),
  milestone: Schema.NullOr(MilestoneRef),
  commentCount: Schema.Int,
  locked: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  closedAt: Schema.NullOr(IsoDateTime),
} as const;

/** What the viewer may do to a thread. */
const threadViewerFields = {
  canEdit: Schema.Boolean.annotate({
    description: "Title and body: the author, or `triage` and above.",
  }),
  canTriage: Schema.Boolean.annotate({
    description: "Labels, assignees, milestone, close and reopen, lock.",
  }),
  canComment: Schema.Boolean.annotate({
    description: "Signed in, with read access, and the thread is not locked to them.",
  }),
  canClose: Schema.Boolean.annotate({ description: "The author may close their own." }),
} as const;

export const IssueSummary = Schema.Struct({
  ...threadFields,
  state: IssueState,
  stateReason: Schema.NullOr(IssueStateReason),
  imported: Schema.optionalKey(
    Schema.NullOr(ImportedFrom).annotate({
      description:
        "Where the issue was imported from. Null for one written here. When `author` is null, `imported.author` is who wrote it there.",
    }),
  ),
}).annotate({ identifier: "IssueSummary" });
export type IssueSummary = typeof IssueSummary.Type;

export const Issue = Schema.Struct({
  ...IssueSummary.fields,
  body: Schema.String,
  bodyEditedAt: Schema.NullOr(IsoDateTime),
  closedBy: Schema.NullOr(UserRef),
  lockReason: Schema.NullOr(Schema.String),
  viewer: Schema.Struct(threadViewerFields),
}).annotate({ identifier: "Issue" });
export type Issue = typeof Issue.Type;

export const IssueCreate = Schema.Struct({
  title: Title,
  body: Schema.optionalKey(Body),
  labels: Schema.optionalKey(
    Schema.Array(Schema.String).annotate({
      description: "Label names. Ignored without `triage`.",
    }),
  ),
  assignees: Schema.optionalKey(
    Schema.Array(Schema.String).annotate({ description: "Usernames. Ignored without `triage`." }),
  ),
  milestone: Schema.optionalKey(
    Schema.NullOr(Schema.Int).annotate({ description: "A milestone's number." }),
  ),
}).annotate({ identifier: "IssueCreate" });
export type IssueCreate = typeof IssueCreate.Type;

export const IssueUpdate = Schema.Struct({
  title: Schema.optionalKey(Title),
  body: Schema.optionalKey(Body),
  state: Schema.optionalKey(IssueState),
  stateReason: Schema.optionalKey(Schema.NullOr(IssueStateReason)),
  labels: Schema.optionalKey(
    Schema.Array(Schema.String).annotate({ description: "Replaces the labels, by name." }),
  ),
  assignees: Schema.optionalKey(
    Schema.Array(Schema.String).annotate({ description: "Replaces the assignees, by username." }),
  ),
  milestone: Schema.optionalKey(Schema.NullOr(Schema.Int)),
}).annotate({ identifier: "IssueUpdate" });
export type IssueUpdate = typeof IssueUpdate.Type;

export const ThreadCounts = Schema.Struct({
  open: Schema.Int,
  closed: Schema.Int,
}).annotate({
  identifier: "ThreadCounts",
  description: "Matching the list's filters other than `state`, for its Open and Closed tabs.",
});
export type ThreadCounts = typeof ThreadCounts.Type;

export const ThreadComment = Schema.Struct({
  id: Schema.String,
  author: Schema.NullOr(UserRef),
  body: Schema.String,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  edited: Schema.Boolean,
  authorAccess: Schema.NullOr(
    Schema.Literals(["owner", "member", "collaborator", "author"]),
  ).annotate({
    description:
      "The badge beside the author: the namespace's owner, an organisation member, a collaborator, or the thread's author. Null for none.",
  }),
  viewerCanEdit: Schema.Boolean,
  viewerCanDelete: Schema.Boolean,
  imported: Schema.optionalKey(
    Schema.NullOr(ImportedFrom).annotate({
      description: "Where the comment was imported from. Null for one written here.",
    }),
  ),
}).annotate({ identifier: "ThreadComment" });
export type ThreadComment = typeof ThreadComment.Type;

export const CommentWrite = Schema.Struct({
  body: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(BODY_MAX_LENGTH)),
}).annotate({ identifier: "CommentWrite" });
export type CommentWrite = typeof CommentWrite.Type;

// ---------------------------------------------------------------------------
// Branch pages
// ---------------------------------------------------------------------------

export const PAGE_STATES = ["open", "closed", "merged"] as const;
export const PageState = Schema.Literals(PAGE_STATES).annotate({
  identifier: "PageState",
});
export type PageState = typeof PageState.Type;

export const ReviewDecision = Schema.Literals([
  "approved",
  "changes_requested",
  "review_required",
]).annotate({
  identifier: "ReviewDecision",
  description:
    "`changes_requested` while any reviewer's newest review asks for changes; else `approved` once the required approvals are in; else `review_required` when the base branch requires approvals.",
});
export type ReviewDecision = typeof ReviewDecision.Type;

export const BranchPageSummary = Schema.Struct({
  ...threadFields,
  key: BranchKey.annotate({
    description: "What names this page in a path: `branches.get` takes it as `:branch`.",
  }),
  state: PageState,
  draft: Schema.Boolean,
  baseRef: Schema.String.annotate({ description: "The branch it merges into." }),
  headRef: Schema.String.annotate({ description: "The branch it merges from." }),
  headRepository: Schema.NullOr(RepositoryRef).annotate({
    description: "Null when the fork it came from is gone.",
  }),
  crossRepository: Schema.Boolean,
  headOid: Oid,
  status: Schema.NullOr(StatusState).annotate({ description: "The head's combined status." }),
  reviewDecision: Schema.NullOr(ReviewDecision),
  mergedAt: Schema.NullOr(IsoDateTime),
  latestVersion: Schema.optionalKey(
    Schema.NullOr(Schema.Int).annotate({
      description:
        "The newest version of its head branch (`versions.list`). Null before the first push is recorded.",
    }),
  ),
}).annotate({ identifier: "BranchPageSummary" });
export type BranchPageSummary = typeof BranchPageSummary.Type;

export const MERGE_BLOCKERS = [
  "merged",
  "closed",
  "draft",
  "conflicts",
  "checking",
  "head_missing",
  "checks_pending",
  "checks_failed",
  "approvals_required",
  "changes_requested",
  "push_restricted",
  "archived",
  "no_permission",
  "must_fix_findings",
] as const;

/**
 * Whether a branch page can merge, and everything that says why not. The
 * merge box renders this and nothing else.
 */
export const Mergeability = Schema.Struct({
  state: Schema.Literals(["unknown", "checking", "clean", "conflicting"]).annotate({
    description:
      "Whether the head merges into the base as Git sees it. `checking` while the trial merge runs after a push: poll.",
  }),
  conflictFiles: Schema.Array(Schema.String).annotate({
    description: "Paths that conflict, when `conflicting`.",
  }),
  behindBy: Schema.Int.annotate({
    description: "Commits on the base the head does not have. 0 when up to date.",
  }),
  checks: Schema.Struct({
    state: Schema.NullOr(StatusState),
    statuses: Schema.Array(CommitStatus),
    required: Schema.Array(
      Schema.Struct({
        context: Schema.String,
        state: Schema.NullOr(StatusState).annotate({
          description: "Null while nothing has reported it for the head.",
        }),
      }),
    ).annotate({ description: "The contexts the base branch's protection requires." }),
  }),
  reviews: Schema.Struct({
    decision: Schema.NullOr(ReviewDecision),
    requiredApprovals: Schema.Int,
    approvals: Schema.Int.annotate({
      description: "People whose newest review of the current head approves.",
    }),
    changesRequested: Schema.Int,
  }),
  protection: Schema.NullOr(
    Schema.Struct({ pattern: Schema.String, enforceAdmins: Schema.Boolean }),
  ).annotate({ description: "The protected-branch rule that matches the base, when one does." }),
  blockers: Schema.Array(
    Schema.Struct({
      code: Schema.Literals(MERGE_BLOCKERS),
      message: Schema.String,
    }),
  ).annotate({ description: "Empty when the viewer can merge now." }),
  canMerge: Schema.Boolean.annotate({
    description: "The viewer may merge now, with one of `allowedMethods`.",
  }),
  canBypass: Schema.Boolean.annotate({
    description:
      "The viewer is an admin and the rule does not bind admins: the unmet reviews and checks are theirs to override (`bypass: true`).",
  }),
  allowedMethods: Schema.Array(MergeMethod),
  defaultMethod: MergeMethod,
  canUpdateBranch: Schema.Boolean.annotate({
    description: "The head is behind, has no conflicts, and the viewer may push to it.",
  }),
  findings: Schema.optionalKey(
    Schema.Struct({
      mustFixOpen: Schema.Int.annotate({
        description:
          "Open must-fix findings no override covers. Above 0 with `blocks`, the `must_fix_findings` blocker is listed.",
      }),
      blocks: Schema.Boolean.annotate({
        description: "The repository holds merges on open must-fix findings.",
      }),
      canOverride: Schema.Boolean.annotate({
        description: "The viewer administers the repository: `findings.override` is theirs.",
      }),
    }).annotate({ description: "What review agents hold the merge on." }),
  ),
}).annotate({ identifier: "Mergeability" });
export type Mergeability = typeof Mergeability.Type;

export const BranchPage = Schema.Struct({
  ...BranchPageSummary.fields,
  body: Schema.String,
  bodyEditedAt: Schema.NullOr(IsoDateTime),
  closedBy: Schema.NullOr(UserRef),
  lockReason: Schema.NullOr(Schema.String),
  baseOid: Oid.annotate({ description: "The base branch's head when last synchronised." }),
  mergeBaseOid: Schema.NullOr(Oid),
  headRefExists: Schema.Boolean.annotate({
    description: "False once the head branch is deleted: offer to restore it.",
  }),
  commitCount: Schema.Int,
  stats: DiffStats,
  mergedBy: Schema.NullOr(UserRef),
  mergeCommitOid: Schema.NullOr(Oid),
  mergeMethod: Schema.NullOr(MergeMethod),
  mergeability: Mergeability,
  viewer: Schema.Struct({
    ...threadViewerFields,
    canReview: Schema.Boolean,
    canApprove: Schema.Boolean.annotate({
      description: "May approve or request changes: read access, and not the author.",
    }),
    pendingReviewId: Schema.NullOr(Schema.String).annotate({
      description: "The viewer's own review in progress, when they have one.",
    }),
    canDeleteHeadBranch: Schema.Boolean,
  }),
}).annotate({ identifier: "BranchPage" });
export type BranchPage = typeof BranchPage.Type;

export const BranchPagePropose = Schema.Struct({
  title: Schema.optionalKey(
    Title.annotate({ description: "The branch's name as words when omitted." }),
  ),
  body: Schema.optionalKey(Body),
  base: Schema.optionalKey(
    Schema.String.annotate({
      description: "A branch of this repository. Its default branch when omitted.",
    }),
  ),
  head: Schema.String.annotate({ description: "The branch whose page this is." }),
  headRepository: Schema.optionalKey(
    Schema.String.annotate({
      description: "`owner/name` of the fork `head` is in. This repository when omitted.",
    }),
  ),
  draft: Schema.optionalKey(Schema.Boolean),
  labels: Schema.optionalKey(Schema.Array(Schema.String)),
  assignees: Schema.optionalKey(Schema.Array(Schema.String)),
  milestone: Schema.optionalKey(Schema.NullOr(Schema.Int)),
}).annotate({ identifier: "BranchPagePropose" });
export type BranchPagePropose = typeof BranchPagePropose.Type;

export const BranchPageUpdate = Schema.Struct({
  title: Schema.optionalKey(Title),
  body: Schema.optionalKey(Body),
  base: Schema.optionalKey(
    Schema.String.annotate({ description: "Retarget it at another branch." }),
  ),
  labels: Schema.optionalKey(Schema.Array(Schema.String)),
  assignees: Schema.optionalKey(Schema.Array(Schema.String)),
  milestone: Schema.optionalKey(Schema.NullOr(Schema.Int)),
}).annotate({ identifier: "BranchPageUpdate" });
export type BranchPageUpdate = typeof BranchPageUpdate.Type;

export const MergeRequest = Schema.Struct({
  method: MergeMethod,
  commitTitle: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(TITLE_MAX_LENGTH)).annotate({
      description: "For `merge` and `squash`. A default is written when omitted.",
    }),
  ),
  commitMessage: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(BODY_MAX_LENGTH))),
  expectedHeadOid: Schema.optionalKey(
    Oid.annotate({
      description:
        "The head the person was looking at. The merge is refused (`head_moved`) if it has moved.",
    }),
  ),
  deleteBranch: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "Delete the head branch afterwards. The repository's setting when omitted.",
    }),
  ),
  bypass: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "Merge past unmet reviews and checks. Only where `Mergeability.canBypass`.",
    }),
  ),
}).annotate({ identifier: "MergeRequest" });
export type MergeRequest = typeof MergeRequest.Type;

export const MergeResult = Schema.Struct({
  merged: Schema.Literal(true),
  commitOid: Oid.annotate({ description: "The base branch's new head." }),
  method: MergeMethod,
  branchDeleted: Schema.Boolean,
}).annotate({ identifier: "MergeResult" });
export type MergeResult = typeof MergeResult.Type;

export const REVIEW_STATES = [
  "pending",
  "commented",
  "approved",
  "changes_requested",
  "dismissed",
] as const;
export const ReviewState = Schema.Literals(REVIEW_STATES).annotate({ identifier: "ReviewState" });
export type ReviewState = typeof ReviewState.Type;

export const REVIEW_EVENTS = ["comment", "approve", "request_changes"] as const;
export const ReviewEvent = Schema.Literals(REVIEW_EVENTS).annotate({ identifier: "ReviewEvent" });
export type ReviewEvent = typeof ReviewEvent.Type;

export const DiffSide = Schema.Literals(["LEFT", "RIGHT"]).annotate({
  identifier: "DiffSide",
  description: "`LEFT`: the old file (a deleted line). `RIGHT`: the new file (added or context).",
});
export type DiffSide = typeof DiffSide.Type;

export const ReviewComment = Schema.Struct({
  id: Schema.String,
  reviewId: Schema.String,
  threadId: Schema.String.annotate({
    description: "The id of the comment that started the thread; its own for that comment.",
  }),
  inReplyToId: Schema.NullOr(Schema.String),
  author: Schema.NullOr(UserRef),
  body: Schema.String,
  pending: Schema.Boolean.annotate({
    description: "Part of the viewer's unsubmitted review: only they see it.",
  }),
  version: Schema.optionalKey(
    Schema.NullOr(Schema.Int).annotate({
      description: "The branch version it was written on.",
    }),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  edited: Schema.Boolean,
  viewerCanEdit: Schema.Boolean,
  viewerCanDelete: Schema.Boolean,
}).annotate({ identifier: "ReviewComment" });
export type ReviewComment = typeof ReviewComment.Type;

/** A conversation anchored to lines of the diff. */
export const ReviewThread = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  side: DiffSide,
  line: Schema.NullOr(Schema.Int).annotate({
    description:
      "The (last) line it is on in the current diff, numbered in its side's file. Null once `outdated`.",
  }),
  startLine: Schema.NullOr(Schema.Int).annotate({
    description: "The first line of a multi-line comment. Null for a single line.",
  }),
  startSide: Schema.NullOr(DiffSide),
  commitOid: Oid.annotate({ description: "The head it is anchored to now." }),
  originalCommitOid: Oid.annotate({ description: "The head it was written against." }),
  originalLine: Schema.Int,
  originalStartLine: Schema.NullOr(Schema.Int),
  outdated: Schema.Boolean.annotate({
    description: "The lines it was written on have since changed.",
  }),
  version: Schema.optionalKey(
    Schema.NullOr(Schema.Int).annotate({
      description: "The branch version it was started on. Null before versions were recorded.",
    }),
  ),
  answeredInVersion: Schema.optionalKey(
    Schema.NullOr(Schema.Int).annotate({
      description:
        "The version whose push changed the lines it is on. Null while those lines stand, in which case it carries forward to every later version.",
    }),
  ),
  hunk: Schema.NullOr(DiffHunk).annotate({
    description:
      "The lines it was written on with a few of context, as they were, to show it outside the diff.",
  }),
  resolved: Schema.Boolean,
  resolvedBy: Schema.NullOr(UserRef),
  comments: Schema.Array(ReviewComment).annotate({ description: "Oldest first; never empty." }),
  viewerCanResolve: Schema.Boolean,
  viewerCanReply: Schema.Boolean,
}).annotate({ identifier: "ReviewThread" });
export type ReviewThread = typeof ReviewThread.Type;

export const Review = Schema.Struct({
  id: Schema.String,
  author: Schema.NullOr(UserRef),
  state: ReviewState,
  body: Schema.String,
  commitOid: Oid.annotate({ description: "The head it reviewed." }),
  stale: Schema.Boolean.annotate({
    description: "The head has moved since: an approval of an older head.",
  }),
  commentCount: Schema.Int,
  createdAt: IsoDateTime,
  submittedAt: Schema.NullOr(IsoDateTime).annotate({ description: "Null while `pending`." }),
  dismissedBy: Schema.NullOr(UserRef),
  dismissalReason: Schema.NullOr(Schema.String),
  viewerCanDismiss: Schema.Boolean,
  viewerCanEdit: Schema.Boolean,
}).annotate({ identifier: "Review" });
export type Review = typeof Review.Type;

const anchorFields = {
  path: Schema.String,
  line: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
    description: "The line (the last one of a range), numbered in its side's file.",
  }),
  side: DiffSide,
  startLine: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  startSide: Schema.optionalKey(DiffSide),
} as const;

/** A new thread on lines of the diff. */
export const ReviewCommentDraft = Schema.Struct({
  ...anchorFields,
  body: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(BODY_MAX_LENGTH)),
}).annotate({ identifier: "ReviewCommentDraft" });
export type ReviewCommentDraft = typeof ReviewCommentDraft.Type;

export const ReviewCreate = Schema.Struct({
  event: Schema.optionalKey(
    ReviewEvent.annotate({
      description:
        "Submit it at once. Omitted: start (or add to) the viewer's pending review, submitted later.",
    }),
  ),
  body: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(BODY_MAX_LENGTH))),
  commitOid: Schema.optionalKey(
    Oid.annotate({ description: "The head being reviewed. The current head when omitted." }),
  ),
  comments: Schema.optionalKey(Schema.Array(ReviewCommentDraft)),
}).annotate({ identifier: "ReviewCreate" });
export type ReviewCreate = typeof ReviewCreate.Type;

export const ReviewSubmit = Schema.Struct({
  event: ReviewEvent,
  body: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(BODY_MAX_LENGTH))),
}).annotate({ identifier: "ReviewSubmit" });
export type ReviewSubmit = typeof ReviewSubmit.Type;

/**
 * One review comment: a new thread (`path`, `line`, `side`) or a reply
 * (`inReplyTo`). `pending: true` adds it to the viewer's pending review
 * instead of publishing it at once.
 */
export const ReviewCommentCreate = Schema.Struct({
  body: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(BODY_MAX_LENGTH)),
  inReplyTo: Schema.optionalKey(
    Schema.String.annotate({
      description: "Any comment of the thread to reply in. The anchor fields are then ignored.",
    }),
  ),
  path: Schema.optionalKey(anchorFields.path),
  line: Schema.optionalKey(anchorFields.line),
  side: Schema.optionalKey(anchorFields.side),
  startLine: anchorFields.startLine,
  startSide: anchorFields.startSide,
  commitOid: Schema.optionalKey(Oid),
  pending: Schema.optionalKey(Schema.Boolean),
}).annotate({ identifier: "ReviewCommentCreate" });
export type ReviewCommentCreate = typeof ReviewCommentCreate.Type;

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

const eventBase = {
  id: Schema.String,
  actor: Schema.NullOr(UserRef),
  createdAt: IsoDateTime,
} as const;

const event = <const K extends string, const F extends Schema.Struct.Fields>(kind: K, fields: F) =>
  Schema.Struct({ type: Schema.Literal(kind), ...eventBase, ...fields });

const ThreadMention = Schema.Struct({
  repository: Schema.Struct({ owner: Schema.String, name: Schema.String }),
  number: Schema.Int,
  title: Schema.String,
  branch: Schema.NullOr(BranchKey).annotate({
    description: "The page's key when the thread is a branch's page. Null for an issue.",
  }),
  state: PageState,
}).annotate({ identifier: "ThreadMention" });

export const TIMELINE_EVENT_TYPES = [
  "labeled",
  "unlabeled",
  "assigned",
  "unassigned",
  "milestoned",
  "demilestoned",
  "renamed",
  "closed",
  "reopened",
  "locked",
  "unlocked",
  "referenced",
  "cross_referenced",
  "merged",
  "head_force_pushed",
  "head_branch_deleted",
  "head_branch_restored",
  "base_changed",
  "ready_for_review",
  "converted_to_draft",
  "review_dismissed",
  "terraform_run",
] as const;
export type TimelineEventType = (typeof TIMELINE_EVENT_TYPES)[number];

/**
 * One entry of a thread's timeline, oldest first, by `type`. A client that
 * meets a type it does not know skips the entry.
 */
export const TimelineItem = Schema.Union([
  Schema.Struct({ type: Schema.Literal("comment"), id: Schema.String, comment: ThreadComment }),
  Schema.Struct({
    type: Schema.Literal("review"),
    id: Schema.String,
    review: Review,
    threads: Schema.Array(ReviewThread).annotate({
      description: "The threads this review started.",
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("commits"),
    id: Schema.String,
    createdAt: IsoDateTime,
    commits: Schema.Array(CommitSummary).annotate({
      description: "Commits pushed to the head together, oldest first.",
    }),
  }),
  event("labeled", { label: Label }),
  event("unlabeled", { label: Label }),
  event("assigned", { assignee: Schema.NullOr(UserRef) }),
  event("unassigned", { assignee: Schema.NullOr(UserRef) }),
  event("milestoned", { milestoneTitle: Schema.String }),
  event("demilestoned", { milestoneTitle: Schema.String }),
  event("renamed", { from: Schema.String, to: Schema.String }),
  event("closed", {
    stateReason: Schema.NullOr(IssueStateReason),
    commitOid: Schema.NullOr(Oid).annotate({
      description: "The commit whose message closed it (`Fixes #12`).",
    }),
  }),
  event("reopened", {}),
  event("locked", { reason: Schema.NullOr(Schema.String) }),
  event("unlocked", {}),
  event("referenced", { commit: CommitSummary }),
  event("cross_referenced", { source: ThreadMention }),
  event("merged", { commitOid: Oid, method: MergeMethod, baseRef: Schema.String }),
  event("head_force_pushed", { beforeOid: Oid, afterOid: Oid }),
  event("head_branch_deleted", { ref: Schema.String }),
  event("head_branch_restored", { ref: Schema.String }),
  event("base_changed", { from: Schema.String, to: Schema.String }),
  event("ready_for_review", {}),
  event("converted_to_draft", {}),
  event("review_dismissed", { reviewId: Schema.String, reason: Schema.NullOr(Schema.String) }),
  event("terraform_run", {
    runId: Schema.String,
    workspace: Schema.String,
    operation: Schema.Literals(["plan", "apply"]),
    outcome: Schema.Literals(["planned", "no_changes", "applied", "failed", "skipped"]).annotate({
      description:
        "What the run reported: a plan with changes, a plan with none, an apply, a failure, or a run that was never started (a fork's branch page).",
    }),
    add: Schema.NullOr(Schema.Int),
    change: Schema.NullOr(Schema.Int),
    destroy: Schema.NullOr(Schema.Int),
    reason: Schema.NullOr(Schema.String).annotate({
      description: "Why it failed or was skipped.",
    }),
  }),
]).annotate({ identifier: "TimelineItem" });
export type TimelineItem = typeof TimelineItem.Type;

export const ISSUE_SORTS = ["created", "updated", "comments"] as const;
