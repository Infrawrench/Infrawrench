/**
 * git.infrawrench.com: reviewing work a branch at a time. A branch is a
 * record of versions (one per push, kept through force pushes), with what
 * the agent that wrote it recorded (traces), what review agents found
 * (findings), what reviewers sent back (instructions) and which agent is
 * behind it. The branch page is the pull request shown another way, so
 * everything here hangs off `git_pull_requests` and the tables in
 * `git-schema.ts`; merging, protection and review threads are those tables'.
 *
 * The objects are not here. Each version's commit is kept alive in the
 * repository's Durable Object by a ref under `refs/infrawrench/versions/`,
 * which no client is shown and no push may write. Thirty days after a branch
 * is merged or deleted that ref is removed (the worker's `review/prune.ts`)
 * and the row is marked `pruned_at`. The row stays, and with it everything
 * that hangs off it: traces, findings, review comments and the numbers.
 *
 * Lives in its own module and is re-exported from `schema.ts`, the
 * satellite-schema convention.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { users } from "./core-schema.js";
import {
  type GitDiffSide,
  gitPullRequests,
  gitRepositories,
  gitReviewComments,
} from "./git-schema.js";

export type GitTraceKind = "ask" | "step" | "decision" | "evidence" | "doubt" | "note";
/** The reviewers the forge runs itself. A row may name another: the column is text. */
export type GitReviewerKind = "general" | "security" | "tests" | "terraform" | "intent";
export type GitFindingSeverity = "must_fix" | "should_fix" | "note";
export type GitFindingStatus = "open" | "fixed" | "dismissed";
export type GitReviewRunStatus = "queued" | "running" | "done" | "failed";
export type GitInstructionStatus = "queued" | "delivered" | "answered" | "dismissed";
export type GitInstructionSource = "review_comment" | "finding" | "text";
export type GitAgentKind = "infrawrench" | "t3" | "mcp";
export type GitT3EnvironmentStatus = "pending" | "connected" | "error";

/** Who acted, when it was an agent and that is known: its kind, its name, and the session it ran in. */
export interface GitAgentIdentity {
  readonly kind: GitAgentKind | (string & {});
  readonly name: string;
  /** The agent's own name for the session or thread, when it gave one. */
  readonly sessionRef?: string | null;
}

/** Lines a trace entry is about. */
export interface GitTraceAnchor {
  readonly path: string;
  readonly startLine?: number | null;
  readonly endLine?: number | null;
}

/** What a trace entry of kind `evidence` ran and saw. Masked before it is stored. */
export interface GitTraceEvidence {
  readonly command?: string | null;
  readonly exitCode?: number | null;
  /** An excerpt, not the log. */
  readonly output?: string | null;
  /** The Infrawrench CI run that is the evidence. */
  readonly ciRunId?: string | null;
  readonly url?: string | null;
}

/** What backs a finding. */
export interface GitFindingEvidence {
  readonly kind: "code" | "command" | "test" | "ci" | "reference" | (string & {});
  readonly text: string;
  readonly url?: string | null;
}

/**
 * One push to a branch that is not the default branch. Numbered within a
 * lineage: a branch deleted and made again starts lineage `n + 1` at version
 * 1, and a branch restored at its last commit carries on. The repository's
 * Durable Object assigns both numbers in the transaction that moves the
 * branch (`worker/src/repo/do/versions.ts`); the queue consumer copies them
 * here, so the unique index is also what makes a second delivery harmless.
 */
export const gitBranchVersions = pgTable(
  "git_branch_versions",
  {
    id: text("id").primaryKey(),
    /** The repository the branch is in: a pull request's head repository. */
    repositoryId: text("repository_id")
      .notNull()
      .references(() => gitRepositories.id, { onDelete: "cascade" }),
    /** Short (`feature/x`). */
    branch: text("branch").notNull(),
    lineage: integer("lineage").notNull(),
    number: integer("number").notNull(),
    tipOid: text("tip_oid").notNull(),
    /** The merge base with `targetRef` when the version was recorded. Null when they share no history. */
    baseOid: text("base_oid"),
    /** The branch `baseOid` was taken against: the pull request's base, else the default branch. */
    targetRef: text("target_ref"),
    /** The branch's commit before this push. Null for the first version of a lineage. */
    previousOid: text("previous_oid"),
    /** The push was not a fast-forward: a rebase, an amend, a reset. */
    forced: boolean("forced").notNull().default(false),
    pusherUserId: text("pusher_user_id").references(() => users.id, { onDelete: "set null" }),
    /** The credential that pushed (`user`, `api-key`, `deploy-key`, `job`), from the push event. */
    pusherKind: text("pusher_kind"),
    /** The agent that made the push, when the pull request names one. */
    agent: jsonb("agent").$type<GitAgentIdentity>(),
    /** The pull request whose head this branch was when the version was recorded, or was given since. */
    pullRequestId: text("pull_request_id").references(() => gitPullRequests.issueId, {
      onDelete: "set null",
    }),
    // Against `baseOid`, when the storage answered. Null otherwise.
    commitsCount: integer("commits_count"),
    additions: integer("additions"),
    deletions: integer("deletions"),
    changedFiles: integer("changed_files"),
    /** When the push landed. */
    createdAt: timestamp("created_at").notNull().defaultNow(),
    /**
     * When the ref that keeps its commit goes: thirty days after the branch
     * was merged or deleted. Null while the branch is alive.
     */
    pruneAfter: timestamp("prune_after"),
    /**
     * When that ref went. The row is the record from then on: its commit may
     * no longer be readable, so a diff of it is only served when a branch or
     * a tag still reaches both ends.
     */
    prunedAt: timestamp("pruned_at"),
  },
  (t) => ({
    numberIdx: uniqueIndex("git_branch_versions_number_idx").on(
      t.repositoryId,
      t.branch,
      t.lineage,
      t.number,
    ),
    pullIdx: index("git_branch_versions_pull_idx").on(t.pullRequestId, t.number),
    // The pruning pass: what is due and still has its ref.
    pruneIdx: index("git_branch_versions_prune_idx")
      .on(t.pruneAfter)
      .where(sql`${t.pruneAfter} is not null and ${t.prunedAt} is null`),
  }),
);

/** The last version of a pull request a person marked as reviewed: where "since you last looked" starts. */
export const gitVersionReviews = pgTable(
  "git_version_reviews",
  {
    pullRequestId: text("pull_request_id")
      .notNull()
      .references(() => gitPullRequests.issueId, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The numbers below say the same, and outlive the row. */
    versionId: text("version_id").references(() => gitBranchVersions.id, { onDelete: "set null" }),
    lineage: integer("lineage").notNull(),
    versionNumber: integer("version_number").notNull(),
    tipOid: text("tip_oid").notNull(),
    reviewedAt: timestamp("reviewed_at").notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.pullRequestId, t.userId] }),
    // The inbox: every pull request a person has looked at.
    userIdx: index("git_version_reviews_user_idx").on(t.userId),
  }),
);

/**
 * What an agent recorded while it worked: the ask, steps, decisions,
 * evidence, doubts. Written to a branch with no version yet; the next push
 * to that branch claims every waiting entry for the version it makes. Bodies
 * and evidence are masked before they are stored (the worker's
 * `review/masking.ts`).
 */
export const gitTraceEntries = pgTable(
  "git_trace_entries",
  {
    id: text("id").primaryKey(),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => gitRepositories.id, { onDelete: "cascade" }),
    branch: text("branch").notNull(),
    /**
     * Null until the next push to the branch. A version's row outlives its
     * pruning, so its entries do too: they go only with the repository.
     */
    versionId: text("version_id").references(() => gitBranchVersions.id, { onDelete: "cascade" }),
    kind: text("kind").$type<GitTraceKind>().notNull(),
    /** Markdown. */
    body: text("body").notNull(),
    anchors: jsonb("anchors").$type<GitTraceAnchor[]>().notNull().default([]),
    evidence: jsonb("evidence").$type<GitTraceEvidence>(),
    /** The person whose credential wrote it. Null for a CI job. */
    authorUserId: text("author_user_id").references(() => users.id, { onDelete: "set null" }),
    agent: jsonb("agent").$type<GitAgentIdentity>(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    versionIdx: index("git_trace_entries_version_idx").on(t.versionId, t.createdAt),
    // What a push claims, and what a branch page shows as still to come.
    pendingIdx: index("git_trace_entries_pending_idx")
      .on(t.repositoryId, t.branch, t.createdAt)
      .where(sql`${t.versionId} is null`),
  }),
);

/** One run of the review agents over one version. */
export const gitReviewRuns = pgTable(
  "git_review_runs",
  {
    id: text("id").primaryKey(),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => gitRepositories.id, { onDelete: "cascade" }),
    pullRequestId: text("pull_request_id")
      .notNull()
      .references(() => gitPullRequests.issueId, { onDelete: "cascade" }),
    versionId: text("version_id").references(() => gitBranchVersions.id, { onDelete: "set null" }),
    versionNumber: integer("version_number").notNull(),
    /** The commit reviewed. */
    headOid: text("head_oid").notNull(),
    status: text("status").$type<GitReviewRunStatus>().notNull().default("queued"),
    reviewerKinds: jsonb("reviewer_kinds").$type<string[]>().notNull().default([]),
    /** `push` for the run a new version starts, `manual` for one somebody asked for. */
    trigger: text("trigger").$type<"push" | "manual">().notNull().default("push"),
    requestedByUserId: text("requested_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    model: text("model"),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    /** Millionths of a US dollar. */
    costMicros: bigint("cost_micros", { mode: "number" }).notNull().default(0),
    error: text("error"),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    pullIdx: index("git_review_runs_pull_idx").on(t.pullRequestId, t.createdAt),
    // What is waiting to run or running.
    activeIdx: index("git_review_runs_active_idx")
      .on(t.status, t.createdAt)
      .where(sql`${t.status} in ('queued', 'running')`),
  }),
);

/**
 * Something a review agent found on a version. Carried from version to
 * version by `fingerprint`, which is what remembers a dismissal: the same
 * finding raised again on a later version stays dismissed.
 */
export const gitReviewFindings = pgTable(
  "git_review_findings",
  {
    id: text("id").primaryKey(),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => gitRepositories.id, { onDelete: "cascade" }),
    pullRequestId: text("pull_request_id")
      .notNull()
      .references(() => gitPullRequests.issueId, { onDelete: "cascade" }),
    runId: text("run_id").references(() => gitReviewRuns.id, { onDelete: "set null" }),
    /** The version it was first raised on. */
    versionId: text("version_id").references(() => gitBranchVersions.id, { onDelete: "set null" }),
    versionNumber: integer("version_number").notNull(),
    /** The newest version it was seen on, while it stays open. */
    lastSeenVersionNumber: integer("last_seen_version_number").notNull(),
    reviewerKind: text("reviewer_kind").$type<GitReviewerKind | (string & {})>().notNull(),
    /** Stable across versions for the same finding: reviewer, path and what it says, not the line. */
    fingerprint: text("fingerprint").notNull(),
    /** Null for a finding about the change as a whole. */
    path: text("path"),
    side: text("side").$type<GitDiffSide>().notNull().default("RIGHT"),
    startLine: integer("start_line"),
    endLine: integer("end_line"),
    /** The commit the lines above are numbered in. */
    commitOid: text("commit_oid").notNull(),
    severity: text("severity").$type<GitFindingSeverity>().notNull(),
    title: text("title").notNull(),
    /** Markdown. */
    body: text("body").notNull().default(""),
    evidence: jsonb("evidence").$type<GitFindingEvidence[]>().notNull().default([]),
    status: text("status").$type<GitFindingStatus>().notNull().default("open"),
    fixedInVersionNumber: integer("fixed_in_version_number"),
    dismissedByUserId: text("dismissed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    dismissedAt: timestamp("dismissed_at"),
    dismissalReason: text("dismissal_reason"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    pullStatusIdx: index("git_review_findings_pull_status_idx").on(t.pullRequestId, t.status),
    fingerprintIdx: uniqueIndex("git_review_findings_fingerprint_idx").on(
      t.pullRequestId,
      t.fingerprint,
    ),
    // A file's review history: the findings of merged branch pages on its path.
    pathIdx: index("git_review_findings_path_idx")
      .on(t.repositoryId, t.path)
      .where(sql`${t.path} is not null`),
  }),
);

/**
 * An administrator merging past open must-fix findings: who, why, and which
 * findings they saw. A finding raised after the override is not covered by
 * it.
 */
export const gitMergeOverrides = pgTable(
  "git_merge_overrides",
  {
    id: text("id").primaryKey(),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => gitRepositories.id, { onDelete: "cascade" }),
    pullRequestId: text("pull_request_id")
      .notNull()
      .references(() => gitPullRequests.issueId, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    reason: text("reason").notNull(),
    findingIds: jsonb("finding_ids").$type<string[]>().notNull().default([]),
    /** The head it was given on. */
    headOid: text("head_oid").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    pullIdx: index("git_merge_overrides_pull_idx").on(t.pullRequestId, t.createdAt),
  }),
);

/** Something a reviewer sent to the agent that wrote the branch: a comment, a finding, or words of their own. */
export const gitInstructions = pgTable(
  "git_instructions",
  {
    id: text("id").primaryKey(),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => gitRepositories.id, { onDelete: "cascade" }),
    pullRequestId: text("pull_request_id")
      .notNull()
      .references(() => gitPullRequests.issueId, { onDelete: "cascade" }),
    source: text("source").$type<GitInstructionSource>().notNull(),
    reviewCommentId: text("review_comment_id").references(() => gitReviewComments.id, {
      onDelete: "set null",
    }),
    findingId: text("finding_id").references(() => gitReviewFindings.id, { onDelete: "set null" }),
    /** What the agent is told, as it was when sent. Markdown. */
    body: text("body").notNull(),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    status: text("status").$type<GitInstructionStatus>().notNull().default("queued"),
    /** How it reached the agent: `infrawrench`, `t3`, `mcp` (the agent asked for it). */
    deliveredVia: text("delivered_via"),
    deliveredAt: timestamp("delivered_at"),
    /** The version that answers it. */
    answeredInVersionId: text("answered_in_version_id").references(() => gitBranchVersions.id, {
      onDelete: "set null",
    }),
    answeredInVersionNumber: integer("answered_in_version_number"),
    answeredAt: timestamp("answered_at"),
    dismissedByUserId: text("dismissed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    dismissedAt: timestamp("dismissed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    pullStatusIdx: index("git_instructions_pull_status_idx").on(t.pullRequestId, t.status),
  }),
);

/**
 * A person's connection to a T3 Code environment, where the forge is an
 * OAuth client of that environment's MCP server. The client secret, the
 * tokens and the PKCE verifier of a sign-in in progress are one JSON object
 * encrypted with server-core's `encrypt` under `ENCRYPTION_MASTER_KEY`, bound
 * to the row (`gitT3Environment:<id>:credentials`).
 */
export const gitT3Environments = pgTable(
  "git_t3_environments",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    /** The environment's origin, no trailing slash. */
    baseUrl: text("base_url").notNull(),
    status: text("status").$type<GitT3EnvironmentStatus>().notNull().default("pending"),
    /** From dynamic client registration. Not a secret. */
    oauthClientId: text("oauth_client_id"),
    /** The authorization server's endpoints, as discovered. */
    oauthMetadata: jsonb("oauth_metadata").$type<{
      issuer?: string;
      authorizationEndpoint?: string;
      tokenEndpoint?: string;
      registrationEndpoint?: string;
      revocationEndpoint?: string;
    }>(),
    credentialsCiphertext: text("credentials_ciphertext"),
    credentialsIv: text("credentials_iv"),
    /** The `state` of a sign-in in progress, and when it stops being accepted. */
    oauthState: text("oauth_state"),
    oauthStateExpiresAt: timestamp("oauth_state_expires_at"),
    tokenExpiresAt: timestamp("token_expires_at"),
    scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
    lastError: text("last_error"),
    lastUsedAt: timestamp("last_used_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    userUrlIdx: uniqueIndex("git_t3_environments_user_url_idx").on(t.userId, t.baseUrl),
    stateIdx: uniqueIndex("git_t3_environments_state_idx")
      .on(t.oauthState)
      .where(sql`${t.oauthState} is not null`),
  }),
);

/** The agent that writes a pull request's branch. One per pull request. */
export const gitAgentLinks = pgTable(
  "git_agent_links",
  {
    pullRequestId: text("pull_request_id")
      .primaryKey()
      .references(() => gitPullRequests.issueId, { onDelete: "cascade" }),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => gitRepositories.id, { onDelete: "cascade" }),
    kind: text("kind").$type<GitAgentKind>().notNull(),
    displayName: text("display_name").notNull(),
    /**
     * What names the agent where it runs: a T3 Code thread and project
     * (`threadId`, `projectId`), an Infrawrench agent session
     * (`sessionId`, `organizationId`), or whatever an MCP client gave.
     */
    externalRefs: jsonb("external_refs").$type<Record<string, string>>().notNull().default({}),
    /** The T3 Code environment it runs in, for `t3`. */
    t3EnvironmentId: text("t3_environment_id").references(() => gitT3Environments.id, {
      onDelete: "set null",
    }),
    connectedByUserId: text("connected_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    repositoryIdx: index("git_agent_links_repository_idx").on(t.repositoryId),
  }),
);

/** A repository's review settings. No row means the defaults below. */
export const gitReviewSettings = pgTable("git_review_settings", {
  repositoryId: text("repository_id")
    .primaryKey()
    .references(() => gitRepositories.id, { onDelete: "cascade" }),
  /** No longer read: every branch gets a page on its first push, always. Kept, unread, in storage. */
  autoOpenBranchPages: boolean("auto_open_branch_pages").notNull().default(true),
  reviewAgentsEnabled: boolean("review_agents_enabled").notNull().default(false),
  reviewerKinds: jsonb("reviewer_kinds").$type<string[]>().notNull().default(["general"]),
  /** An open must-fix finding holds a merge until an administrator overrides it. */
  mustFixBlocksMerge: boolean("must_fix_blocks_merge").notNull().default(true),
  updatedByUserId: text("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
