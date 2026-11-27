/**
 * The mock's agent work review: a branch's versions, what the agent that
 * wrote them recorded, what review agents found, what reviewers sent back,
 * and the agent behind the branch. Kept per branch page, beside the page
 * thread's own state in `threads-data.ts`, which reads only the merge gate
 * from here (so this file never imports that one).
 *
 * `acme/infra` #12 has three versions (the second a forced push), a trace
 * for each, findings of every severity and state, and instructions that were
 * answered. #14 is written by a T3 Code thread that is still working. #7 was
 * merged six weeks ago: its versions are pruned, and what a reviewer outside
 * the forge found on it is what the merged commit and the files it touched
 * show. `acme/edge-router` #4 has findings from such a reviewer in a
 * repository whose own review agents are off.
 */
import type {
  AgentIdentity,
  AgentLink,
  FindingsTally,
  Instruction,
  MergeOverride,
  ReviewFinding,
  ReviewRun,
  ReviewSettings,
  TraceEntry,
  UserRef,
} from "@infrawrench/git-contract";
import { REVIEWER_KINDS } from "@infrawrench/git-contract";
import { LINT_NOTES, runsOf } from "./ci-data";
import type { Mutable } from "./define";
import { accessTo, currentUser, gitOf, type RepositoryRecord } from "./db";
import type { GitFixture } from "./git";
import { hoursAgo, newId, person } from "./settings-data";

export interface StoredVersion {
  number: number;
  tipOid: string;
  previousOid: string | null;
  forced: boolean;
  rebased: boolean;
  pusher: UserRef | null;
  pusherKind: string | null;
  agent: AgentIdentity | null;
  createdAt: string;
  /** When its commit stopped being kept. Absent while it is. */
  prunedAt?: string;
}

export type StoredFinding = Mutable<Omit<ReviewFinding, "overridden" | "viewerCanDismiss">> & {
  /** What the mock's agent changes when it is sent this finding. */
  fix?: { find: string; insert: string };
};

/** Something the mock's agent has been given and will push a version for. */
export interface Work {
  instructionId: string | null;
  since: number;
  note: string;
  /** The agent has picked it up. */
  started: boolean;
}

export interface ReviewState {
  versions: StoredVersion[];
  reviewed: number | null;
  traces: Array<Mutable<TraceEntry>>;
  findings: StoredFinding[];
  overrides: Array<Mutable<MergeOverride>>;
  instructions: Array<Mutable<Instruction>>;
  agent: Mutable<AgentLink> | null;
  runs: Array<Mutable<ReviewRun>>;
  work: Work[];
  /** Version pairs whose interdiff the mock answers as not exact. */
  inexact: Array<[number, number]>;
}

const blank = (): ReviewState => ({
  versions: [],
  reviewed: null,
  traces: [],
  findings: [],
  overrides: [],
  instructions: [],
  agent: null,
  runs: [],
  work: [],
  inexact: [],
});

const states = new Map<string, ReviewState>();
const keyOf = (repo: RepositoryRecord, number: number): string => `${repo.id}#${number}`;

const INFRAWRENCH_AGENT: AgentIdentity = {
  kind: "infrawrench",
  name: "Infrawrench agent",
  sessionRef: "ses_8f2c41",
};
const T3_AGENT: AgentIdentity = { kind: "t3", name: "T3 Code", sessionRef: "thr_backups" };
const CLAUDE_CODE: AgentIdentity = { kind: "mcp", name: "Claude Code", sessionRef: null };
/** A reviewer that runs in CI and reports through the API: none of the forge's own. */
const OUTSIDE_REVIEWER = "claude-review";

function oidOf(fx: GitFixture, prefix: string): string {
  const found = fx.order.find((oid) => oid.startsWith(prefix));
  if (found === undefined) throw new Error(`No fixture commit ${prefix}`);
  return found;
}

function entry(
  kind: TraceEntry["kind"],
  version: number | null,
  hours: number,
  body: string,
  rest: Partial<Pick<TraceEntry, "anchors" | "evidence" | "needsCode">> & {
    branch: string;
    agent: AgentIdentity;
  },
): Mutable<TraceEntry> {
  return {
    id: newId("trace"),
    kind,
    body,
    anchors: rest.anchors ?? [],
    // As the server decides it when the writer does not say: a line is code to show.
    needsCode:
      rest.needsCode ??
      (rest.anchors ?? []).some(
        (anchor) => anchor.startLine !== undefined && anchor.startLine !== null,
      ),
    evidence: rest.evidence ?? null,
    author: person("jonas"),
    agent: rest.agent,
    branch: rest.branch,
    version,
    createdAt: hoursAgo(hours),
  };
}

function finding(
  fields: Pick<StoredFinding, "reviewerKind" | "severity" | "title" | "body" | "version"> &
    Partial<StoredFinding>,
  commitOid: string,
  hours: number,
): StoredFinding {
  return {
    id: newId("finding"),
    path: null,
    side: "RIGHT",
    startLine: null,
    endLine: null,
    commitOid,
    evidence: [],
    status: "open",
    lastSeenVersion: fields.version,
    fixedInVersion: null,
    dismissedBy: null,
    dismissedAt: null,
    dismissalReason: null,
    runId: null,
    createdAt: hoursAgo(hours),
    updatedAt: hoursAgo(hours),
    needsCode:
      fields.path !== undefined &&
      fields.path !== null &&
      ((fields.startLine ?? null) !== null || (fields.endLine ?? null) !== null),
    ...fields,
  };
}

function run(
  version: number,
  headOid: string,
  hours: number,
  kinds: string[],
  count: number,
): Mutable<ReviewRun> {
  return {
    id: newId("rrun"),
    version,
    headOid,
    status: "done",
    reviewerKinds: kinds,
    trigger: "push",
    requestedBy: null,
    model: "claude-sonnet-4-5",
    usage: { inputTokens: 18_400 + version * 2_150, outputTokens: 1_260, costUsd: 0.07 },
    findingCount: count,
    error: null,
    startedAt: hoursAgo(hours),
    finishedAt: hoursAgo(hours - 0.02),
    createdAt: hoursAgo(hours),
  };
}

/** `acme/infra` #12: `feature/vpc-peering`, three versions by an Infrawrench agent. */
function seedPeering(fx: GitFixture, repo: RepositoryRecord): ReviewState {
  const branch = "feature/vpc-peering";
  const [v1, v2, v3] = [oidOf(fx, "cce1b1a"), oidOf(fx, "a825307"), oidOf(fx, "2c26b50")];
  const version = (
    number: number,
    tipOid: string,
    previousOid: string | null,
    hours: number,
    forced = false,
  ): StoredVersion => ({
    number,
    tipOid,
    previousOid,
    forced,
    rebased: forced,
    pusher: person("jonas"),
    pusherKind: "api-key",
    agent: INFRAWRENCH_AGENT,
    createdAt: hoursAgo(hours),
  });
  const by = { branch, agent: INFRAWRENCH_AGENT };
  const state = blank();
  state.versions = [version(1, v1, null, 72), version(2, v2, v1, 50, true), version(3, v3, v2, 38)];
  state.reviewed = 2;
  state.inexact = [[1, 3]];
  state.agent = {
    kind: "infrawrench",
    displayName: "Infrawrench agent",
    externalRefs: { sessionId: "ses_8f2c41", organizationId: "org_acme" },
    t3EnvironmentId: null,
    connectedBy: person("jonas"),
    createdAt: hoursAgo(73),
    updatedAt: hoursAgo(38),
  };
  state.traces = [
    entry(
      "ask",
      1,
      72.6,
      "Peer each environment's VPC with shared services, so the cluster reaches the artifact registry and the metrics gateway without going through NAT. Staging first.",
      by,
    ),
    entry(
      "step",
      1,
      72.4,
      "Added `peer_vpcs` to the network module: a map by name, empty by default, so every existing root plans no change.",
      { ...by, anchors: [{ path: "modules/network/variables.tf", startLine: 35, endLine: 43 }] },
    ),
    entry(
      "step",
      1,
      72.3,
      "One peering connection per entry, and one route per private route table per peer.",
      { ...by, anchors: [{ path: "modules/network/main.tf", startLine: 108, endLine: 129 }] },
    ),
    entry(
      "decision",
      1,
      72.3,
      "Routes are keyed by peer name and zone index (`shared-0`), not by route table id: the ids are not known until apply, and `for_each` needs keys it can read at plan.",
      { ...by, anchors: [{ path: "modules/network/main.tf", startLine: 121, endLine: 124 }] },
    ),
    entry("evidence", 1, 72.2, "The module validates with no peers and with one.", {
      ...by,
      evidence: {
        command: "terraform -chdir=modules/network validate",
        exitCode: 0,
        output: "Success! The configuration is valid.",
      },
    }),
    entry(
      "doubt",
      1,
      72.1,
      "Nothing here accepts the connection on the shared services side. I could not tell whether that account accepts automatically.",
      {
        ...by,
        // It is about what is missing, not what these lines say.
        needsCode: false,
        anchors: [{ path: "modules/network/main.tf", startLine: 108, endLine: 118 }],
      },
    ),
    entry("step", 2, 50.4, "Staging peers with shared services in `eu-central-1`.", {
      ...by,
      anchors: [{ path: "environments/staging/main.tf", startLine: 29, endLine: 35 }],
    }),
    entry(
      "note",
      2,
      50.3,
      "Rewrote the first commit to describe `peer_vpcs` after the review comment on it, so this version is a forced push.",
      { ...by, anchors: [{ path: "modules/network/variables.tf", startLine: 36 }] },
    ),
    entry("evidence", 2, 50.2, "Staging plans seven additions and nothing else.", {
      ...by,
      evidence: {
        command: "terraform -chdir=environments/staging plan -lock=false",
        exitCode: 0,
        output:
          '  # module.network.aws_route.peer["shared-0"] will be created\n  # module.network.aws_route.peer["shared-1"] will be created\n  # module.network.aws_route.peer["shared-2"] will be created\n  # module.network.aws_vpc_peering_connection.shared["shared"] will be created\n\nPlan: 4 to add, 0 to change, 0 to destroy.',
      },
    }),
    entry(
      "doubt",
      2,
      50.1,
      "The shared VPC's id is a literal. A data source would need a second provider alias in every root.",
      { ...by, anchors: [{ path: "environments/staging/main.tf", startLine: 31 }] },
    ),
    entry(
      "step",
      3,
      38.5,
      "A security group per peer: HTTPS, metrics scrapes and DNS in, answers back out.",
      { ...by, anchors: [{ path: "modules/network/main.tf", startLine: 131, endLine: 133 }] },
    ),
    entry(
      "doubt",
      3,
      38.4,
      "The way back allows every protocol to the peer's whole range. Narrower rules would have to track what shared services listens on.",
      { ...by, anchors: [{ path: "modules/network/main.tf", startLine: 181 }] },
    ),
    entry("step", 3, 38.3, "A page on how the routes are laid out, and the diagram redrawn.", {
      ...by,
      anchors: [{ path: "docs/peering.md", startLine: 1, endLine: 9 }],
    }),
    entry("evidence", 3, 38.2, "The pipeline's format and validate jobs pass on this commit.", {
      ...by,
      evidence: {
        command: "terraform fmt -check -recursive",
        exitCode: 0,
        output: "",
      },
    }),
  ];
  // What the lint job of the newest version's CI run printed as note commands
  // (`ci-data.ts` `LINT_NOTES`), as the app writes them: a doubt by the agent
  // `ci`, and below a finding by the reviewer `ci:<pipeline>/<job>`.
  const ciRun = runsOf(repo).find(
    (record) => record.run.sha === v3 && record.run.status === "passed",
  );
  const logLine = (line: number): string | null =>
    ciRun === undefined
      ? null
      : `/${repo.owner.slug}/${repo.name}/ci/runs/${ciRun.run.id}?job=${encodeURIComponent(LINT_NOTES.job)}#L${line}`;
  state.traces.push({
    ...entry(
      "doubt",
      3,
      30,
      "tflint has no rules for aws_vpc_security_group_egress_rule, so peer_all was not checked.",
      {
        branch,
        agent: { kind: "ci", name: LINT_NOTES.job, sessionRef: ciRun?.run.id ?? null },
        anchors: [{ path: "modules/network/main.tf", startLine: 176 }],
        evidence: { ciRunId: ciRun?.run.id ?? null, url: logLine(LINT_NOTES.doubt.line) },
      },
    ),
    author: null,
  });
  const accepter = finding(
    {
      reviewerKind: "terraform",
      severity: "must_fix",
      title: "The peering connection is never accepted",
      body: "`aws_vpc_peering_connection.shared` has no `auto_accept` and nothing creates an `aws_vpc_peering_connection_accepter`. The connection stays `pending-acceptance`, and the three routes point at a connection that carries no traffic.",
      version: 1,
      lastSeenVersion: 3,
      path: "modules/network/main.tf",
      startLine: 108,
      endLine: 118,
      evidence: [
        {
          kind: "code",
          text: 'resource "aws_vpc_peering_connection" "shared" {\n  for_each = var.peer_vpcs\n\n  vpc_id      = aws_vpc.this.id\n  peer_vpc_id = each.value.vpc_id\n  peer_region = each.value.region',
        },
        {
          kind: "reference",
          text: "A connection to another region or account is never accepted by `auto_accept`; the peer accepts it with `aws_vpc_peering_connection_accepter`.",
          url: "https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/vpc_peering_connection_accepter",
        },
      ],
      fix: {
        find: '    Name = "${var.name}-to-${each.key}"\n  })\n}\n',
        insert:
          '\nresource "aws_vpc_peering_connection_accepter" "shared" {\n  for_each = var.peer_vpcs\n  provider = aws.peer\n\n  vpc_peering_connection_id = aws_vpc_peering_connection.shared[each.key].id\n  auto_accept               = true\n}\n',
      },
    },
    v3,
    71.9,
  );
  state.findings = [
    accepter,
    finding(
      {
        reviewerKind: `ci:${LINT_NOTES.job}`,
        severity: "should_fix",
        title: "DNS is allowed over UDP only",
        body: "Answers over 512 bytes are retried over TCP, and no rule lets port 53 in over TCP.",
        version: 3,
        path: "modules/network/main.tf",
        startLine: 165,
        endLine: 174,
        evidence: [
          {
            kind: "ci",
            text: `Reported by the job lint of the pipeline terraform, on line ${LINT_NOTES.finding.line} of its log.`,
            url: logLine(LINT_NOTES.finding.line),
          },
        ],
      },
      v3,
      30,
    ),
    finding(
      {
        reviewerKind: "general",
        severity: "should_fix",
        title: "The shared VPC's id is written out",
        body: "The id changes when the shared services account recreates its VPC, and nothing here would notice until an apply fails.",
        version: 2,
        lastSeenVersion: 3,
        path: "environments/staging/main.tf",
        startLine: 31,
        endLine: 31,
        evidence: [{ kind: "code", text: '      vpc_id     = "vpc-0a1b2c3d4e5f60718"' }],
      },
      v3,
      49.9,
    ),
    finding(
      {
        reviewerKind: "intent",
        severity: "note",
        title: "The page does not say who accepts the connection",
        body: "The ask is that the cluster reaches shared services. The page covers the routes on this side only.",
        version: 3,
        path: "docs/peering.md",
        startLine: 3,
        endLine: 3,
      },
      v3,
      37.9,
    ),
    finding(
      {
        reviewerKind: "general",
        severity: "should_fix",
        title: "`peer_vpcs` has no description",
        body: "Every other variable of the module says what it is for.",
        version: 1,
        lastSeenVersion: 1,
        status: "fixed",
        fixedInVersion: 2,
        path: "modules/network/variables.tf",
        startLine: 35,
        endLine: 36,
      },
      v1,
      71.9,
    ),
    finding(
      {
        reviewerKind: "security",
        severity: "should_fix",
        title: "The peer's whole range is routed",
        body: "`10.0.0.0/16` is every subnet of shared services. The cluster needs the registry and the metrics gateway.",
        version: 1,
        lastSeenVersion: 3,
        status: "dismissed",
        dismissedBy: person("mara"),
        dismissedAt: hoursAgo(46),
        dismissalReason:
          "Security groups on the shared side decide what is reachable. Narrower routes would need changing every time a service moves.",
        path: "modules/network/main.tf",
        startLine: 127,
        endLine: 127,
      },
      v3,
      71.9,
    ),
  ];
  state.runs = [
    run(3, v3, 37.95, ["general", "security", "terraform", "intent"], 3),
    run(2, v2, 49.95, ["general", "security", "terraform", "intent"], 3),
    run(1, v1, 71.95, ["general", "security", "terraform", "intent"], 3),
  ];
  state.instructions = [
    {
      id: newId("ins"),
      source: "review_comment",
      reviewCommentId: null,
      findingId: null,
      body: "Say what the key is used for.",
      createdBy: person("priya"),
      status: "answered",
      deliveredVia: "infrawrench",
      deliveredAt: hoursAgo(51.9),
      answeredInVersion: 2,
      answeredAt: hoursAgo(50),
      dismissedBy: null,
      dismissedAt: null,
      createdAt: hoursAgo(52),
    },
    {
      id: newId("ins"),
      source: "text",
      reviewCommentId: null,
      findingId: null,
      body: "Add a page on how the routes are laid out, with the note about `zone_count` replacing every route.",
      createdBy: person("mara"),
      status: "answered",
      deliveredVia: "infrawrench",
      deliveredAt: hoursAgo(38.9),
      answeredInVersion: 3,
      answeredAt: hoursAgo(38),
      dismissedBy: null,
      dismissedAt: null,
      createdAt: hoursAgo(39),
    },
    {
      id: newId("ins"),
      source: "text",
      reviewCommentId: null,
      findingId: null,
      body: "Peer production in the same change.",
      createdBy: person("jonas"),
      status: "dismissed",
      deliveredVia: null,
      deliveredAt: null,
      answeredInVersion: null,
      answeredAt: null,
      dismissedBy: person("jonas"),
      dismissedAt: hoursAgo(47),
      createdAt: hoursAgo(48),
    },
  ];
  return state;
}

/** `acme/infra` #14: `fix/database-backups`, a T3 Code thread with an instruction in hand. */
function seedBackups(fx: GitFixture): ReviewState {
  const branch = "fix/database-backups";
  const tip = fx.branches[branch] ?? "";
  const by = { branch, agent: T3_AGENT };
  const state = blank();
  state.versions = [
    {
      number: 1,
      tipOid: tip,
      previousOid: null,
      forced: false,
      rebased: false,
      pusher: person("priya"),
      pusherKind: "api-key",
      agent: T3_AGENT,
      createdAt: hoursAgo(52),
    },
  ];
  state.reviewed = 1;
  state.agent = {
    kind: "t3",
    displayName: "Aurora backup retention",
    externalRefs: {
      threadId: "thr_backups",
      projectId: "prj_infra",
      url: "https://t3.priya.example/threads/thr_backups",
    },
    t3EnvironmentId: "t3env_workstation",
    connectedBy: person("priya"),
    createdAt: hoursAgo(53),
    updatedAt: hoursAgo(0.2),
  };
  state.traces = [
    entry(
      "ask",
      1,
      52.5,
      "Keep two weeks of database backups by default, and refuse a value Aurora would.",
      by,
    ),
    entry("step", 1, 52.3, "`backup_retention_days` defaults to 14, validated between 1 and 35.", {
      ...by,
      anchors: [{ path: "modules/database/variables.tf" }],
    }),
    entry("step", null, 0.15, "Reading how production sets the retention today.", by),
    entry("evidence", null, 0.1, "Production does not set it, so it would move from 7 to 14.", {
      ...by,
      evidence: {
        command: "grep -rn backup_retention environments/",
        exitCode: 1,
        output: "",
      },
    }),
  ];
  state.instructions = [
    {
      id: newId("ins"),
      source: "text",
      reviewCommentId: null,
      findingId: null,
      body: "Set the retention for production explicitly, so the default changing is not what changes it.",
      createdBy: person("mara"),
      status: "delivered",
      deliveredVia: "t3",
      deliveredAt: hoursAgo(0.2),
      answeredInVersion: null,
      answeredAt: null,
      dismissedBy: null,
      dismissedAt: null,
      createdAt: hoursAgo(0.25),
    },
  ];
  state.runs = [run(1, tip, 51.95, ["general", "security", "terraform"], 0)];
  return state;
}

/**
 * `acme/infra` #7: `feature/flow-logs`, merged with a merge commit six weeks
 * ago. Two versions, both pruned thirteen days ago, a trace, and findings
 * from a reviewer outside the forge in every state a merge can leave one.
 */
function seedFlowLogs(fx: GitFixture): ReviewState {
  const branch = "feature/flow-logs";
  const [v1, v2] = [oidOf(fx, "142a748"), oidOf(fx, "23b5b1e")];
  const by = { branch, agent: CLAUDE_CODE };
  const pruned = hoursAgo(24 * 13);
  const version = (number: number, tipOid: string, previousOid: string | null, hours: number) => ({
    number,
    tipOid,
    previousOid,
    forced: false,
    rebased: false,
    pusher: person("jonas"),
    pusherKind: "api-key",
    agent: CLAUDE_CODE,
    createdAt: hoursAgo(hours),
    prunedAt: pruned,
  });
  const state = blank();
  state.versions = [version(1, v1, null, 24 * 43.7), version(2, v2, v1, 24 * 43.4)];
  state.reviewed = 2;
  state.traces = [
    entry(
      "ask",
      1,
      24 * 43.8,
      "Let an environment send its VPC flow logs to a bucket, off unless it names one. Turn it on for staging.",
      by,
    ),
    entry("step", 1, 24 * 43.75, "`flow_logs_bucket_arn` on the network module, null by default.", {
      ...by,
      anchors: [{ path: "modules/network/variables.tf", startLine: 29, endLine: 33 }],
    }),
    entry(
      "decision",
      1,
      24 * 43.72,
      "One `aws_flow_log` with a count, not a module of its own: there is nothing else to configure.",
      { ...by, anchors: [{ path: "modules/network/main.tf", startLine: 97, endLine: 106 }] },
    ),
    entry("evidence", 2, 24 * 43.45, "Staging plans one flow log and nothing else.", {
      ...by,
      evidence: {
        command: "terraform -chdir=environments/staging plan",
        exitCode: 0,
        output: "Plan: 1 to add, 0 to change, 0 to destroy.",
      },
    }),
  ];
  const kept = finding(
    {
      reviewerKind: OUTSIDE_REVIEWER,
      severity: "must_fix",
      title: "The bucket's ARN is written out",
      body: "Nothing here creates `acme-staging-flow-logs` or checks that it exists. An apply against an account without it fails after the VPC has changed.",
      version: 2,
      lastSeenVersion: 2,
      path: "environments/staging/main.tf",
      startLine: 27,
      endLine: 27,
      evidence: [
        { kind: "code", text: '  flow_logs_bucket_arn = "arn:aws:s3:::acme-staging-flow-logs"' },
      ],
    },
    v2,
    24 * 43.38,
  );
  state.findings = [
    kept,
    finding(
      {
        reviewerKind: OUTSIDE_REVIEWER,
        severity: "must_fix",
        title: "No environment turns flow logs on",
        body: "The variable defaults to null and no root sets it, so the change plans nothing anywhere.",
        version: 1,
        lastSeenVersion: 1,
        status: "fixed",
        fixedInVersion: 2,
      },
      v1,
      24 * 43.68,
    ),
    finding(
      {
        reviewerKind: OUTSIDE_REVIEWER,
        severity: "should_fix",
        title: "Accepted traffic is logged too",
        body: '`traffic_type = "ALL"` records every accepted flow. `REJECT` alone is a tenth of the volume and is what the issue asks about.',
        version: 1,
        lastSeenVersion: 1,
        path: "modules/network/main.tf",
        startLine: 101,
        endLine: 101,
        status: "dismissed",
        dismissedBy: person("mara"),
        dismissedAt: hoursAgo(24 * 43.2),
        dismissalReason: "The audit wants accepted flows as well",
      },
      v1,
      24 * 43.68,
    ),
    finding(
      {
        reviewerKind: OUTSIDE_REVIEWER,
        severity: "note",
        title: "The flow log has no Name tag",
        body: "Every other resource in the module merges a `Name` into `var.tags`.",
        version: 1,
        lastSeenVersion: 2,
        path: "modules/network/main.tf",
        startLine: 105,
        endLine: 105,
      },
      v2,
      24 * 43.68,
    ),
  ];
  state.overrides = [
    {
      id: newId("override"),
      by: person("mara"),
      reason: "The bucket is created by the audit account's root, which is applied first",
      findingIds: [kept.id],
      headOid: v2,
      createdAt: hoursAgo(24 * 43.05),
    },
  ];
  const reported = run(2, v2, 24 * 43.39, [OUTSIDE_REVIEWER], 2);
  state.runs = [{ ...reported, trigger: "manual", model: null }];
  return state;
}

/**
 * `acme/edge-router` #4: `feature/health-checks`. The repository's review
 * agents are off; a reviewer that runs in CI reported these all the same.
 * Its one version is the branch's head, recorded when the page is read.
 */
function seedHealthChecks(fx: GitFixture): ReviewState {
  const tip = fx.branches["feature/health-checks"] ?? "";
  const state = blank();
  state.findings = [
    finding(
      {
        reviewerKind: OUTSIDE_REVIEWER,
        severity: "must_fix",
        title: "Nothing asks whether an upstream is healthy",
        body: "`src/router.ts` never imports `src/health.ts`, so a failing upstream keeps its share of requests.",
        version: 1,
      },
      tip,
      27.5,
    ),
    finding(
      {
        reviewerKind: OUTSIDE_REVIEWER,
        severity: "should_fix",
        title: "The failing set lives in one isolate",
        body: "Each isolate marks and forgets upstreams on its own, so two requests a second apart can disagree.",
        version: 1,
        path: "src/health.ts",
        startLine: 1,
        endLine: 1,
        evidence: [{ kind: "code", text: "const failing = new Set<string>();" }],
      },
      tip,
      27.5,
    ),
    finding(
      {
        reviewerKind: OUTSIDE_REVIEWER,
        severity: "note",
        title: "One failure is enough to leave an upstream out",
        body: "The issue asks for two failed checks in a row.",
        version: 1,
        path: "src/health.ts",
        startLine: 3,
        endLine: 5,
      },
      tip,
      27.5,
    ),
  ];
  return state;
}

function seedFor(repo: RepositoryRecord, number: number): ReviewState | null {
  const name = `${repo.owner.slug}/${repo.name}`;
  if (name === "acme/edge-router" && number === 4) return seedHealthChecks(gitOf(repo));
  if (name !== "acme/infra") return null;
  if (number === 7) return seedFlowLogs(gitOf(repo));
  if (number === 12) return seedPeering(gitOf(repo), repo);
  if (number === 14) return seedBackups(gitOf(repo));
  return null;
}

/** A branch page's review state when it has any: the seeded ones, and any a page has opened. */
export function peekReview(repo: RepositoryRecord, number: number): ReviewState | null {
  const key = keyOf(repo, number);
  const known = states.get(key);
  if (known) return known;
  const seeded = seedFor(repo, number);
  if (seeded) states.set(key, seeded);
  return seeded;
}

export function reviewOf(repo: RepositoryRecord, number: number): ReviewState {
  const known = peekReview(repo, number);
  if (known) return known;
  const made = blank();
  states.set(keyOf(repo, number), made);
  return made;
}

/**
 * Records a version when the branch is somewhere its newest version is not,
 * the way the queue consumer catches up from the repository.
 */
export function syncVersions(
  state: ReviewState,
  head: { oid: string; at: string; pusher: UserRef | null; agent?: AgentIdentity | null },
): StoredVersion | null {
  const last = state.versions[state.versions.length - 1];
  if (head.oid === "" || last?.tipOid === head.oid) return null;
  const made: StoredVersion = {
    number: (last?.number ?? 0) + 1,
    tipOid: head.oid,
    previousOid: last?.tipOid ?? null,
    forced: false,
    rebased: false,
    pusher: head.pusher,
    pusherKind: head.agent ? "api-key" : "user",
    agent: head.agent ?? null,
    createdAt: head.at,
  };
  state.versions.push(made);
  for (const item of state.traces) if (item.version === null) item.version = made.number;
  return made;
}

export const isOverridden = (state: ReviewState, id: string): boolean =>
  state.overrides.some((override) => override.findingIds.includes(id));

export function tallyOf(state: ReviewState): FindingsTally {
  const open = state.findings.filter((item) => item.status === "open");
  const sent = new Set(
    state.instructions.filter((item) => item.status !== "dismissed").map((item) => item.findingId),
  );
  return {
    found: state.findings.length,
    open: open.length,
    fixed: state.findings.filter((item) => item.status === "fixed").length,
    dismissed: state.findings.filter((item) => item.status === "dismissed").length,
    mustFixOpen: open.filter(
      (item) => item.severity === "must_fix" && !isOverridden(state, item.id),
    ).length,
    needsPerson: open.filter((item) => !sent.has(item.id)).length,
  };
}

export function presentFinding(
  repo: RepositoryRecord,
  state: ReviewState,
  item: StoredFinding,
): ReviewFinding {
  const { fix: _fix, ...rest } = item;
  const access = accessTo(repo);
  return {
    ...rest,
    overridden: isOverridden(state, item.id),
    viewerCanDismiss: currentUser() !== null && (access === "write" || access === "admin"),
  };
}

// --- Settings and the viewer's T3 Code environments ------------------------

const settings = new Map<string, Mutable<Omit<ReviewSettings, "availableReviewerKinds">>>();

export function reviewSettingsOf(repo: RepositoryRecord) {
  let found = settings.get(repo.id);
  if (!found) {
    found = {
      reviewAgentsEnabled: `${repo.owner.slug}/${repo.name}` === "acme/infra",
      reviewerKinds: ["general", "security", "terraform", "intent"],
      mustFixBlocksMerge: true,
    };
    settings.set(repo.id, found);
  }
  return found;
}

export const presentSettings = (repo: RepositoryRecord): ReviewSettings => ({
  ...reviewSettingsOf(repo),
  availableReviewerKinds: [...REVIEWER_KINDS],
});

/**
 * What a merge is held on, for `mergeabilityOf`. Null for a branch page
 * nothing has been found on, whose mergeability then reads as it always did.
 */
export function findingsGate(
  repo: RepositoryRecord,
  number: number,
): { mustFixOpen: number; blocks: boolean } | null {
  const state = peekReview(repo, number);
  if (state === null || state.findings.length === 0) return null;
  return {
    mustFixOpen: tallyOf(state).mustFixOpen,
    blocks: reviewSettingsOf(repo).mustFixBlocksMerge,
  };
}
