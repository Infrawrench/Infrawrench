/**
 * git.infrawrench.com (`git/`): everything the forge knows about people and
 * repositories. The objects themselves are not here: packs live in R2 and
 * each repository's refs in its Durable Object, both keyed by the
 * repository's id, so a rename or a transfer changes one row and moves
 * nothing.
 *
 * Ids are UUID strings in `text` columns, like the rest of the schema. Names
 * that are unique without regard to case (`slug`, a repository's and a
 * label's `name`) keep the spelling the person chose and carry a lowercased
 * twin that the unique index is on.
 *
 * Lives in its own module and is re-exported from `schema.ts`, the
 * satellite-schema convention. The forge's Terraform tables are a module of
 * their own.
 */
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { organizations, users } from "./core-schema.js";

export type GitNamespaceKind = "user" | "org";
export type GitVisibility = "public" | "private";
/** What a collaborator may do; also the answer of the worker's `repoAccess`, with `none`. */
export type GitRepoRole = "read" | "triage" | "write" | "admin";
export type GitMergeMethod = "merge" | "squash" | "rebase";
export type GitTokenScope = "repo:read" | "repo:write";
export type GitIssueState = "open" | "closed";
export type GitIssueStateReason = "completed" | "not_planned";
export type GitMergeableState = "unknown" | "checking" | "clean" | "conflicting";
export type GitReviewState =
  "pending" | "commented" | "approved" | "changes_requested" | "dismissed";
export type GitDiffSide = "LEFT" | "RIGHT";
export type GitStatusState = "pending" | "success" | "failure" | "error";
export type GitMilestoneState = "open" | "closed";
/** How a person reads a branch: the versioned branch page (`agent`) or the pull request as it was (`classic`). */
export type GitReviewMode = "agent" | "classic";

/**
 * A username or an organisation's name: the first path segment of every
 * repository URL. Owned by exactly one user or one Infrawrench organisation,
 * and each of those has at most one.
 */
export const gitNamespaces = pgTable(
  "git_namespaces",
  {
    id: text("id").primaryKey(),
    /** As the owner spelled it. */
    slug: text("slug").notNull(),
    /** `lower(slug)`: what URLs resolve by and what is unique. */
    slugLower: text("slug_lower").notNull(),
    kind: text("kind").$type<GitNamespaceKind>().notNull(),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    displayName: text("display_name"),
    description: text("description"),
    avatarUrl: text("avatar_url"),
    websiteUrl: text("website_url"),
    location: text("location"),
    /** Who claimed it: the user themselves, or the `git:admin` holder for an organisation. */
    claimedByUserId: text("claimed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /** The last rename, which the rename limit counts from. */
    renamedAt: timestamp("renamed_at"),
    /**
     * A person's own namespace only: the organisation its repositories run CI
     * and review agents in, and are billed to. Set by the person, to an
     * organisation they belong to. It counts only while they still do
     * (`git/workspace.ts` reads it through their membership), so leaving the
     * organisation ends it without anything being written.
     */
    workspaceOrganizationId: text("workspace_organization_id").references(() => organizations.id, {
      onDelete: "set null",
    }),
    /**
     * An organisation's namespace only: when its subscription was last seen to
     * carry the metered storage price (`git/billing.ts`
     * `ensureGitStoragePrices`). Null until the poller has looked.
     */
    storagePriceEnsuredAt: timestamp("storage_price_ensured_at"),
    /**
     * What a new repository here starts as when its creator does not say. Set
     * for an organisation in the app (Settings > Git); a creator can always
     * choose the other, within the plan's limits (`git/quota.ts`).
     */
    defaultVisibility: text("default_visibility")
      .$type<GitVisibility>()
      .notNull()
      .default("private"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    slugIdx: uniqueIndex("git_namespaces_slug_idx").on(t.slugLower),
    userIdx: uniqueIndex("git_namespaces_user_idx").on(t.userId),
    orgIdx: uniqueIndex("git_namespaces_org_idx").on(t.organizationId),
    ownerCheck: check(
      "git_namespaces_owner_check",
      sql`(${t.kind} = 'user' AND ${t.userId} IS NOT NULL AND ${t.organizationId} IS NULL) OR (${t.kind} = 'org' AND ${t.organizationId} IS NOT NULL AND ${t.userId} IS NULL)`,
    ),
    workspaceCheck: check(
      "git_namespaces_workspace_check",
      sql`${t.kind} = 'user' OR ${t.workspaceOrganizationId} IS NULL`,
    ),
  }),
);

/**
 * A person on the forge, from their first sign-in there. The row is the
 * username onboarding state: `onboardedAt` is null until they claim a
 * username (their `git_namespaces` row), and until then they read like a
 * signed-out visitor and cannot write.
 */
export const gitUsers = pgTable("git_users", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  /** A free, valid username offered on the username page; they may type another. */
  suggestedSlug: text("suggested_slug"),
  onboardedAt: timestamp("onboarded_at"),
  /** The WorkOS profile picture at last sign-in, shown until the namespace has its own. */
  avatarUrl: text("avatar_url"),
  lastSeenAt: timestamp("last_seen_at"),
  /** No longer read: there is one UI, and every branch has a page. Kept, unread, in storage. */
  reviewMode: text("review_mode").$type<GitReviewMode>().notNull().default("agent"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/**
 * An extra address a person's commits carry in one place
 * (`git/commit-emails.ts`): in one organisation's repositories
 * (`organizationId` set), or in the repositories of the person's own
 * namespace (`organizationId` null). There a commit with it is shown as
 * theirs from the moment it is added, with no proof asked: it is a layer over
 * what the commit says, never sitewide, and an organisation's counts only
 * while the person is still a member.
 *
 * `active` is whether the row counts. An organisation has one active row per
 * address: a second member who adds an address someone holds unproved gets a
 * row that waits (`active` false) until they prove it, which takes it over.
 *
 * Proving is optional (`verifiedAt`), with a code mailed to the address. The
 * forge only asks (`sendRequestedAt`); the app's poller makes the code, keeps
 * its hash here and sends it (`sentAt`), because the forge's Worker holds no
 * mail key. The code is good until `codeExpiresAt`, for a few tries
 * (`codeAttempts`), once.
 */
export const gitCommitEmails = pgTable(
  "git_commit_emails",
  {
    id: text("id").primaryKey(),
    /** The organisation the address counts in. Null: the person's own namespace. */
    organizationId: text("organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Lowercased. */
    email: text("email").notNull(),
    /** Whether the row counts. False: it waits for its proof, because another member holds the address. */
    active: boolean("active").notNull().default(true),
    /** When the person proved the address is theirs. Null: never asked, or not yet. */
    verifiedAt: timestamp("verified_at"),
    /** SHA-256 of the row's id and the code, hex. Null until one is sent and once it is used. */
    codeHash: text("code_hash"),
    codeExpiresAt: timestamp("code_expires_at"),
    /** Wrong codes tried against the current one. */
    codeAttempts: integer("code_attempts").notNull().default(0),
    /** When the person last asked for a code. */
    sendRequestedAt: timestamp("send_requested_at"),
    /** When the app last took the request to send; before `sendRequestedAt` means one is owed. */
    sentAt: timestamp("sent_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    /** One row per person and address in an organisation. */
    ownIdx: uniqueIndex("git_commit_emails_own_idx").on(t.organizationId, t.userId, t.email),
    /**
     * One row per person and address in their own namespace: Postgres counts
     * nulls as distinct, so the index above does not hold these.
     */
    personalIdx: uniqueIndex("git_commit_emails_personal_idx")
      .on(t.userId, t.email)
      .where(sql`${t.organizationId} IS NULL`),
    /**
     * An address is one member's in an organisation, proved or not. A
     * person's own namespace has nobody else in it, and its rows (a null
     * organisation, which Postgres counts as distinct) are outside this
     * index: the same address can be someone else's in an organisation.
     */
    activeIdx: uniqueIndex("git_commit_emails_active_idx")
      .on(t.organizationId, t.email)
      .where(sql`${t.active}`),
    /** The poller's question: which rows are owed a code. */
    owedIdx: index("git_commit_emails_owed_idx")
      .on(t.sendRequestedAt)
      .where(sql`${t.verifiedAt} IS NULL AND ${t.sendRequestedAt} IS NOT NULL`),
    userIdx: index("git_commit_emails_user_idx").on(t.userId),
  }),
);

/**
 * A short username kept for the person who is paying for it
 * (`git/short-usernames.ts`). One per person and one per name. It counts only
 * until `expiresAt`: nothing sweeps it, an expired row is simply not a hold,
 * and the next hold on the name or by the person replaces it. The payment
 * that settles deletes it.
 */
export const gitUsernameHolds = pgTable(
  "git_username_holds",
  {
    id: text("id").primaryKey(),
    /** As the person spelled it. */
    slug: text("slug").notNull(),
    slugLower: text("slug_lower").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The organisation chosen on the username page, connected when the name is claimed. */
    workspaceOrganizationId: text("workspace_organization_id").references(() => organizations.id, {
      onDelete: "set null",
    }),
    /** The forge page the browser returns to after Checkout: a path on that site. */
    returnPath: text("return_path").notNull(),
    /** The Checkout session opened for it, once the app has opened one. */
    stripeCheckoutSessionId: text("stripe_checkout_session_id"),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    slugIdx: uniqueIndex("git_username_holds_slug_idx").on(t.slugLower),
    userIdx: uniqueIndex("git_username_holds_user_idx").on(t.userId),
  }),
);

/** `claimed`: the name is theirs. `refund_due`: paid, the name was gone, the refund is not confirmed yet. */
export type GitUsernamePurchaseStatus = "claimed" | "refund_due" | "refunded";

/**
 * Every settled payment for a short username: who paid, for which name, how
 * much, and what came of it. One row per Checkout session, which is what
 * makes the webhook idempotent. Never deleted: it is the record of the
 * payment, kept (without its person) when the account goes.
 */
export const gitUsernamePurchases = pgTable(
  "git_username_purchases",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    /** The name paid for, as spelled. */
    slug: text("slug").notNull(),
    /** A first username, or a change to this one. */
    kind: text("kind").$type<"claim" | "rename">().notNull(),
    status: text("status").$type<GitUsernamePurchaseStatus>().notNull(),
    stripeCheckoutSessionId: text("stripe_checkout_session_id").notNull(),
    stripePaymentIntentId: text("stripe_payment_intent_id"),
    amountPaidCents: integer("amount_paid_cents"),
    currency: text("currency"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    sessionIdx: uniqueIndex("git_username_purchases_session_idx").on(t.stripeCheckoutSessionId),
    userIdx: index("git_username_purchases_user_idx").on(t.userId, t.createdAt),
  }),
);

export const gitRepositories = pgTable(
  "git_repositories",
  {
    /** Also the name of its Durable Object and its R2 prefix (`repos/<id>/`). */
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id")
      .notNull()
      // Deleting an account or an organisation in the app takes its namespace
      // and repositories' rows with it; the objects in R2 and the Durable
      // Objects are then reaped by id (the worker's storage sweep).
      .references(() => gitNamespaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    nameLower: text("name_lower").notNull(),
    description: text("description"),
    homepageUrl: text("homepage_url"),
    topics: jsonb("topics").$type<string[]>().notNull().default([]),
    visibility: text("visibility").$type<GitVisibility>().notNull().default("private"),
    defaultBranch: text("default_branch").notNull().default("main"),
    /** The repository it was forked from. Null once the parent is deleted; `isFork` stays. */
    forkOfId: text("fork_of_id").references((): AnyPgColumn => gitRepositories.id, {
      onDelete: "set null",
    }),
    isFork: boolean("is_fork").notNull().default(false),
    archived: boolean("archived").notNull().default(false),
    archivedAt: timestamp("archived_at"),
    /** No branch yet: nothing has been pushed. */
    isEmpty: boolean("is_empty").notNull().default(true),
    hasIssues: boolean("has_issues").notNull().default(true),
    /** No longer read: every branch has a page. Kept, unread, in storage. */
    hasPullRequests: boolean("has_pull_requests").notNull().default(true),
    allowMergeCommit: boolean("allow_merge_commit").notNull().default(true),
    allowSquash: boolean("allow_squash").notNull().default(true),
    allowRebase: boolean("allow_rebase").notNull().default(true),
    defaultMergeMethod: text("default_merge_method")
      .$type<GitMergeMethod>()
      .notNull()
      .default("merge"),
    deleteBranchOnMerge: boolean("delete_branch_on_merge").notNull().default(false),
    /** By bytes, from the default branch's tree; null until the first push is analysed. */
    primaryLanguage: text("primary_language"),
    /**
     * Bytes of each language on the default branch, most first, as the forge's
     * language bar shows them (contract `languages.ts`). Empty until measured.
     */
    languages: jsonb("languages")
      .$type<Array<{ name: string; bytes: number }>>()
      .notNull()
      .default([]),
    /** The default branch's commit `languages` was measured at, so a push that did not move it measures nothing. */
    languagesCommit: text("languages_commit"),
    /** Bytes of packs in R2, sampled after each push and repack. What storage is metered on. */
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull().default(0),
    pushedAt: timestamp("pushed_at"),
    // Denormalised, each kept by the statement that changes what it counts.
    starsCount: integer("stars_count").notNull().default(0),
    forksCount: integer("forks_count").notNull().default(0),
    openIssuesCount: integer("open_issues_count").notNull().default(0),
    openPullRequestsCount: integer("open_pull_requests_count").notNull().default(0),
    branchesCount: integer("branches_count").notNull().default(0),
    tagsCount: integer("tags_count").notNull().default(0),
    /**
     * The next issue or pull request number: the two share one sequence.
     * Taken with `UPDATE ... SET next_number = next_number + 1 RETURNING`,
     * in the transaction that inserts the thread.
     */
    nextNumber: integer("next_number").notNull().default(1),
    nextMilestoneNumber: integer("next_milestone_number").notNull().default(1),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    nameIdx: uniqueIndex("git_repositories_name_idx").on(t.namespaceId, t.nameLower),
    // A namespace's page: newest push first.
    namespacePushedIdx: index("git_repositories_namespace_pushed_idx").on(
      t.namespaceId,
      t.pushedAt,
    ),
    // Explore: public repositories by stars, and by recent activity.
    visibilityStarsIdx: index("git_repositories_visibility_stars_idx").on(
      t.visibility,
      t.starsCount,
    ),
    visibilityPushedIdx: index("git_repositories_visibility_pushed_idx").on(
      t.visibility,
      t.pushedAt,
    ),
    forkOfIdx: index("git_repositories_fork_of_idx").on(t.forkOfId),
  }),
);

/**
 * An organisation's storage on the forge in one hour: the outbox its storage
 * is metered from (`git/billing.ts`, the pattern of `ci_storage_samples`).
 * `private_bytes` is what the plan counts; `bytes` is every repository's.
 * A person's own namespace is never sampled: it has a fixed allowance and
 * nobody to bill.
 */
export const gitStorageSamples = pgTable(
  "git_storage_samples",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    hour: timestamp("hour").notNull(),
    bytes: bigint("bytes", { mode: "number" }).notNull(),
    privateBytes: bigint("private_bytes", { mode: "number" }).notNull(),
    /** The part of `private_bytes` above the plan's included storage at that hour: what is sent. */
    billableBytes: bigint("billable_bytes", { mode: "number" }).notNull(),
    reportedAt: timestamp("reported_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    orgHourIdx: uniqueIndex("git_storage_samples_org_hour_idx").on(t.organizationId, t.hour),
    // The reporter's read: what has not been sent, oldest first.
    reportedIdx: index("git_storage_samples_reported_idx").on(t.reportedAt, t.hour),
  }),
);

/** A person given access to one repository, beyond what its namespace gives them. */
export const gitCollaborators = pgTable(
  "git_collaborators",
  {
    id: text("id").primaryKey(),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => gitRepositories.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").$type<GitRepoRole>().notNull(),
    addedByUserId: text("added_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    repoUserIdx: uniqueIndex("git_collaborators_repo_user_idx").on(t.repositoryId, t.userId),
    // "Repositories I collaborate on".
    userIdx: index("git_collaborators_user_idx").on(t.userId),
  }),
);

/**
 * A person's SSH keys for Git. Separate from `ssh_keys`, the organisation's
 * keys for its servers: these only ever authenticate their owner to the forge.
 */
export const gitUserKeys = pgTable(
  "git_user_keys",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    /** `ssh-ed25519`, `ecdsa-sha2-nistp256`, `ssh-rsa`, ... */
    algorithm: text("algorithm").notNull(),
    /** The key blob as sent on the wire, base64 (the middle field of a `.pub` line). */
    publicKey: text("public_key").notNull(),
    /**
     * `SHA256:...` of the blob. Unique here, and the code that adds a key
     * checks `git_deploy_keys` too: a key names exactly one principal.
     */
    fingerprint: text("fingerprint").notNull(),
    lastUsedAt: timestamp("last_used_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    fingerprintIdx: uniqueIndex("git_user_keys_fingerprint_idx").on(t.fingerprint),
    userIdx: index("git_user_keys_user_idx").on(t.userId),
  }),
);

/** An SSH key that reaches one repository, with no person behind it. */
export const gitDeployKeys = pgTable(
  "git_deploy_keys",
  {
    id: text("id").primaryKey(),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => gitRepositories.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    algorithm: text("algorithm").notNull(),
    publicKey: text("public_key").notNull(),
    /** Unique across repositories: SSH authenticates the key before it names a repository. */
    fingerprint: text("fingerprint").notNull(),
    readOnly: boolean("read_only").notNull().default(true),
    addedByUserId: text("added_by_user_id").references(() => users.id, { onDelete: "set null" }),
    lastUsedAt: timestamp("last_used_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    fingerprintIdx: uniqueIndex("git_deploy_keys_fingerprint_idx").on(t.fingerprint),
    repoIdx: index("git_deploy_keys_repo_idx").on(t.repositoryId),
  }),
);

/**
 * Personal access tokens (`iwg_...`), for Git over HTTPS and the API. Only
 * the SHA-256 of the token is stored: the token is 32 random bytes, so a
 * plain digest is not guessable and needs no key.
 */
export const gitAccessTokens = pgTable(
  "git_access_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** The first characters (`iwg_a1b2c3d4`), to tell tokens apart in the list. */
    prefix: text("prefix").notNull(),
    /** Lowercase hex SHA-256 of the whole token. */
    hashedToken: text("hashed_token").notNull(),
    scopes: jsonb("scopes").$type<GitTokenScope[]>().notNull().default([]),
    expiresAt: timestamp("expires_at"),
    lastUsedAt: timestamp("last_used_at"),
    revokedAt: timestamp("revoked_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    hashIdx: uniqueIndex("git_access_tokens_hash_idx").on(t.hashedToken),
    userIdx: index("git_access_tokens_user_idx").on(t.userId),
  }),
);

export const gitLabels = pgTable(
  "git_labels",
  {
    id: text("id").primaryKey(),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => gitRepositories.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    nameLower: text("name_lower").notNull(),
    /** Six hex digits, no `#`. */
    color: text("color").notNull(),
    description: text("description"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    nameIdx: uniqueIndex("git_labels_repo_name_idx").on(t.repositoryId, t.nameLower),
  }),
);

export const gitMilestones = pgTable(
  "git_milestones",
  {
    id: text("id").primaryKey(),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => gitRepositories.id, { onDelete: "cascade" }),
    /** Per repository, from `git_repositories.next_milestone_number`. */
    number: integer("number").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    state: text("state").$type<GitMilestoneState>().notNull().default("open"),
    dueOn: date("due_on"),
    openCount: integer("open_count").notNull().default(0),
    closedCount: integer("closed_count").notNull().default(0),
    closedAt: timestamp("closed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    numberIdx: uniqueIndex("git_milestones_repo_number_idx").on(t.repositoryId, t.number),
    stateIdx: index("git_milestones_repo_state_idx").on(t.repositoryId, t.state, t.dueOn),
  }),
);

/**
 * An issue, or the conversation half of a pull request.
 *
 * Issues and pull requests share a number sequence and everything a thread
 * has (title, body, state, author, labels, assignees, milestone, comments,
 * timeline, lock), so both are a row here and a pull request adds a
 * `git_pull_requests` row keyed by this one's id. Comments, timeline events,
 * labels and assignees then reference one table, and `#12` resolves with one
 * lookup whichever it is.
 */
export const gitIssues = pgTable(
  "git_issues",
  {
    id: text("id").primaryKey(),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => gitRepositories.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    /** True when a `git_pull_requests` row hangs off this one. Set at insert, never changed. */
    isPullRequest: boolean("is_pull_request").notNull().default(false),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    bodyEditedAt: timestamp("body_edited_at"),
    /** A merged pull request is `closed` here; `git_pull_requests.merged_at` says it merged. */
    state: text("state").$type<GitIssueState>().notNull().default("open"),
    stateReason: text("state_reason").$type<GitIssueStateReason>(),
    authorUserId: text("author_user_id").references(() => users.id, { onDelete: "set null" }),
    milestoneId: text("milestone_id").references(() => gitMilestones.id, {
      onDelete: "set null",
    }),
    locked: boolean("locked").notNull().default(false),
    lockReason: text("lock_reason"),
    commentsCount: integer("comments_count").notNull().default(0),
    closedByUserId: text("closed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    closedAt: timestamp("closed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    /** Bumped by anything a reader would call activity: an edit, a comment, a label, a push. */
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    numberIdx: uniqueIndex("git_issues_repo_number_idx").on(t.repositoryId, t.number),
    // The list pages: one kind, one state, newest or most recently active first.
    listCreatedIdx: index("git_issues_list_created_idx").on(
      t.repositoryId,
      t.isPullRequest,
      t.state,
      t.createdAt,
    ),
    listUpdatedIdx: index("git_issues_list_updated_idx").on(
      t.repositoryId,
      t.isPullRequest,
      t.state,
      t.updatedAt,
    ),
    authorIdx: index("git_issues_author_idx").on(t.authorUserId, t.createdAt),
    milestoneIdx: index("git_issues_milestone_idx").on(t.milestoneId),
  }),
);

export const gitIssueLabels = pgTable(
  "git_issue_labels",
  {
    issueId: text("issue_id")
      .notNull()
      .references(() => gitIssues.id, { onDelete: "cascade" }),
    labelId: text("label_id")
      .notNull()
      .references(() => gitLabels.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.issueId, t.labelId] }),
    // "Threads with this label".
    labelIdx: index("git_issue_labels_label_idx").on(t.labelId),
  }),
);

export const gitIssueAssignees = pgTable(
  "git_issue_assignees",
  {
    issueId: text("issue_id")
      .notNull()
      .references(() => gitIssues.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.issueId, t.userId] }),
    // "Assigned to me".
    userIdx: index("git_issue_assignees_user_idx").on(t.userId),
  }),
);

/** What only a pull request has. Its thread is the `git_issues` row with the same id. */
export const gitPullRequests = pgTable(
  "git_pull_requests",
  {
    issueId: text("issue_id")
      .primaryKey()
      .references(() => gitIssues.id, { onDelete: "cascade" }),
    /** The base repository: the thread's. Repeated here for the indexes below. */
    repositoryId: text("repository_id")
      .notNull()
      .references(() => gitRepositories.id, { onDelete: "cascade" }),
    /** The branch it merges into, short (`main`). */
    baseRef: text("base_ref").notNull(),
    /** Where the head branch is: the base repository, or a fork. Null once that fork is deleted. */
    headRepositoryId: text("head_repository_id").references(() => gitRepositories.id, {
      onDelete: "set null",
    }),
    headRef: text("head_ref").notNull(),
    /** The head branch's commit, as of the last push the queue consumer synchronised. */
    headOid: text("head_oid").notNull(),
    /** The base branch's commit when last synchronised. */
    baseOid: text("base_oid").notNull(),
    mergeBaseOid: text("merge_base_oid"),
    /** False once the head branch is deleted; `headOid` keeps the last commit to restore it at. */
    headRefExists: boolean("head_ref_exists").notNull().default(true),
    draft: boolean("draft").notNull().default(false),
    /** Whether head merges into base, from a trial merge; `unknown` after either side moves. */
    mergeableState: text("mergeable_state").$type<GitMergeableState>().notNull().default("unknown"),
    /** The `headOid` and `baseOid` the state above was computed for, so a stale answer is recognisable. */
    mergeableHeadOid: text("mergeable_head_oid"),
    mergeableBaseOid: text("mergeable_base_oid"),
    conflictFiles: jsonb("conflict_files").$type<string[]>().notNull().default([]),
    commitsCount: integer("commits_count").notNull().default(0),
    additions: integer("additions").notNull().default(0),
    deletions: integer("deletions").notNull().default(0),
    changedFiles: integer("changed_files").notNull().default(0),
    mergedAt: timestamp("merged_at"),
    mergedByUserId: text("merged_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /** The base branch's head after the merge: the merge commit, the squash, or the last rebased commit. */
    mergeCommitOid: text("merge_commit_oid"),
    mergeMethod: text("merge_method").$type<GitMergeMethod>(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    // After a push: the pull requests whose head is that branch, and those whose base is.
    headIdx: index("git_pull_requests_head_idx").on(t.headRepositoryId, t.headRef),
    baseIdx: index("git_pull_requests_base_idx").on(t.repositoryId, t.baseRef),
    // "Which pull request merged this commit".
    mergeCommitIdx: index("git_pull_requests_merge_commit_idx").on(
      t.repositoryId,
      t.mergeCommitOid,
    ),
  }),
);

/** A comment on an issue or on a pull request's conversation. */
export const gitComments = pgTable(
  "git_comments",
  {
    id: text("id").primaryKey(),
    issueId: text("issue_id")
      .notNull()
      .references(() => gitIssues.id, { onDelete: "cascade" }),
    /** For the "comment belongs to this repository" check without a join. */
    repositoryId: text("repository_id")
      .notNull()
      .references(() => gitRepositories.id, { onDelete: "cascade" }),
    authorUserId: text("author_user_id").references(() => users.id, { onDelete: "set null" }),
    body: text("body").notNull(),
    editedAt: timestamp("edited_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    issueIdx: index("git_comments_issue_idx").on(t.issueId, t.createdAt),
  }),
);

/**
 * A review of a pull request. `pending` until its author submits it; a person
 * has at most one pending review per pull request.
 */
export const gitReviews = pgTable(
  "git_reviews",
  {
    id: text("id").primaryKey(),
    /** The pull request's `git_issues.id`. */
    pullRequestId: text("pull_request_id")
      .notNull()
      .references(() => gitPullRequests.issueId, { onDelete: "cascade" }),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => gitRepositories.id, { onDelete: "cascade" }),
    authorUserId: text("author_user_id").references(() => users.id, { onDelete: "set null" }),
    state: text("state").$type<GitReviewState>().notNull().default("pending"),
    body: text("body").notNull().default(""),
    /** The head it reviewed: an approval counts for this commit. */
    commitOid: text("commit_oid").notNull(),
    submittedAt: timestamp("submitted_at"),
    /** What it was before it was dismissed, for the timeline. */
    dismissedState: text("dismissed_state").$type<GitReviewState>(),
    dismissedByUserId: text("dismissed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    dismissedAt: timestamp("dismissed_at"),
    dismissalReason: text("dismissal_reason"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    pullIdx: index("git_reviews_pull_idx").on(t.pullRequestId, t.submittedAt),
    pendingIdx: uniqueIndex("git_reviews_pending_idx")
      .on(t.pullRequestId, t.authorUserId)
      .where(sql`${t.state} = 'pending'`),
  }),
);

/**
 * A comment on lines of a pull request's diff. A thread is a comment with no
 * `inReplyToId` plus the comments that reply to it; the anchor (path, side,
 * lines) and the resolution live on that first comment, and replies repeat
 * its path so a file's comments are one index scan.
 */
export const gitReviewComments = pgTable(
  "git_review_comments",
  {
    id: text("id").primaryKey(),
    pullRequestId: text("pull_request_id")
      .notNull()
      .references(() => gitPullRequests.issueId, { onDelete: "cascade" }),
    /** Hidden from everyone but its author while that review is `pending`. */
    reviewId: text("review_id")
      .notNull()
      .references(() => gitReviews.id, { onDelete: "cascade" }),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => gitRepositories.id, { onDelete: "cascade" }),
    authorUserId: text("author_user_id").references(() => users.id, { onDelete: "set null" }),
    /** The thread's first comment. Null on that comment itself. */
    inReplyToId: text("in_reply_to_id").references((): AnyPgColumn => gitReviewComments.id, {
      onDelete: "cascade",
    }),
    body: text("body").notNull(),
    path: text("path").notNull(),
    side: text("side").$type<GitDiffSide>().notNull().default("RIGHT"),
    /** The (last) line in the current diff, numbered in its side's file. Null once outdated. */
    line: integer("line"),
    /** The first line of a multi-line comment. */
    startLine: integer("start_line"),
    startSide: text("start_side").$type<GitDiffSide>(),
    /** The head the anchor above is for; moves forward as pushes keep the lines intact. */
    commitOid: text("commit_oid").notNull(),
    /** Where it was written: never changes. */
    originalCommitOid: text("original_commit_oid").notNull(),
    originalLine: integer("original_line").notNull(),
    originalStartLine: integer("original_start_line"),
    /** The lines it was written on, with context, as a unified hunk: shown once outdated. */
    diffHunk: text("diff_hunk"),
    /** The lines it was written on have changed since. */
    outdated: boolean("outdated").notNull().default(false),
    /** The branch version it was written on (`git_branch_versions.number`). Null before versions were recorded. */
    versionNumber: integer("version_number"),
    /** The version whose push changed the lines it is on: what answered it. Set with `outdated`. */
    answeredInVersion: integer("answered_in_version"),
    resolvedAt: timestamp("resolved_at"),
    resolvedByUserId: text("resolved_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    editedAt: timestamp("edited_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    pullPathIdx: index("git_review_comments_pull_path_idx").on(t.pullRequestId, t.path),
    reviewIdx: index("git_review_comments_review_idx").on(t.reviewId),
    replyIdx: index("git_review_comments_reply_idx").on(t.inReplyToId),
  }),
);

export const gitStars = pgTable(
  "git_stars",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => gitRepositories.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.repositoryId] }),
    // A person's stars, and a repository's stargazers, newest first.
    userIdx: index("git_stars_user_idx").on(t.userId, t.createdAt),
    repoIdx: index("git_stars_repo_idx").on(t.repositoryId, t.createdAt),
  }),
);

/**
 * A rule for the branches a pattern matches (`main`, `release/*`). Checked by
 * the push hook and by merge; when several match a branch, the strictest of
 * each setting applies.
 */
export const gitProtectedBranches = pgTable(
  "git_protected_branches",
  {
    id: text("id").primaryKey(),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => gitRepositories.id, { onDelete: "cascade" }),
    /** A branch name or glob: `*` within a path segment, `**` across them. */
    pattern: text("pattern").notNull(),
    /** Direct pushes are refused: changes arrive by pull request. */
    requirePullRequest: boolean("require_pull_request").notNull().default(false),
    requiredApprovals: integer("required_approvals").notNull().default(0),
    dismissStaleApprovals: boolean("dismiss_stale_approvals").notNull().default(false),
    requiredStatusContexts: jsonb("required_status_contexts")
      .$type<string[]>()
      .notNull()
      .default([]),
    allowForcePush: boolean("allow_force_push").notNull().default(false),
    allowDeletion: boolean("allow_deletion").notNull().default(false),
    /** Only `pusherUserIds` (and administrators, unless `enforceAdmins`) may push or merge. */
    restrictPushers: boolean("restrict_pushers").notNull().default(false),
    pusherUserIds: jsonb("pusher_user_ids").$type<string[]>().notNull().default([]),
    /** The rule binds administrators too. */
    enforceAdmins: boolean("enforce_admins").notNull().default(false),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    patternIdx: uniqueIndex("git_protected_branches_repo_pattern_idx").on(
      t.repositoryId,
      t.pattern,
    ),
  }),
);

/**
 * What something reported about a commit. One row per context per commit:
 * reporting again replaces it (the latest wins), so the row is upserted on
 * the unique index and `updatedAt` says when it last changed.
 */
export const gitCommitStatuses = pgTable(
  "git_commit_statuses",
  {
    id: text("id").primaryKey(),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => gitRepositories.id, { onDelete: "cascade" }),
    /** A full commit id. */
    sha: text("sha").notNull(),
    /** What reported it (`Infrawrench CI / test`). */
    context: text("context").notNull(),
    state: text("state").$type<GitStatusState>().notNull(),
    description: text("description"),
    targetUrl: text("target_url"),
    /** Who reported it, for a person's token. Null for a CI job token. */
    creatorUserId: text("creator_user_id").references(() => users.id, { onDelete: "set null" }),
    /** The `ci_runs.id` behind it, when CI reported it. Not a foreign key: runs are pruned on their own schedule. */
    ciRunId: text("ci_run_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    contextIdx: uniqueIndex("git_commit_statuses_context_idx").on(t.repositoryId, t.sha, t.context),
  }),
);

export type GitTimelineEventType =
  | "labeled"
  | "unlabeled"
  | "assigned"
  | "unassigned"
  | "milestoned"
  | "demilestoned"
  | "renamed"
  | "closed"
  | "reopened"
  | "locked"
  | "unlocked"
  /** A commit's message mentions the thread. */
  | "referenced"
  /** Another thread mentions this one. */
  | "cross_referenced"
  | "merged"
  /** Commits pushed to a pull request's head. */
  | "committed"
  | "head_force_pushed"
  | "head_branch_deleted"
  | "head_branch_restored"
  | "base_changed"
  | "ready_for_review"
  | "converted_to_draft"
  | "review_dismissed"
  /** A Terraform workspace's plan or apply for the pull request reported its result. */
  | "terraform_run";

/**
 * What each event type carries. Ids, never copies of what they name (a
 * label's colour, a person's name), except where the thing can be deleted
 * and the timeline should still read (`labelName`, `milestoneTitle`).
 */
export interface GitTimelineEventPayload {
  labelId?: string;
  labelName?: string;
  labelColor?: string;
  assigneeUserId?: string;
  milestoneTitle?: string;
  /** `renamed`, `base_changed`. */
  from?: string;
  to?: string;
  stateReason?: GitIssueStateReason | null;
  lockReason?: string | null;
  /** `referenced`, `closed` by a commit, `merged`. */
  commitOid?: string;
  /** `committed`: the pushed commits, oldest first, capped. */
  commitOids?: string[];
  mergeMethod?: GitMergeMethod;
  /** `merged`, `head_branch_deleted`, `head_branch_restored`. */
  ref?: string;
  /** `head_force_pushed`. */
  beforeOid?: string;
  afterOid?: string;
  /** `cross_referenced`: the `git_issues.id` that mentions this one. */
  sourceIssueId?: string;
  /** `review_dismissed`. */
  reviewId?: string;
  reason?: string | null;
  /** `terraform_run`: the `git_terraform_runs.id`, and what it found, as it was then. */
  terraformRunId?: string;
  terraformWorkspace?: string;
  terraformKind?: "plan" | "apply";
  terraformOutcome?: "planned" | "no_changes" | "applied" | "failed" | "skipped";
  terraformAdd?: number;
  terraformChange?: number;
  terraformDestroy?: number;
}

/** Something that happened to a thread other than a comment or a review. */
export const gitTimelineEvents = pgTable(
  "git_timeline_events",
  {
    id: text("id").primaryKey(),
    issueId: text("issue_id")
      .notNull()
      .references(() => gitIssues.id, { onDelete: "cascade" }),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => gitRepositories.id, { onDelete: "cascade" }),
    /** Null when a push or the system did it, and once the account is gone. */
    actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    type: text("type").$type<GitTimelineEventType>().notNull(),
    payload: jsonb("payload").$type<GitTimelineEventPayload>().notNull().default({}),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    issueIdx: index("git_timeline_events_issue_idx").on(t.issueId, t.createdAt),
  }),
);
