/**
 * The mock's work across repositories: what the home page, the Changes
 * list and the Mentions list are answered from. Acme is a team of five with
 * fifteen open branches in three repositories, some written by agents;
 * Tidewater has two, and mara's own namespace none.
 *
 * `acme/infra` #12 and #14 and `acme/edge-router` #4 are the branch pages
 * `threads-data.ts` holds, so their rows open a real page. The rest exist
 * only here: there are more branches in a team's week than the fixtures have
 * histories for.
 */
import type {
  ActivityEvent,
  AgentKind,
  ChangeState,
  ChangeSummary,
  Mention,
  RepositoryRef,
  SuggestedReview,
  SuggestionReason,
  UserRef,
} from "@infrawrench/git-contract";
import { findRepository } from "./db";
import { FIXTURE_PEOPLE } from "./git";

const hoursAgo = (hours: number): string => new Date(Date.now() - hours * 3_600_000).toISOString();

/** The rest of Acme's team, beside the three the fixtures' commits name. */
const PEOPLE: Record<string, UserRef> = {
  mara: FIXTURE_PEOPLE["mara@acme.example"]!,
  jonas: FIXTURE_PEOPLE["jonas@acme.example"]!,
  priya: FIXTURE_PEOPLE["priya@acme.example"]!,
  tomas: { id: "user_tomas", username: "tomas", displayName: "Tomas Ortega", avatarUrl: null },
  aiko: { id: "user_aiko", username: "aiko", displayName: "Aiko Tanaka", avatarUrl: null },
};

const AGENTS: Record<string, { kind: AgentKind; displayName: string }> = {
  infrawrench: { kind: "infrawrench", displayName: "Infrawrench agent" },
  t3: { kind: "t3", displayName: "T3 Code" },
  mcp: { kind: "mcp", displayName: "Claude Code" },
};

const repositoryRef = (owner: string, name: string): RepositoryRef => {
  const repo = findRepository(owner, name);
  return { id: repo.id, owner: repo.owner.slug, name: repo.name, visibility: repo.visibility };
};

/** A commit id that looks like one, from a seed. */
const oid = (seed: number): string =>
  Array.from({ length: 40 }, (_, index) => ((seed * (index + 7) * 2654435761) >>> 4) % 16)
    .map((digit) => digit.toString(16))
    .join("");

interface Seed {
  repo: [owner: string, name: string];
  number: number;
  title: string;
  summary: string | null;
  branch: string;
  by: keyof typeof PEOPLE;
  agent?: keyof typeof AGENTS;
  state: ChangeState;
  draft?: boolean;
  hours: number;
  version: number;
  lines: [additions: number, deletions: number, files: number];
  mustFix?: number;
  reason?: SuggestionReason;
  reviewed?: number;
}

const ACME_INFRA: Seed["repo"] = ["acme", "infra"];
const ACME_EDGE: Seed["repo"] = ["acme", "edge-router"];
const ACME_BILLING: Seed["repo"] = ["acme", "billing-events"];

const SEEDS: Seed[] = [
  {
    repo: ACME_INFRA,
    number: 12,
    title: "Peer with the shared services VPC",
    summary: "Adds a peering connection and routes to the shared services account",
    branch: "feature/vpc-peering",
    by: "jonas",
    state: "needs_review",
    hours: 0.85,
    version: 3,
    lines: [148, 12, 6],
    reason: { kind: "reviewed_before", version: 2 },
    reviewed: 2,
  },
  {
    repo: ACME_EDGE,
    number: 4,
    title: "Skip upstreams that fail their health check",
    summary: "Route around an upstream after three failed probes and bring it back after one",
    branch: "feature/health-checks",
    by: "mara",
    agent: "infrawrench",
    state: "agent_working",
    draft: true,
    hours: 2,
    version: 2,
    lines: [212, 31, 7],
  },
  {
    repo: ACME_INFRA,
    number: 14,
    title: "Keep two weeks of database backups by default",
    summary: "Raises the retention default and lets an environment override it",
    branch: "fix/database-backups",
    by: "priya",
    agent: "t3",
    state: "agent_working",
    hours: 3,
    version: 4,
    lines: [38, 9, 3],
  },
  {
    repo: ACME_BILLING,
    number: 13,
    title: "Deduplicate usage events by idempotency key",
    summary: "Drops a repeated event before it reaches the ledger and counts what it dropped",
    branch: "feature/dedupe-events",
    by: "tomas",
    state: "needs_review",
    hours: 9,
    version: 1,
    lines: [96, 14, 5],
    reason: { kind: "assigned", version: null },
  },
  {
    repo: ACME_EDGE,
    number: 10,
    title: "fix weight rounding",
    summary: null,
    branch: "fix/weight-rounding",
    by: "aiko",
    state: "needs_review",
    hours: 10,
    version: 1,
    lines: [9, 4, 1],
    reason: { kind: "pushes_to_repository", version: null },
  },
  {
    repo: ACME_BILLING,
    number: 14,
    title: "Emit a metric for late events",
    summary: "Counts events that arrive after their billing window closed, by source",
    branch: "feature/late-event-metric",
    by: "aiko",
    agent: "infrawrench",
    state: "needs_review",
    hours: 10.5,
    version: 2,
    lines: [57, 3, 4],
    reason: { kind: "commented", version: 1 },
  },
  {
    repo: ACME_INFRA,
    number: 21,
    title: "Split the staging and production state",
    summary: "Moves each environment to a workspace of its own with its own lock",
    branch: "feature/split-state",
    by: "mara",
    state: "approved",
    hours: 16,
    version: 3,
    lines: [320, 280, 14],
  },
  {
    repo: ACME_BILLING,
    number: 12,
    title: "Retry ledger writes with backoff",
    summary: "Retries a failed write up to five times and parks the event after that",
    branch: "feature/ledger-retries",
    by: "mara",
    agent: "t3",
    state: "needs_review",
    hours: 19,
    version: 2,
    lines: [84, 11, 4],
  },
  {
    repo: ACME_EDGE,
    number: 9,
    title: "Cache route tables per host",
    summary: "Builds the table once per host and invalidates it when the route file changes",
    branch: "feature/route-cache",
    by: "mara",
    state: "changes_requested",
    hours: 20,
    version: 2,
    lines: [176, 42, 8],
    mustFix: 2,
  },
  {
    repo: ACME_INFRA,
    number: 22,
    title: "Tag every resource with its cost centre",
    summary: "A default_tags block per provider, and a check that fails a plan without one",
    branch: "feature/cost-centre-tags",
    by: "jonas",
    state: "approved",
    hours: 26,
    version: 2,
    lines: [64, 8, 9],
  },
  {
    repo: ACME_EDGE,
    number: 11,
    title: "Trace requests through the router",
    summary: "Starts a span per request and passes the trace context to the upstream",
    branch: "feature/request-tracing",
    by: "priya",
    state: "changes_requested",
    hours: 29,
    version: 1,
    lines: [133, 6, 5],
  },
  {
    repo: ACME_BILLING,
    number: 15,
    title: "bump ledger client",
    summary: null,
    branch: "chore/ledger-client",
    by: "tomas",
    state: "needs_review",
    hours: 47,
    version: 1,
    lines: [6, 6, 2],
    reason: { kind: "pushes_to_repository", version: null },
  },
  {
    repo: ACME_INFRA,
    number: 23,
    title: "Alarm on NAT gateway errors",
    summary: "An alarm per gateway on port allocation errors, routed to the on-call topic",
    branch: "feature/nat-alarms",
    by: "tomas",
    agent: "mcp",
    state: "needs_review",
    hours: 52,
    version: 2,
    lines: [71, 0, 3],
  },
  {
    repo: ACME_EDGE,
    number: 12,
    title: "Drain connections before a deploy",
    summary: "Stops accepting new connections and waits for the open ones, up to a limit",
    branch: "feature/connection-draining",
    by: "jonas",
    state: "needs_review",
    draft: true,
    hours: 70,
    version: 1,
    lines: [88, 5, 4],
  },
  {
    repo: ACME_INFRA,
    number: 24,
    title: "Move DNS records into their own module",
    summary: "One module for the zone and its records, with the same addresses as before",
    branch: "refactor/dns-module",
    by: "aiko",
    state: "needs_review",
    hours: 96,
    version: 1,
    lines: [210, 198, 11],
  },
  {
    repo: ACME_EDGE,
    number: 8,
    title: "Reload routes without dropping requests",
    summary: "Swaps the route table in one step, so a request sees the old one or the new one",
    branch: "feature/hot-reload",
    by: "mara",
    state: "merged",
    hours: 120,
    version: 3,
    lines: [142, 37, 6],
  },
  {
    repo: ACME_BILLING,
    number: 11,
    title: "Batch ledger writes",
    summary: "Writes up to a hundred events in one transaction",
    branch: "feature/batch-writes",
    by: "priya",
    state: "merged",
    hours: 144,
    version: 2,
    lines: [118, 64, 5],
  },
  {
    repo: ACME_INFRA,
    number: 7,
    title: "network: optional VPC flow logs",
    summary: "A variable that turns flow logs on for a VPC and names where they go",
    branch: "feature/flow-logs",
    by: "jonas",
    state: "merged",
    hours: 24 * 43,
    version: 2,
    lines: [52, 2, 3],
  },
  {
    repo: ["tidewater", "ledger"],
    number: 3,
    title: "Round half to even in the daily close",
    summary: "The close used the platform's rounding, which differs between the two runtimes",
    branch: "fix/rounding",
    by: "priya",
    state: "needs_review",
    hours: 6,
    version: 1,
    lines: [24, 9, 2],
    reason: { kind: "pushes_to_repository", version: null },
  },
  {
    repo: ["tidewater", "tide-tables"],
    number: 2,
    title: "Import the 2027 tide tables",
    summary: "Adds the year's predictions for every station and the check that compares them",
    branch: "feature/tables-2027",
    by: "mara",
    agent: "infrawrench",
    state: "needs_review",
    hours: 30,
    version: 2,
    lines: [1840, 0, 13],
  },
];

const ME = "mara";

function toChange(seed: Seed): ChangeSummary {
  return {
    repository: repositoryRef(...seed.repo),
    key: seed.branch,
    number: seed.number,
    title: seed.title,
    branch: seed.branch,
    draft: seed.draft ?? false,
    state: seed.state,
    summary: seed.summary,
    headOid: oid(seed.number * 31 + seed.title.length),
    author: PEOPLE[seed.by]!,
    agent: seed.agent === undefined ? null : AGENTS[seed.agent]!,
    latestVersion: seed.version,
    mustFixOpen: seed.mustFix ?? 0,
    size: { additions: seed.lines[0], deletions: seed.lines[1], changedFiles: seed.lines[2] },
    updatedAt: hoursAgo(seed.hours),
  };
}

const inNamespace = (namespace: string | undefined) => (seed: Seed) =>
  namespace === undefined || seed.repo[0].toLowerCase() === namespace.toLowerCase();

const isOpen = (seed: Seed) => seed.state !== "merged" && seed.state !== "closed";

export function mockChanges(filter: {
  namespace?: string | undefined;
  state: "open" | "merged" | "all";
  author: "mine" | "team" | "all";
}): ChangeSummary[] {
  return SEEDS.filter(inNamespace(filter.namespace))
    .filter((seed) =>
      filter.state === "all"
        ? true
        : filter.state === "merged"
          ? seed.state === "merged"
          : isOpen(seed),
    )
    .filter((seed) =>
      filter.author === "all" ? true : filter.author === "mine" ? seed.by === ME : seed.by !== ME,
    )
    .sort((a, b) => a.hours - b.hours)
    .map(toChange);
}

export function mockSuggested(namespace: string | undefined): SuggestedReview[] {
  const rank = (seed: Seed) =>
    seed.reason === undefined
      ? 0
      : seed.reason.kind === "assigned"
        ? 3
        : seed.reason.kind === "pushes_to_repository"
          ? 1
          : 2;
  return SEEDS.filter(inNamespace(namespace))
    .filter((seed) => seed.by !== ME && seed.state === "needs_review" && seed.draft !== true)
    .sort((a, b) => rank(b) - rank(a) || a.hours - b.hours)
    .map((seed) => ({
      ...toChange(seed),
      reviewedVersion: seed.reviewed ?? null,
      reasons: seed.reason === undefined ? [] : [seed.reason],
    }));
}

export function mockAgentsWorking(namespace: string | undefined): number {
  return SEEDS.filter(inNamespace(namespace)).filter((seed) => seed.state === "agent_working")
    .length;
}

interface EventSeed {
  repo: Seed["repo"];
  number: number;
  type: ActivityEvent["type"];
  hours: number;
  by?: keyof typeof PEOPLE;
  agent?: keyof typeof AGENTS;
  version?: number;
  findings?: { found: number; mustFix: number };
}

const EVENTS: EventSeed[] = [
  { repo: ACME_INFRA, number: 12, type: "pushed", hours: 0.85, by: "jonas", version: 3 },
  {
    repo: ACME_EDGE,
    number: 9,
    type: "findings",
    hours: 1.4,
    version: 2,
    findings: { found: 3, mustFix: 2 },
  },
  {
    repo: ACME_EDGE,
    number: 4,
    type: "pushed",
    hours: 2,
    by: "mara",
    agent: "infrawrench",
    version: 2,
  },
  { repo: ACME_INFRA, number: 14, type: "pushed", hours: 3, by: "priya", agent: "t3", version: 4 },
  { repo: ["tidewater", "ledger"], number: 3, type: "pushed", hours: 6, by: "priya", version: 1 },
  { repo: ACME_BILLING, number: 13, type: "pushed", hours: 9, by: "tomas", version: 1 },
  { repo: ACME_EDGE, number: 10, type: "pushed", hours: 10, by: "aiko", version: 1 },
  { repo: ACME_INFRA, number: 21, type: "approved", hours: 16, by: "priya" },
  {
    repo: ACME_BILLING,
    number: 12,
    type: "pushed",
    hours: 19,
    by: "mara",
    agent: "t3",
    version: 2,
  },
  { repo: ACME_EDGE, number: 9, type: "changes_requested", hours: 20, by: "jonas" },
  { repo: ACME_INFRA, number: 22, type: "approved", hours: 26, by: "mara" },
  { repo: ACME_EDGE, number: 11, type: "changes_requested", hours: 29, by: "aiko" },
  {
    repo: ["tidewater", "tide-tables"],
    number: 2,
    type: "pushed",
    hours: 30,
    by: "mara",
    agent: "infrawrench",
    version: 2,
  },
  { repo: ACME_BILLING, number: 15, type: "pushed", hours: 47, by: "tomas", version: 1 },
  {
    repo: ACME_INFRA,
    number: 23,
    type: "pushed",
    hours: 52,
    by: "tomas",
    agent: "mcp",
    version: 2,
  },
  { repo: ACME_BILLING, number: 14, type: "commented", hours: 60, by: "mara" },
  { repo: ACME_EDGE, number: 8, type: "merged", hours: 120, by: "mara" },
  { repo: ACME_BILLING, number: 11, type: "merged", hours: 144, by: "jonas" },
];

/** The key of a branch the list names by number: its branch. */
const branchOf = (repo: Seed["repo"], number: number): string =>
  SEEDS.find((seed) => seed.repo.join("/") === repo.join("/") && seed.number === number)?.branch ??
  `work/${number}`;

const titleOf = (repo: Seed["repo"], number: number): string =>
  SEEDS.find((seed) => seed.repo.join("/") === repo.join("/") && seed.number === number)?.title ??
  `#${number}`;

export function mockActivity(namespace: string | undefined, days: number): ActivityEvent[] {
  return EVENTS.filter(
    (event) =>
      event.hours <= days * 24 &&
      (namespace === undefined || event.repo[0].toLowerCase() === namespace.toLowerCase()),
  ).map((event, index) => ({
    id: `event_${index}_${event.repo.join("_")}_${event.number}`,
    type: event.type,
    at: hoursAgo(event.hours),
    actor: event.by === undefined ? null : PEOPLE[event.by]!,
    agent: event.agent === undefined ? null : AGENTS[event.agent]!.displayName,
    repository: repositoryRef(...event.repo),
    number: event.number,
    key: branchOf(event.repo, event.number),
    title: titleOf(event.repo, event.number),
    version: event.version ?? null,
    findings: event.findings ?? null,
  }));
}

/** The repositories pushed to in the window, the most pushes first, and how many pushes. */
export function mockPushed(
  namespace: string | undefined,
  days: number,
): { versions: number; repositories: RepositoryRef[] } {
  const pushes = mockActivity(namespace, days).filter((event) => event.type === "pushed");
  const counts = new Map<string, { repository: RepositoryRef; count: number }>();
  for (const event of pushes) {
    const entry = counts.get(event.repository.id) ?? { repository: event.repository, count: 0 };
    entry.count += 1;
    counts.set(event.repository.id, entry);
  }
  return {
    versions: pushes.length,
    repositories: [...counts.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 6)
      .map((entry) => entry.repository),
  };
}

interface MentionSeed {
  repo: Seed["repo"];
  number: number;
  title?: string;
  page: boolean;
  kind: Mention["kind"];
  by: keyof typeof PEOPLE;
  excerpt: string;
  hours: number;
}

const MENTIONS: MentionSeed[] = [
  {
    repo: ACME_INFRA,
    number: 12,
    page: true,
    kind: "review_comment",
    by: "jonas",
    excerpt: "@mara the route table ids come from the shared account now, is that what you meant?",
    hours: 1.2,
  },
  {
    repo: ACME_BILLING,
    number: 13,
    page: true,
    kind: "comment",
    by: "tomas",
    excerpt: "@mara could you look at the dedupe window before Thursday's close?",
    hours: 8,
  },
  {
    repo: ACME_EDGE,
    number: 9,
    page: true,
    kind: "review_comment",
    by: "jonas",
    excerpt: "This invalidates on every reload. @mara, key it on the file's hash instead.",
    hours: 20,
  },
  {
    repo: ACME_INFRA,
    number: 15,
    title: "Rotate the database master password",
    page: false,
    kind: "comment",
    by: "priya",
    excerpt: "cc @mara, this needs the same maintenance window as the backup change.",
    hours: 44,
  },
  {
    repo: ACME_EDGE,
    number: 11,
    page: true,
    kind: "comment",
    by: "aiko",
    excerpt: "@mara does the router already forward traceparent, or only the request id?",
    hours: 55,
  },
  {
    repo: ACME_BILLING,
    number: 11,
    page: true,
    kind: "comment",
    by: "priya",
    excerpt: "Merged. Thanks @mara and @jonas for the load numbers.",
    hours: 144,
  },
];

export function mockMentions(): Mention[] {
  return MENTIONS.map((mention, index) => ({
    id: `mention_${index}`,
    kind: mention.kind,
    repository: repositoryRef(...mention.repo),
    number: mention.number,
    title: mention.title ?? titleOf(mention.repo, mention.number),
    branch: mention.page ? branchOf(mention.repo, mention.number) : null,
    author: PEOPLE[mention.by]!,
    excerpt: mention.excerpt,
    createdAt: hoursAgo(mention.hours),
  }));
}
