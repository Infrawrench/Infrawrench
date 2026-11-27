/**
 * Reviewing work a branch at a time: the versions of a branch, what the
 * agent that wrote them recorded (traces), what review agents found
 * (findings), what reviewers sent back (instructions), and the agent behind
 * the branch. A branch's page is its branch page shown another way, so
 * every shape here hangs off a branch page's number.
 *
 * Lists that only ever grow on the server (`reviewerKind`, an agent's
 * `kind` where a client wrote it, `deliveredVia`) are strings with their
 * known values documented, so an older client reads a newer server.
 */
import { Schema } from "effect";
import { BranchKey, IsoDateTime, Oid, Page } from "./common";
import { Diff, DiffStats, StatusState } from "./git";
import { UserRef } from "./people";
import { MergeMethod, RepositoryRef } from "./repository";

const BODY_LIMIT = 262_144;
const Markdown = Schema.String.check(Schema.isMaxLength(BODY_LIMIT)).annotate({
  description: "Markdown.",
});
const NonEmptyMarkdown = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(BODY_LIMIT),
).annotate({ description: "Markdown." });
const Line = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
/** A version's number in a path or a query: 1 and up. */
export const VersionNumber = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(1),
).annotate({ description: "A version's number." });
export type VersionNumber = typeof VersionNumber.Type;

// ---------------------------------------------------------------------------
// Preferences and settings
// ---------------------------------------------------------------------------

/** The reviewers the forge runs itself. */
export const REVIEWER_KINDS = ["general", "security", "tests", "terraform", "intent"] as const;
export type ReviewerKind = (typeof REVIEWER_KINDS)[number];
const ReviewerKindName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
).annotate({
  description: `A reviewer. The forge's own are ${REVIEWER_KINDS.map((kind) => `\`${kind}\``).join(", ")}; an agent that reports findings may name another. Names that start with \`ci:\` are Infrawrench CI's (\`ci:<pipeline>/<job>\`, a job's note commands) and are refused to a report.`,
});

export const ReviewSettings = Schema.Struct({
  reviewAgentsEnabled: Schema.Boolean,
  reviewerKinds: Schema.Array(ReviewerKindName).annotate({
    description: "The reviewers that run on each version.",
  }),
  mustFixBlocksMerge: Schema.Boolean.annotate({
    description: "An open must-fix finding holds a merge until an administrator overrides it.",
  }),
  availableReviewerKinds: Schema.Array(Schema.String).annotate({
    description: "The reviewers this server can run.",
  }),
}).annotate({ identifier: "ReviewSettings" });
export type ReviewSettings = typeof ReviewSettings.Type;

export const ReviewSettingsUpdate = Schema.Struct({
  reviewAgentsEnabled: Schema.optionalKey(Schema.Boolean),
  reviewerKinds: Schema.optionalKey(Schema.Array(ReviewerKindName).check(Schema.isMaxLength(16))),
  mustFixBlocksMerge: Schema.optionalKey(Schema.Boolean),
}).annotate({ identifier: "ReviewSettingsUpdate" });
export type ReviewSettingsUpdate = typeof ReviewSettingsUpdate.Type;

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export const AGENT_KINDS = ["infrawrench", "t3", "mcp"] as const;
export const AgentKind = Schema.Literals(AGENT_KINDS).annotate({
  identifier: "AgentKind",
  description:
    "`infrawrench`: an Infrawrench agent session in the app. `t3`: a T3 Code thread in one of the person's environments. `mcp`: any agent that reaches the forge through its API or MCP tools.",
});
export type AgentKind = typeof AgentKind.Type;

/** Who acted, when it was an agent: on a version, a trace entry. */
export const AgentIdentity = Schema.Struct({
  kind: Schema.String.annotate({
    description:
      "One of the agent kinds, or what the agent called itself. `ci` is a job of Infrawrench CI, whose note commands the entry came from; its `name` is `<pipeline>/<job>`.",
  }),
  name: Schema.String,
  sessionRef: Schema.NullOr(Schema.String).annotate({
    description: "The agent's own name for the session or thread it ran in.",
  }),
}).annotate({ identifier: "AgentIdentity" });
export type AgentIdentity = typeof AgentIdentity.Type;

const AgentIdentityInput = Schema.Struct({
  kind: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  sessionRef: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(500)))),
});

const ExternalRefs = Schema.Record(Schema.String, Schema.String).annotate({
  description:
    "What names the agent where it runs: `threadId` and `projectId` for T3 Code, `sessionId` and `organizationId` for an Infrawrench agent, or whatever an MCP client gave.",
});

/** The agent that writes a branch page's branch. */
/** What `agents.token` answers: a credential, shown once. */
export const AgentToken = Schema.Struct({
  token: Schema.String,
  expiresAt: IsoDateTime,
  /** The branch whose markers it writes. */
  branch: Schema.String,
});
export type AgentToken = typeof AgentToken.Type;

export const AgentLink = Schema.Struct({
  kind: AgentKind,
  displayName: Schema.String,
  externalRefs: ExternalRefs,
  t3EnvironmentId: Schema.NullOr(Schema.String),
  connectedBy: Schema.NullOr(UserRef),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).annotate({ identifier: "AgentLink" });
export type AgentLink = typeof AgentLink.Type;

const T3Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));

/**
 * The model a T3 Code thread is started with, as `t3.listModels` names it:
 * a provider of the environment's, one of its models and, where the model
 * has reasoning levels, one of those.
 */
export const T3ModelChoice = Schema.Struct({
  providerId: T3Id,
  model: T3Id,
  reasoning: Schema.optionalKey(
    Schema.Struct({
      optionId: T3Id.annotate({ description: "The model's `reasoning.optionId`." }),
      level: T3Id,
    }),
  ),
}).annotate({ identifier: "T3ModelChoice" });
export type T3ModelChoice = typeof T3ModelChoice.Type;

export const AgentLinkSet = Schema.Struct({
  kind: AgentKind,
  displayName: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  externalRefs: Schema.optionalKey(ExternalRefs),
  t3EnvironmentId: Schema.optionalKey(
    Schema.NullOr(
      Schema.String.annotate({ description: "One of the caller's own T3 Code environments." }),
    ),
  ),
  t3Model: Schema.optionalKey(
    T3ModelChoice.annotate({
      description:
        "For a T3 Code thread the forge starts: the model it runs. Without one the project's default is used, or a model the forge picks when the project has none.",
    }),
  ),
}).annotate({ identifier: "AgentLinkSet" });
export type AgentLinkSet = typeof AgentLinkSet.Type;

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

export const REVIEW_RUN_STATUSES = ["queued", "running", "done", "failed"] as const;
export const ReviewRunStatus = Schema.Literals(REVIEW_RUN_STATUSES).annotate({
  identifier: "ReviewRunStatus",
});
export type ReviewRunStatus = typeof ReviewRunStatus.Type;

/** One push to the branch. */
export const BranchVersion = Schema.Struct({
  id: Schema.String,
  number: Schema.Int.annotate({ description: "1 for the first push, counting up." }),
  lineage: Schema.Int.annotate({
    description: "Counts the times the branch was made: a deleted branch made again starts over.",
  }),
  tipOid: Oid,
  baseOid: Schema.NullOr(Oid).annotate({
    description: "The merge base with the target branch when this version was pushed.",
  }),
  previousOid: Schema.NullOr(Oid).annotate({
    description: "The branch's commit before this push. Null for the first version.",
  }),
  forced: Schema.Boolean.annotate({
    description: "Not a fast-forward: a rebase, an amend or a reset.",
  }),
  rebased: Schema.Boolean.annotate({
    description: "Its base differs from the version before it.",
  }),
  pusher: Schema.NullOr(UserRef),
  pusherKind: Schema.NullOr(Schema.String).annotate({
    description: "The credential that pushed: `user`, `api-key`, `deploy-key` or `job`.",
  }),
  agent: Schema.NullOr(AgentIdentity),
  commitCount: Schema.NullOr(Schema.Int),
  stats: Schema.NullOr(DiffStats).annotate({
    description: "Of the whole change at this version, base to tip.",
  }),
  counts: Schema.Struct({
    comments: Schema.Int.annotate({ description: "Review comments written on this version." }),
    findings: Schema.Int.annotate({ description: "Findings first raised on this version." }),
    traceEntries: Schema.Int,
    answeredInstructions: Schema.Int.annotate({
      description: "Instructions this version answers.",
    }),
  }),
  hasTrace: Schema.Boolean,
  reviewStatus: Schema.NullOr(ReviewRunStatus).annotate({
    description: "The newest review run on this version. Null when none ran.",
  }),
  createdAt: IsoDateTime,
  prunedAt: Schema.NullOr(IsoDateTime).annotate({
    description:
      "When its commit stopped being kept: thirty days after the branch was merged or deleted. The version, its trace, its findings and its comments stay; a diff of it is served only while a branch or a tag still reaches its commit.",
  }),
}).annotate({ identifier: "BranchVersion" });
export type BranchVersion = typeof BranchVersion.Type;

export const BranchVersionList = Schema.Struct({
  branch: Schema.String,
  versions: Schema.Array(BranchVersion).annotate({ description: "Oldest first." }),
  latest: Schema.NullOr(Schema.Int).annotate({
    description: "The newest version's number. Null before the first push.",
  }),
  viewerReviewed: Schema.NullOr(Schema.Int).annotate({
    description: "The newest version the viewer marked as reviewed.",
  }),
}).annotate({ identifier: "BranchVersionList" });
export type BranchVersionList = typeof BranchVersionList.Type;

/**
 * A diff between versions. `whole` is the change at one version, base to
 * tip. `interdiff` is what a later version changed in the change itself:
 * each version is taken against its own base, so a rebase alone shows
 * nothing.
 */
export const VersionDiff = Schema.Struct({
  ...Diff.fields,
  kind: Schema.Literals(["whole", "interdiff"]),
  from: Schema.NullOr(Schema.Int).annotate({
    description: "The version compared from. Null for `whole`.",
  }),
  to: Schema.Int,
  rebased: Schema.Boolean.annotate({
    description: "The two versions have different bases.",
  }),
  exact: Schema.Boolean.annotate({
    description:
      "False when the older version did not apply cleanly to the newer base: the diff is then tip to tip and includes what the rebase brought.",
  }),
  source: Schema.Literals(["versions", "merge"]).annotate({
    description:
      "`merge` when the version is pruned and its commit is gone: the whole change is then read from the commit the branch was merged as, against that commit's first parent.",
  }),
}).annotate({ identifier: "VersionDiff" });
export type VersionDiff = typeof VersionDiff.Type;

export const VersionReviewMark = Schema.Struct({
  version: Schema.Int,
  reviewedAt: IsoDateTime,
}).annotate({ identifier: "VersionReviewMark" });
export type VersionReviewMark = typeof VersionReviewMark.Type;

// ---------------------------------------------------------------------------
// Traces
// ---------------------------------------------------------------------------

export const TRACE_KINDS = ["ask", "step", "decision", "evidence", "doubt", "note"] as const;
export const TraceKind = Schema.Literals(TRACE_KINDS).annotate({ identifier: "TraceKind" });
export type TraceKind = typeof TraceKind.Type;

export const TraceAnchor = Schema.Struct({
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  startLine: Schema.optionalKey(Schema.NullOr(Line)),
  endLine: Schema.optionalKey(Schema.NullOr(Line)),
}).annotate({ identifier: "TraceAnchor" });
export type TraceAnchor = typeof TraceAnchor.Type;

/** What an `evidence` entry ran and saw. Secrets are masked before it is stored. */
export const TraceEvidence = Schema.Struct({
  command: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(8192)))),
  exitCode: Schema.optionalKey(Schema.NullOr(Schema.Int)),
  output: Schema.optionalKey(
    Schema.NullOr(
      Schema.String.check(Schema.isMaxLength(65_536)).annotate({
        description: "An excerpt, not the log.",
      }),
    ),
  ),
  ciRunId: Schema.optionalKey(
    Schema.NullOr(Schema.String.annotate({ description: "An Infrawrench CI run." })),
  ),
  url: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(2048)))),
}).annotate({ identifier: "TraceEvidence" });
export type TraceEvidence = typeof TraceEvidence.Type;

export const TraceEntry = Schema.Struct({
  id: Schema.String,
  kind: TraceKind,
  body: Schema.String,
  anchors: Schema.Array(TraceAnchor),
  needsCode: Schema.Boolean.annotate({
    description:
      "The reader has to see the anchored lines to understand the entry: they are shown beside it. False for an entry that stands on its own.",
  }),
  evidence: Schema.NullOr(TraceEvidence),
  author: Schema.NullOr(UserRef),
  agent: Schema.NullOr(AgentIdentity),
  branch: Schema.String,
  version: Schema.NullOr(Schema.Int).annotate({
    description: "Null until the next push to the branch, which it then belongs to.",
  }),
  createdAt: IsoDateTime,
}).annotate({ identifier: "TraceEntry" });
export type TraceEntry = typeof TraceEntry.Type;

export const TraceEntryCreate = Schema.Struct({
  kind: TraceKind,
  body: NonEmptyMarkdown,
  anchors: Schema.optionalKey(Schema.Array(TraceAnchor).check(Schema.isMaxLength(64))),
  needsCode: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "The reader has to see the anchored lines to understand the entry. True when omitted and an anchor names a line, false otherwise. True with no anchor is stored as false: there is no code to show.",
    }),
  ),
  evidence: Schema.optionalKey(Schema.NullOr(TraceEvidence)),
}).annotate({ identifier: "TraceEntryCreate" });
export type TraceEntryCreate = typeof TraceEntryCreate.Type;

export const TraceRecord = Schema.Struct({
  branch: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)).annotate({
    description: "The branch being worked on, short. It need not exist yet.",
  }),
  agent: Schema.optionalKey(AgentIdentityInput),
  entries: Schema.Array(TraceEntryCreate).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
}).annotate({ identifier: "TraceRecord" });
export type TraceRecord = typeof TraceRecord.Type;

// ---------------------------------------------------------------------------
// Findings and review runs
// ---------------------------------------------------------------------------

export const FINDING_SEVERITIES = ["must_fix", "should_fix", "note"] as const;
export const FindingSeverity = Schema.Literals(FINDING_SEVERITIES).annotate({
  identifier: "FindingSeverity",
});
export type FindingSeverity = typeof FindingSeverity.Type;

export const FINDING_STATUSES = ["open", "fixed", "dismissed"] as const;
export const FindingStatus = Schema.Literals(FINDING_STATUSES).annotate({
  identifier: "FindingStatus",
});
export type FindingStatus = typeof FindingStatus.Type;

export const FindingEvidence = Schema.Struct({
  kind: Schema.String.check(Schema.isMaxLength(64)).annotate({
    description: "`code`, `command`, `test`, `ci` or `reference`.",
  }),
  text: Schema.String.check(Schema.isMaxLength(65_536)),
  url: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(2048)))),
}).annotate({ identifier: "FindingEvidence" });
export type FindingEvidence = typeof FindingEvidence.Type;

const FindingSide = Schema.Literals(["LEFT", "RIGHT"]);

export const ReviewFinding = Schema.Struct({
  id: Schema.String,
  reviewerKind: Schema.String,
  severity: FindingSeverity,
  title: Schema.String,
  body: Schema.String,
  path: Schema.NullOr(Schema.String).annotate({
    description: "Null for a finding about the change as a whole.",
  }),
  side: FindingSide,
  startLine: Schema.NullOr(Schema.Int),
  endLine: Schema.NullOr(Schema.Int),
  needsCode: Schema.Boolean.annotate({
    description:
      "The reader has to see the lines it is about to understand it: they are shown beside it. False for a finding that stands on its own.",
  }),
  commitOid: Oid.annotate({ description: "The commit its lines are numbered in." }),
  evidence: Schema.Array(FindingEvidence),
  status: FindingStatus,
  version: Schema.Int.annotate({ description: "The version it was first raised on." }),
  lastSeenVersion: Schema.Int,
  fixedInVersion: Schema.NullOr(Schema.Int),
  dismissedBy: Schema.NullOr(UserRef),
  dismissedAt: Schema.NullOr(IsoDateTime),
  dismissalReason: Schema.NullOr(Schema.String),
  overridden: Schema.Boolean.annotate({
    description: "An administrator's merge override covers it.",
  }),
  runId: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  viewerCanDismiss: Schema.Boolean,
}).annotate({ identifier: "ReviewFinding" });
export type ReviewFinding = typeof ReviewFinding.Type;

export const FindingsTally = Schema.Struct({
  found: Schema.Int,
  open: Schema.Int,
  fixed: Schema.Int,
  dismissed: Schema.Int,
  mustFixOpen: Schema.Int.annotate({
    description: "Open must-fix findings no override covers: what holds a merge.",
  }),
  needsPerson: Schema.Int.annotate({
    description: "Open findings nobody has sent to the agent or dismissed.",
  }),
}).annotate({ identifier: "FindingsTally" });
export type FindingsTally = typeof FindingsTally.Type;

export const FindingCreate = Schema.Struct({
  severity: FindingSeverity,
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  body: Schema.optionalKey(Markdown),
  path: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(4096)))),
  side: Schema.optionalKey(FindingSide),
  startLine: Schema.optionalKey(Schema.NullOr(Line)),
  endLine: Schema.optionalKey(Schema.NullOr(Line)),
  needsCode: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "The reader has to see the lines it is about to understand it. True when omitted and the finding has a path and a line, false otherwise. True with no path is stored as false: there is no code to show.",
    }),
  ),
  evidence: Schema.optionalKey(Schema.Array(FindingEvidence).check(Schema.isMaxLength(32))),
  fingerprint: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).annotate({
      description:
        "The same for the same finding on a later version, which is how a dismissal is remembered. Derived from the reviewer, the path and the title when omitted.",
    }),
  ),
}).annotate({ identifier: "FindingCreate" });
export type FindingCreate = typeof FindingCreate.Type;

/** What a reviewer reports for one version: what it found, and what it no longer finds. */
export const FindingReport = Schema.Struct({
  reviewerKind: ReviewerKindName,
  version: Schema.optionalKey(
    Schema.Int.annotate({ description: "The version reviewed. The newest when omitted." }),
  ),
  runId: Schema.optionalKey(Schema.String),
  findings: Schema.Array(FindingCreate).check(Schema.isMaxLength(200)),
  complete: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "This is everything the reviewer finds on the version: its open findings not listed are marked fixed.",
    }),
  ),
}).annotate({ identifier: "FindingReport" });
export type FindingReport = typeof FindingReport.Type;

/** A finding as a merged branch page left it: what it said, where, and how it was settled. */
export const MergedFinding = Schema.Struct({
  id: Schema.String,
  reviewerKind: Schema.String,
  severity: FindingSeverity,
  title: Schema.String,
  path: Schema.NullOr(Schema.String),
  side: FindingSide,
  startLine: Schema.NullOr(Schema.Int),
  endLine: Schema.NullOr(Schema.Int),
  commitOid: Oid.annotate({ description: "The commit its lines are numbered in." }),
  linesAtHead: Schema.Boolean.annotate({
    description:
      "Its lines are numbered in the branch's last commit, the one that was merged. False for a finding last seen on an older version.",
  }),
  status: FindingStatus,
  version: Schema.Int.annotate({ description: "The version it was first raised on." }),
  fixedInVersion: Schema.NullOr(Schema.Int),
  dismissedBy: Schema.NullOr(UserRef),
  dismissalReason: Schema.NullOr(Schema.String),
  override: Schema.NullOr(
    Schema.Struct({ by: Schema.NullOr(UserRef), reason: Schema.String }),
  ).annotate({
    description: "The administrator's override that let the merge past it while it was open.",
  }),
}).annotate({ identifier: "MergedFinding" });
export type MergedFinding = typeof MergedFinding.Type;

/** The review record of a merged branch page, as the default branch shows it. */
export const MergedReview = Schema.Struct({
  page: Schema.Struct({ key: BranchKey, title: Schema.String, branch: Schema.String }),
  mergeCommitOid: Oid,
  mergeMethod: Schema.NullOr(MergeMethod),
  mergedAt: IsoDateTime,
  mergedBy: Schema.NullOr(UserRef),
  versions: Schema.Int.annotate({ description: "How many versions the branch went through." }),
  ask: Schema.NullOr(Schema.String).annotate({
    description:
      "What the agent recorded as the ask, as Markdown. Null when no trace has one, and in a file's history.",
  }),
  findings: Schema.Array(MergedFinding).annotate({
    description: "The gravest first. In a file's history, only those on that path.",
  }),
}).annotate({ identifier: "MergedReview" });
export type MergedReview = typeof MergedReview.Type;

export const CommitReview = Schema.Struct({
  review: Schema.NullOr(MergedReview).annotate({
    description: "Null when the commit is not what a branch page was merged as.",
  }),
}).annotate({ identifier: "CommitReview" });
export type CommitReview = typeof CommitReview.Type;

export const PathReviewHistory = Schema.Struct({
  path: Schema.String,
  pages: Schema.Array(MergedReview).annotate({
    description: "Merged branch pages with a finding on the path, the newest merge first.",
  }),
  more: Schema.Boolean.annotate({ description: "Older pages were left out." }),
}).annotate({ identifier: "PathReviewHistory" });
export type PathReviewHistory = typeof PathReviewHistory.Type;

export const MergeOverride = Schema.Struct({
  id: Schema.String,
  by: Schema.NullOr(UserRef),
  reason: Schema.String,
  findingIds: Schema.Array(Schema.String),
  headOid: Oid,
  createdAt: IsoDateTime,
}).annotate({ identifier: "MergeOverride" });
export type MergeOverride = typeof MergeOverride.Type;

export const ReviewRun = Schema.Struct({
  id: Schema.String,
  version: Schema.Int,
  headOid: Oid,
  status: ReviewRunStatus,
  reviewerKinds: Schema.Array(Schema.String),
  trigger: Schema.Literals(["push", "manual"]),
  requestedBy: Schema.NullOr(UserRef),
  model: Schema.NullOr(Schema.String),
  usage: Schema.Struct({
    inputTokens: Schema.Int,
    outputTokens: Schema.Int,
    costUsd: Schema.Finite,
  }),
  findingCount: Schema.Int,
  error: Schema.NullOr(Schema.String),
  startedAt: Schema.NullOr(IsoDateTime),
  finishedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
}).annotate({ identifier: "ReviewRun" });
export type ReviewRun = typeof ReviewRun.Type;

export const ReviewRunRequest = Schema.Struct({
  version: Schema.optionalKey(Schema.Int),
  reviewerKinds: Schema.optionalKey(Schema.Array(ReviewerKindName).check(Schema.isMaxLength(16))),
}).annotate({ identifier: "ReviewRunRequest" });
export type ReviewRunRequest = typeof ReviewRunRequest.Type;

/** What a reviewer that runs outside the forge reports about its run. */
export const ReviewRunUpdate = Schema.Struct({
  status: Schema.optionalKey(ReviewRunStatus),
  model: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(200)))),
  inputTokens: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  outputTokens: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  costUsd: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
  error: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(4000)))),
}).annotate({ identifier: "ReviewRunUpdate" });
export type ReviewRunUpdate = typeof ReviewRunUpdate.Type;

// ---------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------

export const INSTRUCTION_STATUSES = ["queued", "delivered", "answered", "dismissed"] as const;
export const InstructionStatus = Schema.Literals(INSTRUCTION_STATUSES).annotate({
  identifier: "InstructionStatus",
});
export type InstructionStatus = typeof InstructionStatus.Type;

export const INSTRUCTION_SOURCES = ["review_comment", "finding", "text"] as const;
export const InstructionSource = Schema.Literals(INSTRUCTION_SOURCES).annotate({
  identifier: "InstructionSource",
});
export type InstructionSource = typeof InstructionSource.Type;

/** Something a reviewer sent to the agent that wrote the branch. */
export const Instruction = Schema.Struct({
  id: Schema.String,
  source: InstructionSource,
  reviewCommentId: Schema.NullOr(Schema.String),
  findingId: Schema.NullOr(Schema.String),
  body: Schema.String,
  createdBy: Schema.NullOr(UserRef),
  status: InstructionStatus,
  deliveredVia: Schema.NullOr(Schema.String).annotate({
    description: "How it reached the agent: `infrawrench`, `t3`, or `mcp` when the agent asked.",
  }),
  deliveredAt: Schema.NullOr(IsoDateTime),
  answeredInVersion: Schema.NullOr(Schema.Int),
  answeredAt: Schema.NullOr(IsoDateTime),
  dismissedBy: Schema.NullOr(UserRef),
  dismissedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
}).annotate({ identifier: "Instruction" });
export type Instruction = typeof Instruction.Type;

export const InstructionCreate = Schema.Struct({
  source: InstructionSource,
  reviewCommentId: Schema.optionalKey(
    Schema.String.annotate({ description: "For `review_comment`: any comment of the thread." }),
  ),
  findingId: Schema.optionalKey(Schema.String),
  body: Schema.optionalKey(
    NonEmptyMarkdown.annotate({
      description:
        "What the agent is told. Needed for `text`; for the others it is added to the comment or the finding.",
    }),
  ),
}).annotate({ identifier: "InstructionCreate" });
export type InstructionCreate = typeof InstructionCreate.Type;

// ---------------------------------------------------------------------------
// The branch page and the inbox
// ---------------------------------------------------------------------------

export const BRANCH_PAGE_STATES = [
  "merged",
  "closed",
  "agent_working",
  "checks_failing",
  "must_fix_open",
  "needs_your_review",
  "ready_to_merge",
  "waiting",
] as const;
export const BranchPageStateName = Schema.Literals(BRANCH_PAGE_STATES).annotate({
  identifier: "BranchPageStateName",
  description:
    "The first that holds, in this order: `merged`, `closed`, `agent_working` (an instruction is with the agent, or it has recorded work not pushed yet), `checks_failing`, `must_fix_open`, `needs_your_review` (a version the viewer has not reviewed), `ready_to_merge`, else `waiting`.",
});
export type BranchPageStateName = typeof BranchPageStateName.Type;

export const BranchPageState = Schema.Struct({
  state: BranchPageStateName,
  latestVersion: Schema.NullOr(Schema.Int),
  workingOnVersion: Schema.NullOr(Schema.Int).annotate({
    description: "The version the agent's next push makes, while `agent_working`.",
  }),
  viewerReviewedVersion: Schema.NullOr(Schema.Int),
  unreviewedVersions: Schema.Int.annotate({
    description: "Versions newer than the one the viewer last reviewed.",
  }),
  agent: Schema.NullOr(AgentLink),
  openInstructions: Schema.Int.annotate({ description: "Queued or delivered, not answered." }),
  pendingTraceEntries: Schema.Int.annotate({
    description: "Recorded since the last push, waiting for the next version.",
  }),
  findings: FindingsTally,
  checks: Schema.NullOr(StatusState).annotate({ description: "The head's combined status." }),
  reviewRun: Schema.NullOr(ReviewRunStatus).annotate({
    description: "The newest review run on the newest version.",
  }),
  canMerge: Schema.Boolean,
  settings: Schema.Struct({
    reviewAgentsEnabled: Schema.Boolean,
    mustFixBlocksMerge: Schema.Boolean,
  }),
}).annotate({ identifier: "BranchPageState" });
export type BranchPageState = typeof BranchPageState.Type;

/** A branch waiting on the viewer. */
export const ReviewInboxItem = Schema.Struct({
  repository: RepositoryRef,
  key: BranchKey,
  number: Schema.Int,
  title: Schema.String,
  branch: Schema.String,
  draft: Schema.Boolean,
  author: Schema.NullOr(UserRef),
  agent: Schema.NullOr(Schema.Struct({ kind: AgentKind, displayName: Schema.String })),
  latestVersion: Schema.Int,
  reviewedVersion: Schema.NullOr(Schema.Int),
  waitingSince: IsoDateTime.annotate({
    description: "When the oldest version the viewer has not reviewed was pushed.",
  }),
  changes: Schema.Struct({
    versions: Schema.Int,
    comments: Schema.Int,
    findings: Schema.Int,
  }).annotate({ description: "Since the viewer last looked." }),
  mustFixOpen: Schema.Int,
}).annotate({ identifier: "ReviewInboxItem" });
export type ReviewInboxItem = typeof ReviewInboxItem.Type;

export const ReviewInbox = Page(ReviewInboxItem).annotate({ identifier: "ReviewInbox" });
export type ReviewInbox = typeof ReviewInbox.Type;

// ---------------------------------------------------------------------------
// Starting work
// ---------------------------------------------------------------------------

export const StartWork = Schema.Struct({
  ask: NonEmptyMarkdown.annotate({
    description: "What is being asked for. It becomes the branch page's body.",
  }),
  title: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)).annotate({
      description: "The ask's first line when omitted.",
    }),
  ),
  base: Schema.optionalKey(
    Schema.String.annotate({ description: "The branch to start from. The default branch." }),
  ),
  branch: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)).annotate({
      description: "The new branch's name. Made from the title when omitted.",
    }),
  ),
  agent: Schema.optionalKey(AgentLinkSet),
}).annotate({ identifier: "StartWork" });
export type StartWork = typeof StartWork.Type;

// ---------------------------------------------------------------------------
// T3 Code
// ---------------------------------------------------------------------------

export const T3_ENVIRONMENT_STATUSES = ["pending", "connected", "error"] as const;
/** How an environment is added: through T3 Connect, or by an address a person types. */
export const T3_ENVIRONMENT_VIAS = ["t3-connect", "address"] as const;
export type T3EnvironmentVia = (typeof T3_ENVIRONMENT_VIAS)[number];

/** One of the viewer's T3 Code environments. Its tokens are never sent. */
export const T3Environment = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  baseUrl: Schema.String,
  status: Schema.Literals(T3_ENVIRONMENT_STATUSES).annotate({
    description: "`pending` until the person signs in to it from here.",
  }),
  scopes: Schema.Array(Schema.String),
  tokenExpiresAt: Schema.NullOr(IsoDateTime),
  lastError: Schema.NullOr(Schema.String),
  lastUsedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).annotate({ identifier: "T3Environment" });
export type T3Environment = typeof T3Environment.Type;

export const T3EnvironmentCreate = Schema.Struct({
  label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  baseUrl: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048)).annotate({
    description:
      "The environment's address, `https://`. With `via: t3-connect`, its T3 Connect address or the MCP URL T3 Code copies.",
  }),
  via: Schema.optionalKey(
    Schema.Literals(T3_ENVIRONMENT_VIAS).annotate({
      description:
        "`t3-connect`: the address has to be a T3 Connect tunnel's. `address` (the default): any public `https` address.",
    }),
  ),
}).annotate({ identifier: "T3EnvironmentCreate" });
export type T3EnvironmentCreate = typeof T3EnvironmentCreate.Type;

export const T3EnvironmentUpdate = Schema.Struct({
  label: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100))),
}).annotate({ identifier: "T3EnvironmentUpdate" });
export type T3EnvironmentUpdate = typeof T3EnvironmentUpdate.Type;

/** A thread in a T3 Code environment, for picking the one that writes a branch. */
export const T3Thread = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  projectId: Schema.NullOr(Schema.String),
  projectName: Schema.NullOr(Schema.String),
  updatedAt: Schema.NullOr(IsoDateTime),
}).annotate({ identifier: "T3Thread" });
export type T3Thread = typeof T3Thread.Type;

/** A model of a T3 Code environment, for picking the one a thread runs. */
export const T3Model = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  reasoning: Schema.NullOr(
    Schema.Struct({
      optionId: Schema.String,
      levels: Schema.Array(Schema.String),
      default: Schema.NullOr(Schema.String),
    }),
  ).annotate({ description: "The model's reasoning levels, or null when it has none." }),
}).annotate({ identifier: "T3Model" });
export type T3Model = typeof T3Model.Type;

export const T3ModelProvider = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  models: Schema.Array(T3Model),
}).annotate({ identifier: "T3ModelProvider" });
export type T3ModelProvider = typeof T3ModelProvider.Type;

/** What an environment can run, and what the repository's project there runs by default. */
export const T3Models = Schema.Struct({
  providers: Schema.Array(T3ModelProvider),
  default: Schema.NullOr(T3ModelChoice).annotate({
    description:
      "The default model of the environment's project for the repository asked about. Null when it has none, or has no such project yet.",
  }),
}).annotate({ identifier: "T3Models" });
export type T3Models = typeof T3Models.Type;
