/**
 * The viewer's work across repositories: the home page of someone in agent
 * mode, the lists behind it, and where they were mentioned. A "workspace" is
 * the repositories the viewer has a tie to (their own, their organisations',
 * the ones they collaborate on), or one namespace's share of them.
 */
import { Schema } from "effect";
import { BranchKey, IsoDateTime, Page } from "./common";
import { NamespaceRef, UserRef } from "./people";
import { RepositoryRef } from "./repository";
import { AgentKind } from "./review";

export const CHANGE_STATES = [
  "merged",
  "closed",
  "agent_working",
  "changes_requested",
  "approved",
  "needs_review",
] as const;
export const ChangeState = Schema.Literals(CHANGE_STATES).annotate({
  identifier: "ChangeState",
  description:
    "The first that holds, in this order: `merged`, `closed`, `agent_working` (an instruction is with the agent, or it has recorded work not pushed yet), `changes_requested` (the newest verdict asks for changes, or a must-fix finding is open), `approved` (the newest verdict approves), else `needs_review`.",
});
export type ChangeState = typeof ChangeState.Type;

const changeFields = {
  repository: RepositoryRef,
  key: BranchKey,
  number: Schema.Int,
  title: Schema.String,
  branch: Schema.String,
  draft: Schema.Boolean,
  state: ChangeState,
  summary: Schema.NullOr(Schema.String).annotate({
    description: "The first line of the description, shortened. Null when it has none.",
  }),
  headOid: Schema.String,
  author: Schema.NullOr(UserRef),
  agent: Schema.NullOr(Schema.Struct({ kind: AgentKind, displayName: Schema.String })),
  latestVersion: Schema.NullOr(Schema.Int),
  mustFixOpen: Schema.Int,
  size: Schema.Struct({
    additions: Schema.Int,
    deletions: Schema.Int,
    changedFiles: Schema.Int,
  }).annotate({ description: "The whole change, base to head." }),
  updatedAt: IsoDateTime,
} as const;

/** A branch in a list of work. */
export const ChangeSummary = Schema.Struct(changeFields).annotate({ identifier: "ChangeSummary" });
export type ChangeSummary = typeof ChangeSummary.Type;

export const SUGGESTION_REASONS = [
  "assigned",
  "reviewed_before",
  "commented",
  "pushes_to_repository",
] as const;
export const SuggestionReason = Schema.Struct({
  kind: Schema.Literals(SUGGESTION_REASONS).annotate({
    description:
      "`assigned`: the viewer is an assignee. `reviewed_before`: they marked `version` as reviewed and there are newer ones. `commented`: they commented in a review, last on `version`. `pushes_to_repository`: they have pushed to this repository.",
  }),
  version: Schema.NullOr(Schema.Int),
}).annotate({ identifier: "SuggestionReason" });
export type SuggestionReason = typeof SuggestionReason.Type;

/** Someone else's open branch with a version the viewer has not reviewed. */
export const SuggestedReview = Schema.Struct({
  ...changeFields,
  reviewedVersion: Schema.NullOr(Schema.Int),
  reasons: Schema.Array(SuggestionReason).annotate({
    description: "Why it is suggested, the strongest first. May be empty.",
  }),
}).annotate({ identifier: "SuggestedReview" });
export type SuggestedReview = typeof SuggestedReview.Type;

export const ACTIVITY_TYPES = [
  "pushed",
  "approved",
  "changes_requested",
  "commented",
  "findings",
  "merged",
] as const;
export const ActivityEvent = Schema.Struct({
  id: Schema.String,
  type: Schema.Literals(ACTIVITY_TYPES).annotate({
    description:
      "`pushed`: a version was pushed. `approved`, `changes_requested`, `commented`: a review was submitted. `findings`: a review run finished with findings. `merged`: the branch page was merged.",
  }),
  at: IsoDateTime,
  actor: Schema.NullOr(UserRef).annotate({ description: "Null for a review run." }),
  agent: Schema.NullOr(Schema.String).annotate({
    description: "The agent that pushed, by name, when one did.",
  }),
  repository: RepositoryRef,
  key: BranchKey,
  number: Schema.Int,
  title: Schema.String,
  version: Schema.NullOr(Schema.Int),
  findings: Schema.NullOr(Schema.Struct({ found: Schema.Int, mustFix: Schema.Int })),
}).annotate({ identifier: "ActivityEvent" });
export type ActivityEvent = typeof ActivityEvent.Type;

const Listed = <S extends Schema.Top>(item: S) =>
  Schema.Struct({
    count: Schema.Int.annotate({ description: "All of them, not only the ones listed." }),
    items: Schema.Array(item),
  });

/** How far back the home page may look, in days. */
export const WORKSPACE_WINDOWS = [1, 7, 30] as const;
export type WorkspaceWindow = (typeof WORKSPACE_WINDOWS)[number];

export const WorkspaceHome = Schema.Struct({
  namespace: Schema.NullOr(NamespaceRef).annotate({
    description: "The namespace asked for. Null for every repository the viewer has a tie to.",
  }),
  shared: Schema.Boolean.annotate({
    description:
      "Other people work here too: an organisation's namespace, or anyone else's open branch.",
  }),
  activeBranches: Schema.Int.annotate({ description: "Open branch pages." }),
  agentsWorking: Schema.Int.annotate({ description: "Of those, the ones in `agent_working`." }),
  pushed: Schema.Struct({
    days: Schema.Int,
    versions: Schema.Int,
    repositories: Schema.Array(RepositoryRef).annotate({
      description: "Repositories pushed to in the window, the most pushes first. At most six.",
    }),
  }),
  yours: Listed(ChangeSummary).annotate({
    description: "Open branches the viewer wrote or connected an agent to, newest activity first.",
  }),
  team: Listed(ChangeSummary).annotate({ description: "Everyone else's open branches." }),
  suggested: Listed(SuggestedReview),
  activity: Schema.Array(ActivityEvent).annotate({ description: "Newest first, in the window." }),
}).annotate({ identifier: "WorkspaceHome" });
export type WorkspaceHome = typeof WorkspaceHome.Type;

export const ChangeList = Page(ChangeSummary).annotate({ identifier: "ChangeList" });
export type ChangeList = typeof ChangeList.Type;

/** A comment that names the viewer with `@username`. */
export const Mention = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["comment", "review_comment"]),
  repository: RepositoryRef,
  number: Schema.Int,
  title: Schema.String,
  branch: Schema.NullOr(BranchKey).annotate({
    description: "The page's key when the comment is on a branch's page. Null for an issue's.",
  }),
  author: Schema.NullOr(UserRef),
  excerpt: Schema.String.annotate({ description: "The line that names them, shortened." }),
  createdAt: IsoDateTime,
}).annotate({ identifier: "Mention" });
export type Mention = typeof Mention.Type;

export const MentionList = Page(Mention).annotate({ identifier: "MentionList" });
export type MentionList = typeof MentionList.Type;
