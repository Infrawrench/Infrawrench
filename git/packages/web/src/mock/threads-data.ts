/**
 * The mock's issues and pull requests: one number sequence per repository,
 * each thread with its comments and events, and for a pull request its
 * reviews and review threads. Pull requests point at real branches of the
 * fixture histories, so their diffs, commits and mergeability are computed.
 */
import type {
  DiffHunk,
  Issue,
  IssueSummary,
  Label,
  Mergeability,
  MergeMethod,
  Milestone,
  PullRequest,
  PullRequestSummary,
  Review,
  ReviewComment,
  ReviewThread,
  ThreadComment,
  TimelineItem,
  UserRef,
} from "@infrawrench/git-contract";
import type { ReviewDecision } from "@infrawrench/git-contract";
import { notFound, type Mutable } from "./define";
import { accessTo, currentUser, gitOf, type RepositoryRecord } from "./db";
import { aheadBehind, ancestors, diffCommits, mergeBase, statsOf, type GitFixture } from "./git";
import { combine, statusesFor } from "./ci-data";
import { mergeCommits } from "./git-write";
import { hoursAgo, newId, person, ruleFor } from "./settings-data";

export type StoredItem = Mutable<Exclude<TimelineItem, { type: "review" }>>;
export type StoredReview = Mutable<Review>;
export type StoredReviewThread = Mutable<Omit<ReviewThread, "comments">> & {
  comments: Array<Mutable<ReviewComment>>;
};

export interface PullRecord {
  draft: boolean;
  baseRef: string;
  headRef: string;
  /** The head commit once the branch is gone or the pull request merged. */
  frozenHeadOid: string | null;
  frozenBaseOid: string | null;
  merged: { at: string; by: UserRef; commitOid: string; method: MergeMethod } | null;
  reviews: StoredReview[];
  threads: StoredReviewThread[];
}

export interface ThreadRecord {
  id: string;
  number: number;
  title: string;
  body: string;
  bodyEditedAt: string | null;
  author: UserRef | null;
  labelIds: string[];
  assignees: UserRef[];
  milestone: number | null;
  state: "open" | "closed";
  stateReason: "completed" | "not_planned" | null;
  locked: boolean;
  lockReason: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  closedBy: UserRef | null;
  items: StoredItem[];
  pull: PullRecord | null;
}

export type MilestoneRecord = Mutable<Omit<Milestone, "openCount" | "closedCount">>;

export interface RepoThreads {
  labels: Array<Mutable<Label>>;
  milestones: MilestoneRecord[];
  threads: ThreadRecord[];
  nextNumber: number;
  nextMilestone: number;
}

const DEFAULT_LABELS: Array<[string, string, string | null]> = [
  ["bug", "b3261e", "Something is not working"],
  ["enhancement", "1d6fa5", null],
  ["documentation", "5b5f97", null],
  ["cost", "8a6100", "Changes what we pay"],
  ["security", "8f1a9b", null],
  ["question", "0a6b5c", null],
  ["good first issue", "3a7d1e", null],
];

// ---------------------------------------------------------------------------
// Builders for the fixtures
// ---------------------------------------------------------------------------

const comment = (by: string, hours: number, body: string, edited = false): StoredItem => {
  const id = newId("c");
  const at = hoursAgo(hours);
  return {
    type: "comment",
    id,
    comment: {
      id,
      author: person(by),
      body,
      createdAt: at,
      updatedAt: edited ? hoursAgo(hours - 1) : at,
      edited,
      authorAccess: null,
      viewerCanEdit: false,
      viewerCanDelete: false,
    },
  };
};

type EventItem = Exclude<StoredItem, { type: "comment" | "commits" }>;
type EventFields<T extends EventItem["type"]> = Omit<
  Extract<EventItem, { type: T }>,
  "type" | "id" | "actor" | "createdAt"
>;

export function event<T extends EventItem["type"]>(
  type: T,
  actor: UserRef | null,
  at: string,
  fields: EventFields<T>,
): StoredItem {
  return { type, id: newId("ev"), actor, createdAt: at, ...fields } as unknown as StoredItem;
}

const ev = <T extends EventItem["type"]>(
  type: T,
  by: string,
  hours: number,
  fields: EventFields<T>,
): StoredItem => event(type, person(by), hoursAgo(hours), fields);

interface ThreadSeed {
  number: number;
  title: string;
  by: string;
  hours: number;
  body: string;
  labels?: string[];
  assignees?: string[];
  milestone?: number;
  closed?: { by: string; hours: number; reason?: "completed" | "not_planned" };
  locked?: string;
  items?: StoredItem[];
  pull?: Omit<PullRecord, "reviews" | "threads"> & {
    reviews?: StoredReview[];
    threads?: StoredReviewThread[];
  };
}

function build(store: RepoThreads, seed: ThreadSeed): ThreadRecord {
  const items = [...(seed.items ?? [])];
  const labelIds = (seed.labels ?? []).map(
    (name) => store.labels.find((label) => label.name === name)!.id,
  );
  const timeOf = (item: StoredItem): string =>
    item.type === "comment" ? item.comment.createdAt : item.createdAt;
  items.sort((a, b) => timeOf(a).localeCompare(timeOf(b)));
  const last = items[items.length - 1];
  return {
    id: `thread_${seed.number}_${newId("t")}`,
    number: seed.number,
    title: seed.title,
    body: seed.body,
    bodyEditedAt: null,
    author: person(seed.by),
    labelIds,
    assignees: (seed.assignees ?? []).map(person),
    milestone: seed.milestone ?? null,
    state: seed.closed ? "closed" : "open",
    stateReason: seed.closed ? (seed.closed.reason ?? "completed") : null,
    locked: seed.locked !== undefined,
    lockReason: seed.locked ?? null,
    createdAt: hoursAgo(seed.hours),
    updatedAt: last ? timeOf(last) : hoursAgo(seed.hours),
    closedAt: seed.closed ? hoursAgo(seed.closed.hours) : null,
    closedBy: seed.closed ? person(seed.closed.by) : null,
    items,
    pull: seed.pull ? { reviews: [], threads: [], ...seed.pull } : null,
  };
}

const review = (
  by: string,
  hours: number,
  state: Review["state"],
  body: string,
  commitOid: string,
): StoredReview => ({
  id: newId("rev"),
  author: person(by),
  state,
  body,
  commitOid,
  stale: false,
  commentCount: 0,
  createdAt: hoursAgo(hours),
  submittedAt: state === "pending" ? null : hoursAgo(hours),
  dismissedBy: null,
  dismissalReason: null,
  viewerCanDismiss: false,
  viewerCanEdit: false,
});

const reviewComment = (
  reviewId: string,
  threadId: string | null,
  by: string,
  hours: number,
  body: string,
  pending = false,
): Mutable<ReviewComment> => {
  const id = newId("rc");
  return {
    id,
    reviewId,
    threadId: threadId ?? id,
    inReplyToId: threadId,
    author: person(by),
    body,
    pending,
    createdAt: hoursAgo(hours),
    updatedAt: hoursAgo(hours),
    edited: false,
    viewerCanEdit: false,
    viewerCanDelete: false,
  };
};

/** The lines a thread was written on with a few before them, from the diff of `headOid`. */
export function hunkAround(
  fx: GitFixture,
  baseOid: string | null,
  headOid: string,
  path: string,
  side: "LEFT" | "RIGHT",
  line: number,
  startLine: number | null,
): DiffHunk | null {
  const file = diffCommits(fx, baseOid, headOid, { path })[0];
  if (!file) return null;
  for (const hunk of file.hunks) {
    const index = hunk.lines.findIndex((row) =>
      side === "LEFT" ? row.type === "delete" && row.oldLine === line : row.newLine === line,
    );
    if (index < 0) continue;
    const first = startLine ?? line;
    let from = hunk.lines.findIndex((row) =>
      side === "LEFT" ? row.oldLine === first : row.newLine === first,
    );
    if (from < 0) from = index;
    const lines = hunk.lines.slice(Math.max(0, Math.min(from, index - 3)), index + 1);
    const firstRow = lines[0]!;
    return {
      oldStart: firstRow.oldLine ?? hunk.oldStart,
      newStart: firstRow.newLine ?? hunk.newStart,
      oldLines: lines.filter((row) => row.type !== "add").length,
      newLines: lines.filter((row) => row.type !== "delete").length,
      section: hunk.section,
      lines,
    };
  }
  return null;
}

function reviewThread(
  fx: GitFixture,
  baseOid: string | null,
  headOid: string,
  anchor: { path: string; line: number; startLine?: number; outdatedAt?: string },
  comments: Array<Mutable<ReviewComment>>,
  resolvedBy: string | null = null,
): StoredReviewThread {
  const first = comments[0]!;
  for (const reply of comments.slice(1)) {
    reply.threadId = first.id;
    reply.inReplyToId = first.id;
  }
  const writtenAt = anchor.outdatedAt ?? headOid;
  return {
    id: first.id,
    path: anchor.path,
    side: "RIGHT",
    line: anchor.outdatedAt === undefined ? anchor.line : null,
    startLine: anchor.outdatedAt === undefined ? (anchor.startLine ?? null) : null,
    startSide: anchor.startLine === undefined ? null : "RIGHT",
    commitOid: headOid,
    originalCommitOid: writtenAt,
    originalLine: anchor.line,
    originalStartLine: anchor.startLine ?? null,
    outdated: anchor.outdatedAt !== undefined,
    hunk: hunkAround(
      fx,
      baseOid,
      writtenAt,
      anchor.path,
      "RIGHT",
      anchor.line,
      anchor.startLine ?? null,
    ),
    resolved: resolvedBy !== null,
    resolvedBy: resolvedBy === null ? null : person(resolvedBy),
    comments,
    viewerCanResolve: false,
    viewerCanReply: false,
  };
}

// ---------------------------------------------------------------------------
// acme/infra
// ---------------------------------------------------------------------------

function seedInfra(repo: RepositoryRecord, store: RepoThreads): void {
  const fx = gitOf(repo);
  const oidOf = (prefix: string): string => fx.order.find((oid) => oid.startsWith(prefix)) ?? "";
  const summaryOf = (prefix: string) => {
    const commit = fx.commits[oidOf(prefix)]!;
    return {
      oid: commit.oid,
      summary: commit.message.split("\n")[0]!,
      hasBody: false,
      author: commit.author,
      committer: commit.committer,
      authorUser: null,
      parents: commit.parents,
      status: null,
    };
  };
  store.milestones.push(
    {
      id: "ms_1",
      number: 1,
      title: "Cost review Q4",
      description: "Everything the October cost review asked for.",
      state: "open",
      dueOn: new Date(Date.now() + 23 * 86_400_000).toISOString().slice(0, 10),
      createdAt: hoursAgo(24 * 40),
      closedAt: null,
    },
    {
      id: "ms_2",
      number: 2,
      title: "State in the built-in backend",
      description: null,
      state: "open",
      dueOn: null,
      createdAt: hoursAgo(24 * 18),
      closedAt: null,
    },
    {
      id: "ms_3",
      number: 3,
      title: "Staging parity",
      description: "Staging runs everything production does, smaller.",
      state: "closed",
      dueOn: new Date(Date.now() - 12 * 86_400_000).toISOString().slice(0, 10),
      createdAt: hoursAgo(24 * 50),
      closedAt: hoursAgo(24 * 11),
    },
  );

  const peering = fx.branches["feature/vpc-peering"]!;
  const peeringEarlier = fx.commits[peering]!.parents[0]!;
  const backups = fx.branches["fix/database-backups"]!;
  const forkPoint = oidOf("5663027");

  const changes = review(
    "priya",
    44,
    "changes_requested",
    "The routes look right. Two things before this goes in.",
    peeringEarlier,
  );
  const approval = review("priya", 27, "approved", "Thanks, the docs help.", peering);
  const pending = review("mara", 2, "pending", "", peering);
  const flowApproval = review("mara", 24 * 43 + 3, "approved", "", oidOf("23b5b1e"));

  const threads12 = [
    reviewThread(
      fx,
      forkPoint,
      peering,
      { path: "modules/network/main.tf", line: 123, startLine: 121 },
      [
        reviewComment(
          changes.id,
          null,
          "priya",
          44,
          "This makes one route per zone per peer, which is what we want, but the key changes if `zone_count` does. Worth a note that changing it replaces every route.",
        ),
        reviewComment(
          newId("rev"),
          "x",
          "jonas",
          40,
          "Good point. Added to `docs/peering.md`; the replace is a few seconds per route.",
        ),
      ],
      "jonas",
    ),
    reviewThread(fx, forkPoint, peering, { path: "environments/staging/main.tf", line: 31 }, [
      reviewComment(
        changes.id,
        null,
        "priya",
        44,
        'Could this come from a data source instead of a literal id? The shared services account recreates its VPC about once a year.\n\n```hcl\ndata "aws_vpc" "shared" {\n  provider = aws.shared\n  tags     = { Name = "shared-services" }\n}\n```',
      ),
      reviewComment(
        newId("rev"),
        "x",
        "jonas",
        39,
        "It needs a second provider alias in every root. I would rather do that in a follow-up.",
      ),
    ]),
    reviewThread(
      fx,
      forkPoint,
      peering,
      { path: "modules/network/variables.tf", line: 36, outdatedAt: peeringEarlier },
      [reviewComment(changes.id, null, "priya", 44, "Say what the key is used for.")],
      "priya",
    ),
    reviewThread(fx, forkPoint, peering, { path: "docs/peering.md", line: 3 }, [
      reviewComment(
        pending.id,
        null,
        "mara",
        2,
        "Mention that the peer has to accept the connection in its own account.",
        true,
      ),
    ]),
  ];
  changes.commentCount = 3;
  pending.commentCount = 1;

  const seeds: ThreadSeed[] = [
    {
      number: 1,
      title: "Pin the AWS provider in every module",
      by: "jonas",
      hours: 24 * 46,
      body: "`modules/cluster` and `modules/database` take whatever provider the root resolves. A minor release changed `aws_eks_node_group` defaults last month and staging planned a replace.\n\n- [x] `modules/network`\n- [x] `modules/cluster`\n- [x] `modules/database`\n- [x] a lint that fails when a module has no `versions.tf`",
      labels: ["enhancement"],
      assignees: ["jonas"],
      milestone: 3,
      closed: { by: "jonas", hours: 24 * 44 },
      items: [
        ev("labeled", "jonas", 24 * 46, { label: store.labels[1]! }),
        ev("assigned", "jonas", 24 * 46, { assignee: person("jonas") }),
        ev("milestoned", "mara", 24 * 45.5, { milestoneTitle: "Staging parity" }),
        ev("referenced", "jonas", 24 * 44.1, { commit: summaryOf("bafe0e2") }),
        ev("closed", "jonas", 24 * 44, { stateReason: "completed", commitOid: oidOf("bafe0e2") }),
      ],
    },
    {
      number: 2,
      title: "A NAT gateway per zone doubles the staging network bill",
      by: "mara",
      hours: 24 * 38,
      body: "Staging runs three NAT gateways for a cluster of two nodes. From the October cost report:\n\n| Item | Monthly |\n| --- | ---: |\n| NAT gateway hours (3) | $98.55 |\n| NAT data processing | $41.20 |\n| Everything else in the VPC | $62.10 |\n\nOne gateway would do for staging. Production keeps one per zone.",
      labels: ["cost"],
      assignees: ["jonas"],
      milestone: 1,
      items: [
        ev("labeled", "mara", 24 * 38, { label: store.labels[3]! }),
        ev("milestoned", "mara", 24 * 38, { milestoneTitle: "Cost review Q4" }),
        comment(
          "jonas",
          24 * 37,
          '`modules/network` has no switch for it. I can add `single_nat_gateway` and set it in the staging root:\n\n```hcl\nmodule "network" {\n  source             = "../../modules/network"\n  single_nat_gateway = true\n}\n```',
        ),
        ev("assigned", "mara", 24 * 36.5, { assignee: person("jonas") }),
        comment(
          "priya",
          24 * 30,
          "A zone outage then takes staging's egress with it. Fine by me, as long as the runbook says so.",
        ),
        comment("mara", 24 * 29, "Agreed. Staging has no availability target.", true),
      ],
    },
    {
      number: 3,
      title: "Document how the peering routes are laid out",
      by: "priya",
      hours: 24 * 9,
      body: "Nobody but Jonas knows which route table gets which route. A page under `docs/` with the layout would do.",
      labels: ["documentation"],
      assignees: ["jonas"],
      closed: { by: "priya", hours: 30, reason: "completed" },
      items: [
        ev("labeled", "priya", 24 * 9, { label: store.labels[2]! }),
        ev("assigned", "priya", 24 * 9, { assignee: person("jonas") }),
        ev("cross_referenced", "jonas", 24 * 3, {
          source: {
            repository: { owner: "acme", name: "infra" },
            number: 12,
            title: "Peer with the shared services VPC",
            isPullRequest: true,
            state: "open",
          },
        }),
        ev("closed", "priya", 30, { stateReason: "completed", commitOid: null }),
      ],
    },
    {
      number: 4,
      title: "Flow logs for the staging VPC",
      by: "priya",
      hours: 24 * 45,
      body: "The audit asks for VPC flow logs in every environment that holds customer data. Staging does since the import job.",
      labels: ["security"],
      milestone: 3,
      closed: { by: "mara", hours: 24 * 43 },
      items: [
        ev("labeled", "priya", 24 * 45, { label: store.labels[4]! }),
        ev("cross_referenced", "jonas", 24 * 43.6, {
          source: {
            repository: { owner: "acme", name: "infra" },
            number: 7,
            title: "network: optional VPC flow logs",
            isPullRequest: true,
            state: "merged",
          },
        }),
        ev("closed", "mara", 24 * 43, { stateReason: "completed", commitOid: oidOf("2832462") }),
      ],
    },
    {
      number: 5,
      title: "Scheduler logs are dropped after a day",
      by: "mara",
      hours: 24 * 44,
      body: "The control plane only keeps `api` and `audit` logs. Last week's pending pods could not be explained after the fact.",
      labels: ["bug"],
      assignees: ["priya"],
      closed: { by: "priya", hours: 24 * 43.2 },
      items: [
        ev("labeled", "mara", 24 * 44, { label: store.labels[0]! }),
        ev("assigned", "mara", 24 * 44, { assignee: person("priya") }),
        ev("referenced", "priya", 24 * 43.2, { commit: summaryOf("4290367") }),
        ev("closed", "priya", 24 * 43.2, { stateReason: "completed", commitOid: oidOf("4290367") }),
      ],
    },
    {
      number: 6,
      title: "Database backups are kept for one day",
      by: "mara",
      hours: 24 * 4,
      body: "`backup_retention_days` defaults to 1 in `modules/database`. Staging lost a day of test data to a bad migration and there was nothing older to restore.\n\nProduction sets 35 itself; the default should not be the minimum.",
      labels: ["bug"],
      assignees: ["priya"],
      items: [
        ev("labeled", "mara", 24 * 4, { label: store.labels[0]! }),
        ev("assigned", "mara", 24 * 4, { assignee: person("priya") }),
        comment(
          "priya",
          24 * 3.5,
          "Two weeks as the default, with a validation for Aurora's 1 to 35.",
        ),
        ev("cross_referenced", "priya", 24 * 2.2, {
          source: {
            repository: { owner: "acme", name: "infra" },
            number: 14,
            title: "Keep two weeks of database backups by default",
            isPullRequest: true,
            state: "open",
          },
        }),
      ],
    },
    {
      number: 8,
      title: "Move state to the built-in backend",
      by: "jonas",
      hours: 24 * 17,
      body: 'Both roots already declare `backend "http" {}`. What is left:\n\n1. `terraform state push` the S3 copy for production\n2. delete the bucket and the lock table once a week has passed\n3. drop the `AWS_PROFILE` step from the runbook',
      labels: ["enhancement"],
      assignees: ["jonas", "mara"],
      milestone: 2,
      items: [
        ev("labeled", "jonas", 24 * 17, { label: store.labels[1]! }),
        ev("milestoned", "jonas", 24 * 17, { milestoneTitle: "State in the built-in backend" }),
        ev("assigned", "jonas", 24 * 17, { assignee: person("jonas") }),
        ev("assigned", "jonas", 24 * 17, { assignee: person("mara") }),
        ev("renamed", "mara", 24 * 16, {
          from: "Move state out of S3",
          to: "Move state to the built-in backend",
        }),
        comment("mara", 24 * 12, "Staging moved yesterday, serial 41 onwards is here."),
      ],
    },
    {
      number: 9,
      title: "terraform fmt fails on 1.10",
      by: "jonas",
      hours: 24 * 37.5,
      body: "1.10 aligns `=` in nested blocks differently. CI still runs `fmt` with 1.9.",
      labels: ["bug"],
      closed: { by: "jonas", hours: 24 * 37 },
      items: [
        ev("labeled", "jonas", 24 * 37.5, { label: store.labels[0]! }),
        ev("referenced", "jonas", 24 * 37, { commit: summaryOf("c79b2b0") }),
        ev("closed", "jonas", 24 * 37, { stateReason: "completed", commitOid: oidOf("c79b2b0") }),
      ],
    },
    {
      number: 10,
      title: "A budget alarm per environment",
      by: "mara",
      hours: 24 * 39,
      body: "One budget per environment, alerting at 80% and 100% of the forecast.",
      labels: ["cost", "enhancement"],
      assignees: ["mara"],
      milestone: 1,
      closed: { by: "mara", hours: 24 * 36 },
      items: [
        ev("labeled", "mara", 24 * 39, { label: store.labels[3]! }),
        ev("labeled", "mara", 24 * 39, { label: store.labels[1]! }),
        ev("milestoned", "mara", 24 * 39, { milestoneTitle: "Cost review Q4" }),
        ev("referenced", "mara", 24 * 36, { commit: summaryOf("22794c7") }),
        ev("closed", "mara", 24 * 36, { stateReason: "completed", commitOid: oidOf("22794c7") }),
      ],
    },
    {
      number: 11,
      title: "Edge zone weights are not validated",
      by: "priya",
      hours: 24 * 6,
      body: "`zones.tf` takes any map. Weights that do not sum to 100 apply cleanly and send the remainder nowhere.",
      labels: ["bug", "good first issue"],
      items: [
        ev("labeled", "priya", 24 * 6, { label: store.labels[0]! }),
        ev("labeled", "mara", 24 * 5, { label: store.labels[6]! }),
      ],
    },
    {
      number: 13,
      title: "The plan summary script crashes on an empty plan",
      by: "priya",
      hours: 31,
      body: '```\n$ terraform show -json plan.out | scripts/plan/summarise.py\nTraceback (most recent call last):\n  File "scripts/plan/summarise.py", line 22, in <module>\n    for change in plan["resource_changes"]:\nKeyError: \'resource_changes\'\n```\n\nA plan with no changes has no `resource_changes` key at all.',
      labels: ["bug"],
      assignees: ["jonas"],
      items: [
        ev("labeled", "priya", 31, { label: store.labels[0]! }),
        ev("assigned", "priya", 31, { assignee: person("mara") }),
        comment("mara", 29, '`plan.get("resource_changes", [])` and a line that says so. On it.'),
        comment(
          "jonas",
          26,
          "The CI job hides this because it only runs the script when the plan has changes.",
        ),
        ev("unassigned", "mara", 5, { assignee: person("mara") }),
        ev("assigned", "mara", 5, { assignee: person("jonas") }),
      ],
    },
    {
      number: 15,
      title: "Rotate the database master password",
      by: "jonas",
      hours: 20,
      body: "It has not changed since the cluster was created. The module manages the secret, so this is a `terraform apply -replace` on the secret version and a restart of the two services that cache it.",
      labels: ["security"],
      locked: "resolved",
      items: [
        ev("labeled", "jonas", 20, { label: store.labels[4]! }),
        comment("priya", 18, "Wednesday morning, after the import job."),
        ev("locked", "mara", 17, { reason: "resolved" }),
      ],
    },
    {
      number: 16,
      title: "Default the cluster to m7g.2xlarge",
      by: "priya",
      hours: 24 * 8,
      body: "Batch workers run out of memory on `xlarge` about once a week.",
      labels: ["question"],
      closed: { by: "mara", hours: 24 * 7, reason: "not_planned" },
      items: [
        ev("labeled", "priya", 24 * 8, { label: store.labels[5]! }),
        comment(
          "mara",
          24 * 7,
          "Production already added two nodes for the batch workers. Doubling every node for one job costs more than it saves.",
        ),
        ev("closed", "mara", 24 * 7, { stateReason: "not_planned", commitOid: null }),
      ],
    },
    {
      number: 7,
      title: "network: optional VPC flow logs",
      by: "jonas",
      hours: 24 * 43.7,
      body: "Adds `flow_logs_bucket_arn` to `modules/network` and sets it for staging.\n\nCloses #4.",
      labels: ["security"],
      milestone: 3,
      closed: { by: "mara", hours: 24 * 43 },
      items: [
        ev("labeled", "jonas", 24 * 43.7, { label: store.labels[4]! }),
        {
          type: "commits",
          id: newId("push"),
          createdAt: hoursAgo(24 * 43.7),
          commits: [summaryOf("142a748"), summaryOf("23b5b1e")],
        },
        comment("mara", 24 * 43.1, "Plan is one bucket policy and one flow log. Merging."),
        ev("merged", "mara", 24 * 43, {
          commitOid: oidOf("2832462"),
          method: "merge",
          baseRef: "main",
        }),
      ],
      pull: {
        draft: false,
        baseRef: "main",
        headRef: "feature/flow-logs",
        frozenHeadOid: oidOf("23b5b1e"),
        frozenBaseOid: oidOf("4290367"),
        merged: {
          at: hoursAgo(24 * 43),
          by: person("mara"),
          commitOid: oidOf("2832462"),
          method: "merge",
        },
        reviews: [flowApproval],
      },
    },
    {
      number: 12,
      title: "Peer with the shared services VPC",
      by: "jonas",
      hours: 24 * 3,
      body: "Peers each environment's VPC with shared services, so the cluster reaches the artifact registry and the metrics gateway without going through NAT.\n\n- `modules/network` takes `peer_vpcs` and adds one route per private route table\n- staging sets it; production follows once this has run for a week\n- the diagram and a page about the route layout\n\nCloses #3.",
      labels: ["enhancement"],
      assignees: ["jonas"],
      milestone: 1,
      items: [
        ev("labeled", "jonas", 24 * 3, { label: store.labels[1]! }),
        ev("assigned", "jonas", 24 * 3, { assignee: person("jonas") }),
        {
          type: "commits",
          id: newId("push"),
          createdAt: hoursAgo(24 * 3),
          commits: [summaryOf("cce1b1a"), summaryOf("a825307")],
        },
        ev("milestoned", "mara", 50, { milestoneTitle: "Cost review Q4" }),
        comment(
          "mara",
          46,
          "NAT data processing for staging was $41 last month, most of it image pulls. This should take nearly all of it away.",
        ),
        {
          type: "commits",
          id: newId("push"),
          createdAt: hoursAgo(38),
          commits: [summaryOf("55955b1")],
        },
        comment("jonas", 37.5, "Pushed the docs page. @priya the route key note is in there."),
      ],
      pull: {
        draft: false,
        baseRef: "main",
        headRef: "feature/vpc-peering",
        frozenHeadOid: null,
        frozenBaseOid: null,
        merged: null,
        reviews: [changes, approval, pending],
        threads: threads12,
      },
    },
    {
      number: 14,
      title: "Keep two weeks of database backups by default",
      by: "priya",
      hours: 24 * 2.2,
      body: "`backup_retention_days` defaults to 14 and is validated against what Aurora accepts.\n\nFixes #6.",
      labels: ["bug"],
      assignees: ["priya"],
      items: [
        ev("labeled", "priya", 24 * 2.2, { label: store.labels[0]! }),
        ev("assigned", "priya", 24 * 2.2, { assignee: person("priya") }),
        {
          type: "commits",
          id: newId("push"),
          createdAt: hoursAgo(24 * 2.2),
          commits: [summaryOf("73f6bc3")],
        },
        ev("converted_to_draft", "priya", 24 * 2.1, {}),
        ev("ready_for_review", "priya", 22, {}),
      ],
      pull: {
        draft: false,
        baseRef: "main",
        headRef: "fix/database-backups",
        frozenHeadOid: null,
        frozenBaseOid: null,
        merged: null,
      },
    },
  ];
  void backups;
  for (const seed of seeds) store.threads.push(build(store, seed));
  store.nextNumber = 17;
  store.nextMilestone = 4;
}

// ---------------------------------------------------------------------------
// acme/edge-router and everything else
// ---------------------------------------------------------------------------

function seedEdgeRouter(repo: RepositoryRecord, store: RepoThreads): void {
  const fx = gitOf(repo);
  const head = fx.branches["feature/health-checks"];
  const seeds: ThreadSeed[] = [
    {
      number: 1,
      title: "Routes with the same prefix and weight pick at random",
      by: "jonas",
      hours: 24 * 6,
      body: "Two routes for `/api` with weight 50 each. Which one wins changes between restarts, because the sort is not stable on the key we use.",
      labels: ["bug"],
      closed: { by: "jonas", hours: 24 * 3.5 },
      items: [ev("closed", "jonas", 24 * 3.5, { stateReason: "completed", commitOid: null })],
    },
    {
      number: 2,
      title: "Health checks for upstreams",
      by: "mara",
      hours: 24 * 4,
      body: "An upstream that refuses connections still gets its share of requests. Check each one every few seconds and leave out the ones that fail twice.",
      labels: ["enhancement"],
      assignees: ["mara"],
      items: [ev("assigned", "mara", 24 * 4, { assignee: person("mara") })],
    },
    {
      number: 3,
      title: "Document the route file format",
      by: "priya",
      hours: 24 * 2,
      body: "The README shows one example. A table of every key would save a read of `src/config.ts`.",
      labels: ["documentation", "good first issue"],
    },
    {
      number: 5,
      title: "Hosts are matched case-sensitively",
      by: "priya",
      hours: 9,
      body: "`Example.com` falls through to the default route.",
      labels: ["bug"],
      items: [comment("jonas", 7, "Lowercase both sides when the table is built.")],
    },
  ];
  if (head !== undefined) {
    seeds.push({
      number: 4,
      title: "Skip upstreams that fail their health check",
      by: "mara",
      hours: 24 * 1.2,
      body: "Closes #2.",
      labels: ["enhancement"],
      pull: {
        draft: true,
        baseRef: "main",
        headRef: "feature/health-checks",
        frozenHeadOid: null,
        frozenBaseOid: null,
        merged: null,
      },
    });
  }
  for (const seed of seeds) store.threads.push(build(store, seed));
  store.nextNumber = 6;
}

const GENERIC_TITLES = [
  "Retry the ledger write when the connection drops",
  "Events older than a day are counted twice",
  "Add a dry-run flag to the backfill",
  "Document the event schema",
  "Usage for deleted organisations is still reported",
  "Batch size should come from configuration",
  "The consumer logs every message at info",
  "Metering lags behind by an hour after a deploy",
  "Reject events with a timestamp in the future",
  "Write a runbook for a stuck partition",
  "Expose the lag as a metric",
  "Round amounts once, at the end",
];

function seedGeneric(repo: RepositoryRecord, store: RepoThreads): void {
  const count = repo.openIssueCount;
  for (let index = 0; index < count; index++) {
    store.threads.push(
      build(store, {
        number: index + 1,
        title: GENERIC_TITLES[index % GENERIC_TITLES.length]!,
        by: ["mara", "jonas", "priya"][index % 3]!,
        hours: 24 * (count - index) + 3,
        body: "",
        labels: [["bug"], ["enhancement"], []][index % 3]!,
      }),
    );
  }
  store.nextNumber = count + 1;
}

const stores = new Map<string, RepoThreads>();

export function threadsOf(repo: RepositoryRecord): RepoThreads {
  let store = stores.get(repo.id);
  if (store) return store;
  store = {
    labels: DEFAULT_LABELS.map(([name, color, description], index) => ({
      id: `label_${repo.id}_${index}`,
      name,
      color,
      description,
    })),
    milestones: [],
    threads: [],
    nextNumber: 1,
    nextMilestone: 1,
  };
  stores.set(repo.id, store);
  const key = `${repo.owner.slug}/${repo.name}`;
  if (key === "acme/infra") seedInfra(repo, store);
  else if (key === "acme/edge-router") seedEdgeRouter(repo, store);
  else seedGeneric(repo, store);
  syncCounts(repo);
  return store;
}

/** Keeps the counts the repository header's tabs show in step with the threads. */
export function syncCounts(repo: RepositoryRecord): void {
  const store = stores.get(repo.id);
  if (!store) return;
  const open = store.threads.filter((thread) => thread.state === "open");
  repo.openIssueCount = open.filter((thread) => thread.pull === null).length;
  repo.openPullRequestCount = open.filter((thread) => thread.pull !== null).length;
}

export function findThread(repo: RepositoryRecord, number: number, pull: boolean): ThreadRecord {
  const thread = threadsOf(repo).threads.find((item) => item.number === number);
  if (!thread || (thread.pull !== null) !== pull) {
    throw notFound(pull ? "Pull request not found" : "Issue not found");
  }
  return thread;
}

export function anyThread(repo: RepositoryRecord, number: number): ThreadRecord {
  const thread = threadsOf(repo).threads.find((item) => item.number === number);
  if (!thread) throw notFound("Not found");
  return thread;
}

// ---------------------------------------------------------------------------
// Reading: the contract's shapes for the signed-in person
// ---------------------------------------------------------------------------

const RANK = { none: 0, read: 1, write: 3, admin: 4 } as const;

export function viewerOf(repo: RepositoryRecord) {
  const user = currentUser();
  const access = repo.archived ? Math.min(1, RANK[accessTo(repo)]) : RANK[accessTo(repo)];
  return {
    user,
    signedIn: user !== null,
    canTriage: user !== null && access >= 3,
    canWrite: user !== null && access >= 3,
    isAdmin: user !== null && access >= 4,
    is: (other: UserRef | null): boolean => user !== null && other !== null && other.id === user.id,
  };
}

const milestoneRef = (store: RepoThreads, number: number | null) => {
  const found = store.milestones.find((item) => item.number === number);
  return found ? { id: found.id, number: found.number, title: found.title } : null;
};

const commentCountOf = (thread: ThreadRecord): number =>
  thread.items.filter((item) => item.type === "comment").length;

function threadFields(store: RepoThreads, thread: ThreadRecord) {
  return {
    id: thread.id,
    number: thread.number,
    title: thread.title,
    author: thread.author,
    labels: store.labels
      .filter((label) => thread.labelIds.includes(label.id))
      .sort((a, b) => a.name.localeCompare(b.name)),
    assignees: thread.assignees,
    milestone: milestoneRef(store, thread.milestone),
    commentCount: commentCountOf(thread),
    locked: thread.locked,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    closedAt: thread.closedAt,
  };
}

function threadViewer(repo: RepositoryRecord, thread: ThreadRecord) {
  const viewer = viewerOf(repo);
  const own = viewer.is(thread.author);
  return {
    canEdit: own || viewer.canTriage,
    canTriage: viewer.canTriage,
    canComment: viewer.signedIn && !repo.archived && (!thread.locked || viewer.canTriage),
    canClose: own || viewer.canTriage,
  };
}

export function toIssueSummary(repo: RepositoryRecord, thread: ThreadRecord): IssueSummary {
  return {
    ...threadFields(threadsOf(repo), thread),
    state: thread.state,
    stateReason: thread.stateReason,
  };
}

export function toIssue(repo: RepositoryRecord, thread: ThreadRecord): Issue {
  return {
    ...toIssueSummary(repo, thread),
    body: thread.body,
    bodyEditedAt: thread.bodyEditedAt,
    closedBy: thread.closedBy,
    lockReason: thread.lockReason,
    viewer: threadViewer(repo, thread),
  };
}

export function presentComment(repo: RepositoryRecord, thread: ThreadRecord, value: ThreadComment) {
  const viewer = viewerOf(repo);
  const own = viewer.is(value.author);
  const authorAccess: ThreadComment["authorAccess"] =
    value.author !== null && thread.author !== null && value.author.id === thread.author.id
      ? "author"
      : repo.owner.kind === "org" && value.author !== null
        ? "member"
        : null;
  return {
    ...value,
    authorAccess,
    viewerCanEdit: own || viewer.canWrite,
    viewerCanDelete: own || viewer.canWrite,
  };
}

// --- Pull requests ---------------------------------------------------------

export interface PullRefs {
  fx: GitFixture;
  headOid: string;
  baseOid: string;
  mergeBaseOid: string | null;
  headRefExists: boolean;
}

export function refsOf(repo: RepositoryRecord, pull: PullRecord): PullRefs {
  const fx = gitOf(repo);
  const live = fx.branches[pull.headRef];
  const headOid = pull.frozenHeadOid ?? live ?? "";
  const baseOid = pull.frozenBaseOid ?? fx.branches[pull.baseRef] ?? "";
  return {
    fx,
    headOid,
    baseOid,
    mergeBaseOid: mergeBase(fx, baseOid, headOid),
    headRefExists: live !== undefined,
  };
}

/** The commits a pull request brings, oldest first. */
export function commitsOf(refs: PullRefs): string[] {
  const { fx, headOid, mergeBaseOid } = refs;
  const inBase = mergeBaseOid === null ? new Set<string>() : ancestors(fx, mergeBaseOid);
  const inHead = ancestors(fx, headOid);
  return fx.order.filter((oid) => inHead.has(oid) && !inBase.has(oid)).reverse();
}

function presentReview(repo: RepositoryRecord, pull: PullRecord, item: StoredReview, head: string) {
  const viewer = viewerOf(repo);
  return {
    ...item,
    stale: item.state !== "pending" && item.commitOid !== head,
    commentCount: pull.threads.reduce(
      (sum, thread) => sum + thread.comments.filter((c) => c.reviewId === item.id).length,
      0,
    ),
    viewerCanDismiss:
      viewer.canWrite && (item.state === "approved" || item.state === "changes_requested"),
    viewerCanEdit: viewer.is(item.author),
  };
}

export function reviewsOf(repo: RepositoryRecord, thread: ThreadRecord): Review[] {
  const pull = thread.pull!;
  const viewer = viewerOf(repo);
  const head = refsOf(repo, pull).headOid;
  return pull.reviews
    .filter((item) => item.state !== "pending" || viewer.is(item.author))
    .map((item) => presentReview(repo, pull, item, head))
    .sort((a, b) => (a.submittedAt ?? "9").localeCompare(b.submittedAt ?? "9"));
}

export function presentThread(
  repo: RepositoryRecord,
  thread: ThreadRecord,
  item: StoredReviewThread,
): ReviewThread | null {
  const viewer = viewerOf(repo);
  const comments = item.comments
    .filter((c) => !c.pending || viewer.is(c.author))
    .map((c) => ({
      ...c,
      viewerCanEdit: viewer.is(c.author) || viewer.canWrite,
      viewerCanDelete: viewer.is(c.author) || viewer.canWrite,
    }));
  if (comments.length === 0) return null;
  return {
    ...item,
    comments,
    viewerCanResolve:
      viewer.canWrite || viewer.is(thread.author) || viewer.is(item.comments[0]?.author ?? null),
    viewerCanReply: viewer.signedIn && !repo.archived,
  };
}

export function reviewThreadsOf(repo: RepositoryRecord, thread: ThreadRecord): ReviewThread[] {
  return thread
    .pull!.threads.map((item) => presentThread(repo, thread, item))
    .filter((item): item is ReviewThread => item !== null)
    .sort(
      (a, b) =>
        a.path.localeCompare(b.path) ||
        (a.line ?? a.originalLine) - (b.line ?? b.originalLine) ||
        a.id.localeCompare(b.id),
    );
}

function reviewTally(repo: RepositoryRecord, pull: PullRecord, head: string) {
  const rule = ruleFor(repo, pull.baseRef);
  const newest = new Map<string, StoredReview>();
  for (const item of pull.reviews) {
    if (item.state !== "approved" && item.state !== "changes_requested") continue;
    if (item.author === null) continue;
    const before = newest.get(item.author.id);
    if (!before || (before.submittedAt ?? "") < (item.submittedAt ?? "")) {
      newest.set(item.author.id, item);
    }
  }
  let approvals = 0;
  let changesRequested = 0;
  for (const item of newest.values()) {
    if (item.state === "changes_requested") changesRequested++;
    else if (item.commitOid === head || rule?.dismissStaleApprovals !== true) approvals++;
  }
  const requiredApprovals = rule?.requiredApprovals ?? 0;
  const decision: ReviewDecision | null =
    changesRequested > 0
      ? "changes_requested"
      : approvals > 0 && approvals >= requiredApprovals
        ? "approved"
        : requiredApprovals > 0
          ? "review_required"
          : null;
  return { decision, requiredApprovals, approvals, changesRequested };
}

export function mergeabilityOf(repo: RepositoryRecord, thread: ThreadRecord): Mergeability {
  const pull = thread.pull!;
  const refs = refsOf(repo, pull);
  const viewer = viewerOf(repo);
  const rule = ruleFor(repo, pull.baseRef);
  const open = thread.state === "open";
  const statuses = refs.headOid === "" ? [] : statusesFor(repo, refs.headOid);
  const required = (rule?.requiredStatusContexts ?? []).map((context) => ({
    context,
    state: statuses.find((status) => status.context === context)?.state ?? null,
  }));
  const reviews = reviewTally(repo, pull, refs.headOid);
  const behindBy =
    open && refs.headRefExists ? aheadBehind(refs.fx, refs.baseOid, refs.headOid).behind.length : 0;
  const conflictFiles =
    open && refs.headRefExists && behindBy > 0
      ? mergeCommits(refs.fx, refs.baseOid, refs.headOid).conflicts
      : [];

  const blockers: Array<Mergeability["blockers"][number]> = [];
  const block = (code: Mergeability["blockers"][number]["code"], message: string) =>
    blockers.push({ code, message });
  if (pull.merged) block("merged", "This pull request is merged");
  else if (!open) block("closed", "This pull request is closed");
  else {
    if (repo.archived) block("archived", "The repository is archived");
    if (!viewer.canWrite) block("no_permission", "You cannot merge into this repository");
    if (!refs.headRefExists) block("head_missing", "The head branch was deleted");
    if (pull.draft) block("draft", "This pull request is a draft");
    if (conflictFiles.length > 0) block("conflicts", "The branch has conflicts with the base");
    const failed = required.filter((item) => item.state === "failure" || item.state === "error");
    const waiting = required.filter((item) => item.state === null || item.state === "pending");
    if (failed.length > 0) {
      block(
        "checks_failed",
        `${failed.length} required ${failed.length === 1 ? "check" : "checks"} failed`,
      );
    } else if (waiting.length > 0) {
      block("checks_pending", "Required checks have not finished");
    }
    if (reviews.changesRequested > 0) block("changes_requested", "Changes were requested");
    else if (reviews.approvals < reviews.requiredApprovals) {
      const missing = reviews.requiredApprovals - reviews.approvals;
      block(
        "approvals_required",
        `${missing} more approving ${missing === 1 ? "review" : "reviews"} required`,
      );
    }
    if (
      rule?.restrictPushers === true &&
      !viewer.isAdmin &&
      !rule.pushers.some((user) => viewer.is(user))
    ) {
      block("push_restricted", `Only some people may merge into ${pull.baseRef}`);
    }
  }
  const soft = new Set([
    "checks_failed",
    "checks_pending",
    "approvals_required",
    "changes_requested",
  ]);
  const allowedMethods: MergeMethod[] = [];
  if (repo.merge.allowMergeCommit) allowedMethods.push("merge");
  if (repo.merge.allowSquash) allowedMethods.push("squash");
  if (repo.merge.allowRebase) allowedMethods.push("rebase");
  return {
    state:
      !open || !refs.headRefExists ? "unknown" : conflictFiles.length > 0 ? "conflicting" : "clean",
    conflictFiles,
    behindBy,
    checks: { state: combine(statuses), statuses, required },
    reviews,
    protection: rule ? { pattern: rule.pattern, enforceAdmins: rule.enforceAdmins } : null,
    blockers,
    canMerge: blockers.length === 0,
    canBypass:
      viewer.isAdmin &&
      rule !== null &&
      !rule.enforceAdmins &&
      blockers.length > 0 &&
      blockers.every((item) => soft.has(item.code)),
    allowedMethods,
    defaultMethod: allowedMethods.includes(repo.merge.defaultMethod)
      ? repo.merge.defaultMethod
      : (allowedMethods[0] ?? "merge"),
    canUpdateBranch:
      open && viewer.canWrite && refs.headRefExists && behindBy > 0 && conflictFiles.length === 0,
  };
}

export function toPullSummary(repo: RepositoryRecord, thread: ThreadRecord): PullRequestSummary {
  const pull = thread.pull!;
  const refs = refsOf(repo, pull);
  const statuses = refs.headOid === "" ? [] : statusesFor(repo, refs.headOid);
  return {
    ...threadFields(threadsOf(repo), thread),
    state: pull.merged ? "merged" : thread.state,
    draft: pull.draft,
    baseRef: pull.baseRef,
    headRef: pull.headRef,
    headRepository: {
      id: repo.id,
      owner: repo.owner.slug,
      name: repo.name,
      visibility: repo.visibility,
    },
    crossRepository: false,
    headOid: refs.headOid,
    status: combine(statuses),
    reviewDecision: pull.merged ? null : reviewTally(repo, pull, refs.headOid).decision,
    mergedAt: pull.merged?.at ?? null,
  };
}

export function pullDiffBase(refs: PullRefs): string | null {
  return refs.mergeBaseOid;
}

export function toPull(repo: RepositoryRecord, thread: ThreadRecord): PullRequest {
  const pull = thread.pull!;
  const refs = refsOf(repo, pull);
  const viewer = viewerOf(repo);
  const own = viewer.is(thread.author);
  const files = diffCommits(refs.fx, refs.mergeBaseOid, refs.headOid, { hunks: false });
  const pendingReview = pull.reviews.find(
    (item) => item.state === "pending" && viewer.is(item.author),
  );
  return {
    ...toPullSummary(repo, thread),
    body: thread.body,
    bodyEditedAt: thread.bodyEditedAt,
    closedBy: thread.closedBy,
    lockReason: thread.lockReason,
    baseOid: refs.baseOid,
    mergeBaseOid: refs.mergeBaseOid,
    headRefExists: refs.headRefExists,
    commitCount: commitsOf(refs).length,
    stats: statsOf(files),
    mergedBy: pull.merged?.by ?? null,
    mergeCommitOid: pull.merged?.commitOid ?? null,
    mergeMethod: pull.merged?.method ?? null,
    mergeability: mergeabilityOf(repo, thread),
    viewer: {
      ...threadViewer(repo, thread),
      canEdit: own || viewer.canWrite,
      canReview: viewer.signedIn && thread.state === "open",
      canApprove: viewer.signedIn && !own && thread.state === "open",
      pendingReviewId: pendingReview?.id ?? null,
      canDeleteHeadBranch:
        viewer.canWrite &&
        refs.headRefExists &&
        thread.state === "closed" &&
        pull.headRef !== repo.defaultBranch,
    },
  };
}

/** A thread's timeline as the API serves it: stored entries with reviews placed by time. */
export function timelineOf(repo: RepositoryRecord, thread: ThreadRecord): TimelineItem[] {
  const entries: Array<{ at: string; item: TimelineItem }> = thread.items.map((item) => ({
    at: item.type === "comment" ? item.comment.createdAt : item.createdAt,
    item:
      item.type === "comment"
        ? { ...item, comment: presentComment(repo, thread, item.comment) }
        : item,
  }));
  if (thread.pull) {
    const all = reviewThreadsOf(repo, thread);
    for (const item of reviewsOf(repo, thread)) {
      if (item.state === "pending" || item.submittedAt === null) continue;
      const started = all.filter((t) => t.comments[0]?.reviewId === item.id);
      // A reply in someone else's thread is a review with no words and no thread of its own.
      if (item.state === "commented" && item.body.trim() === "" && started.length === 0) continue;
      entries.push({
        at: item.submittedAt,
        item: {
          type: "review",
          id: `review_${item.id}`,
          review: item,
          threads: started,
        },
      });
    }
  }
  return entries.sort((a, b) => a.at.localeCompare(b.at)).map((entry) => entry.item);
}

// ---------------------------------------------------------------------------
// Filtering and sorting a list
// ---------------------------------------------------------------------------

export interface ThreadFilter {
  readonly label?: string | undefined;
  readonly assignee?: string | undefined;
  readonly author?: string | undefined;
  readonly milestone?: string | undefined;
  readonly q?: string | undefined;
  readonly sort?: "created" | "updated" | "comments" | undefined;
  readonly direction?: "asc" | "desc" | undefined;
}

const who = (name: string): string | null =>
  name === "@me" ? (currentUser()?.username ?? null) : name;

export function filterThreads(
  repo: RepositoryRecord,
  threads: ReadonlyArray<ThreadRecord>,
  query: ThreadFilter,
): ThreadRecord[] {
  const store = threadsOf(repo);
  const labels = (query.label ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  const words = (query.q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const kept = threads.filter((thread) => {
    const names = store.labels
      .filter((label) => thread.labelIds.includes(label.id))
      .map((label) => label.name.toLowerCase());
    if (!labels.every((name) => names.includes(name))) return false;
    if (query.assignee !== undefined) {
      if (query.assignee === "none") {
        if (thread.assignees.length > 0) return false;
      } else if (!thread.assignees.some((user) => user.username === who(query.assignee!))) {
        return false;
      }
    }
    if (query.author !== undefined && thread.author?.username !== who(query.author)) return false;
    if (query.milestone !== undefined) {
      if (
        query.milestone === "none"
          ? thread.milestone !== null
          : String(thread.milestone) !== query.milestone
      ) {
        return false;
      }
    }
    const text = `${thread.title}\n${thread.body}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
  const key = (thread: ThreadRecord): string | number =>
    query.sort === "comments"
      ? commentCountOf(thread)
      : query.sort === "updated"
        ? thread.updatedAt
        : thread.createdAt;
  const sign = query.direction === "asc" ? 1 : -1;
  return kept.sort((a, b) => {
    const [x, y] = [key(a), key(b)];
    return x < y ? -sign : x > y ? sign : b.number - a.number;
  });
}

export function milestoneWithCounts(repo: RepositoryRecord, item: MilestoneRecord): Milestone {
  const threads = threadsOf(repo).threads.filter((thread) => thread.milestone === item.number);
  return {
    ...item,
    openCount: threads.filter((thread) => thread.state === "open").length,
    closedCount: threads.filter((thread) => thread.state === "closed").length,
  };
}

export function touch(thread: ThreadRecord): void {
  thread.updatedAt = new Date().toISOString();
}
