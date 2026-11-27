/**
 * What a reviewer can do: read the version it is reviewing, and write
 * findings. Nothing else. There is no tool that approves, merges, comments,
 * pushes or reaches the network, so a change that talks the model into
 * something has nothing to do it with.
 *
 * Every tool answers text. A refusal is text too (`is_error`), so the model
 * can correct itself. Answers are bounded (`toolResultChars`) and say so
 * when they were cut, never silently.
 *
 * **A fork's proposed branch reads less.** Its code is anyone's, and what the
 * model reads it can be talked into repeating in a finding, which the fork's
 * author reads. So a fork's review gets no CI log and no Terraform plan of
 * the base repository: only the names and states of its checks.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { Diff, ReviewerKind } from "@infrawrench/git-contract";
import type { GitFindingSeverity } from "@infrawrench/server-core/db/schema";
import { getCiRun, listTerraformRuns, listWorkspaces } from "../db/automation";
import {
  type FindingOutcome,
  type FindingRow,
  confirmFinding,
  listFindings,
  markFindingsFixed,
  traceEntriesOfVersion,
} from "../db/findings";
import { statusesForCommit } from "../db/policy";
import type { PullRequestWithThread } from "../db/pulls";
import { type RepositoryWithOwner, runsInOrganization } from "../db/repositories";
import type { VersionRow } from "../db/review";
import { type RepoReader, RepoReaderError } from "../repo/reader";
import { fingerprintOf, recordFindings } from "./findings";
import { maskSecrets } from "./masking";
import type { ReviewLimits } from "./policy";

/** A CI run's jobs, as much of them as an excerpt needs. Null when the run's output cannot be read. */
export type CiJobsReader = (
  organizationId: string,
  runId: string,
) => Promise<ReadonlyArray<{
  readonly name: string;
  readonly status: string;
  readonly reason?: string | null | undefined;
  readonly stdout: string;
  readonly stderr: string;
}> | null>;

/** The app's CI, which reaches most of server-core: loaded when a log is first asked for. */
export const appCiJobs: CiJobsReader = async (organizationId, runId) =>
  (await (await import("@infrawrench/server-core/ci/runs")).getRun(organizationId, runId)).jobs;

export interface ReviewerContext {
  readonly kind: ReviewerKind;
  /** The repository the branch page is in. */
  readonly base: RepositoryWithOwner;
  readonly found: PullRequestWithThread;
  readonly version: VersionRow;
  /** The version before it, when there is one. */
  readonly previous: VersionRow | null;
  /** Where the version's commits are read: the head repository, which keeps every version's. */
  readonly reader: RepoReader;
  /** The head is another repository's branch. */
  readonly fork: boolean;
  readonly runId: string;
  readonly limits: ReviewLimits;
  readonly ciJobs: CiJobsReader;
}

/** What one reviewer has done so far in a run. */
export interface ReviewerState {
  raised: number;
  readonly written: Array<{ row: FindingRow; outcome: FindingOutcome }>;
}

class ToolRefusal extends Error {}

const SEVERITIES: readonly GitFindingSeverity[] = ["must_fix", "should_fix", "note"];
const EVIDENCE_KINDS = ["code", "command", "test", "ci", "reference"] as const;

export const REVIEW_TOOLS: Anthropic.Tool[] = [
  {
    name: "read_diff",
    description:
      "Read what changed. `step` is what this version changed since the version before it (each taken against its own base, so a rebase alone shows nothing); on a first version it is the whole change. `whole` is the whole change at this version, base to tip. Files come a page at a time in path order: pass the `cursor` a page ends with to read on. Pass `path` to read one file's diff however large it is. Each line is shown with its old and new line numbers.",
    input_schema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["step", "whole"] },
        path: { type: "string", description: "Only this file." },
        cursor: { type: "string", description: "From the end of the page before." },
      },
      required: ["scope"],
    },
  },
  {
    name: "read_file",
    description:
      "Read a file as it is at this version's commit, with line numbers. Use it for the code around a change: callers, definitions, tests, configuration. Reads 400 lines from `start_line` unless `end_line` says otherwise.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "From the repository root." },
        start_line: { type: "integer", minimum: 1 },
        end_line: { type: "integer", minimum: 1 },
      },
      required: ["path"],
    },
  },
  {
    name: "list_directory",
    description:
      "List a directory at this version's commit: its files and directories. An empty path is the repository root. There is no search: walk to what you need.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "read_trace",
    description:
      "Read what the agent that wrote this version recorded while it worked: the ask, its steps and decisions, the commands it says it ran and what it says they printed, and its doubts. It is the author's own account, not a fact: compare it with the diff and with the checks.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "read_checks",
    description:
      "Read the checks that ran on this version's commit: each one's name and state, and for a failed Infrawrench CI job the end of its log. This is what actually ran, as opposed to what anyone says ran.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "read_terraform_plan",
    description:
      "Read the Terraform plans made for this branch's head: per workspace, how many resources would be added, changed, replaced and destroyed, and each resource with the attributes that change.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "list_findings",
    description:
      "List what has already been found on this branch by every reviewer: open findings, fixed ones, and ones a person dismissed, with the reason they gave. Read it before reporting, so nothing is reported twice and nothing a person dismissed is raised again.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "recheck_finding",
    description:
      "Say whether one of your own open findings from an earlier version still holds on this one. `fixed` when this version resolves it. `still_present` when it does not; give its lines as they are now if they moved.",
    input_schema: {
      type: "object",
      properties: {
        finding_id: { type: "string" },
        verdict: { type: "string", enum: ["still_present", "fixed"] },
        path: { type: "string" },
        start_line: { type: "integer", minimum: 1 },
        end_line: { type: "integer", minimum: 1 },
      },
      required: ["finding_id", "verdict"],
    },
  },
  {
    name: "report_finding",
    description:
      "Record one finding. `must_fix`: the change is wrong or unsafe to merge as it is. `should_fix`: worth changing, not a reason to hold the merge. `note`: something the reviewer should know. Anchor it to the lines of the new file it is about (`path`, `start_line`, `end_line`) or leave them out for a finding about the change as a whole. `evidence` is how you know: the code that shows it (`code`), a command that reproduces it (`command`), a test (`test`), a failing check and its log line (`ci`), or a document (`reference`). A `must_fix` needs evidence. A finding without evidence is shown to people folded, as a question.",
    input_schema: {
      type: "object",
      properties: {
        severity: { type: "string", enum: [...SEVERITIES] },
        title: { type: "string", description: "One line that says what is wrong." },
        body: {
          type: "string",
          description: "Markdown: what is wrong, why it matters, what would fix it.",
        },
        path: { type: "string" },
        start_line: { type: "integer", minimum: 1 },
        end_line: { type: "integer", minimum: 1 },
        side: {
          type: "string",
          enum: ["LEFT", "RIGHT"],
          description: "`LEFT` only for lines this change removes.",
        },
        needs_code: {
          type: "boolean",
          description:
            "Set true only when a reader has to see the code at `path` and its lines to understand this finding (it then shows those lines beside the text). Leave false for a finding that stands on its own. Defaults to true when a line is given, false otherwise.",
        },
        evidence: {
          type: "array",
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: [...EVIDENCE_KINDS] },
              text: { type: "string" },
              url: { type: "string" },
            },
            required: ["kind", "text"],
          },
        },
      },
      required: ["severity", "title", "body"],
    },
  },
];

// ---------------------------------------------------------------------------
// Reading inputs. A model's tool input is unvalidated JSON.
// ---------------------------------------------------------------------------

type Input = Record<string, unknown>;

const text = (input: Input, key: string): string | undefined => {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ToolRefusal(`\`${key}\` must be a string`);
  return value;
};

const requiredText = (input: Input, key: string): string => {
  const value = text(input, key);
  if (value === undefined || value.trim() === "") throw new ToolRefusal(`\`${key}\` is needed`);
  return value;
};

const line = (input: Input, key: string): number | undefined => {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ToolRefusal(`\`${key}\` must be a line number, 1 or more`);
  }
  return value;
};

const flag = (input: Input, key: string): boolean | undefined => {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new ToolRefusal(`\`${key}\` must be true or false`);
  return value;
};

const oneOf = <T extends string>(input: Input, key: string, values: readonly T[]): T => {
  const value = input[key];
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
    throw new ToolRefusal(`\`${key}\` must be one of ${values.join(", ")}`);
  }
  return value as T;
};

/** A path as the storage names it: no leading slash, no way out of the tree. */
const cleanPath = (path: string): string => {
  const cleaned = path.replace(/^\.?\/+/, "").replace(/\/+$/, "");
  if (cleaned.split("/").includes("..")) throw new ToolRefusal("A path cannot contain `..`");
  return cleaned;
};

const bounded = (value: string, limit: number): string =>
  value.length > limit
    ? `${value.slice(0, limit)}\n[cut here: ${value.length - limit} more characters. Ask for less at a time.]`
    : value;

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

const number = (value: number | null): string => (value === null ? "" : String(value)).padStart(5);

/** A page of a diff as text, each line with its old and new numbers. */
export const renderDiff = (diff: Diff): string => {
  const out: string[] = [
    `${diff.stats.filesChanged} files changed, +${diff.stats.additions} -${diff.stats.deletions} in the whole diff.`,
  ];
  for (const file of diff.files) {
    const from = file.oldPath && file.oldPath !== file.path ? ` (was ${file.oldPath})` : "";
    out.push("", `=== ${file.path}${from}: ${file.status}, +${file.additions} -${file.deletions}`);
    if (file.binary) out.push("(binary)");
    else if (file.tooLarge) out.push("(left out for its size: ask for this file with `path`)");
    for (const hunk of file.hunks) {
      out.push(
        `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@ ${hunk.section}`,
      );
      for (const changed of hunk.lines) {
        const sign = changed.type === "add" ? "+" : changed.type === "delete" ? "-" : " ";
        out.push(
          `${number(changed.oldLine)} ${number(changed.newLine)} ${sign} ${changed.content}`,
        );
      }
    }
  }
  if (diff.files.length === 0) out.push("", "No files on this page.");
  if (diff.nextCursor !== null) {
    out.push("", `More files follow: call read_diff again with cursor "${diff.nextCursor}".`);
  }
  return out.join("\n");
};

const readDiff = async (cx: ReviewerContext, input: Input): Promise<string> => {
  const scope = oneOf(input, "scope", ["step", "whole"] as const);
  const path = text(input, "path");
  const side = (version: VersionRow) => ({ tipOid: version.tipOid, baseOid: version.baseOid });
  const from = scope === "step" && cx.previous ? side(cx.previous) : null;
  const answer = await cx.reader.versionDiff(
    { from, to: side(cx.version) },
    {
      cursor: text(input, "cursor"),
      limit: 20,
      path: path === undefined ? undefined : cleanPath(path),
      context: 3,
    },
  );
  const head = from
    ? `What version ${cx.version.number} changed since version ${cx.previous!.number}.${
        answer.exact
          ? ""
          : " The older version did not apply cleanly to the new base, so this also shows what the rebase brought."
      }`
    : `The whole change at version ${cx.version.number}, base to tip.`;
  return `${head}\n${renderDiff(answer.diff)}`;
};

const readFile = async (cx: ReviewerContext, input: Input): Promise<string> => {
  const path = cleanPath(requiredText(input, "path"));
  const blob = await cx.reader.blob({ ref: cx.version.tipOid, path, lastCommit: false });
  if (blob.binary) return `${path} is a binary file of ${blob.size} bytes.`;
  if (blob.text === null || blob.text === undefined) {
    return `${path} is ${blob.size} bytes, too large to read here.`;
  }
  const lines = blob.text.split("\n");
  const start = line(input, "start_line") ?? 1;
  const end = Math.min(line(input, "end_line") ?? start + 399, lines.length);
  if (start > lines.length) return `${path} has ${lines.length} lines.`;
  const shown = lines.slice(start - 1, end).map((content, index) => `${start + index}\t${content}`);
  const more =
    end < lines.length || blob.truncated
      ? `\n[lines ${start} to ${end} of ${blob.truncated ? "more than " : ""}${lines.length}]`
      : "";
  return `${path} at ${cx.version.tipOid.slice(0, 12)}\n${shown.join("\n")}${more}`;
};

const listDirectory = async (cx: ReviewerContext, input: Input): Promise<string> => {
  const path = cleanPath(text(input, "path") ?? "");
  const listing = await cx.reader.tree({ ref: cx.version.tipOid, path, lastCommits: false });
  const entries = listing.entries.map((entry) =>
    entry.type === "tree"
      ? `${entry.name}/`
      : `${entry.name}${entry.size === null ? "" : ` (${entry.size} bytes)`}`,
  );
  return [
    `${path === "" ? "The repository root" : path}:`,
    ...entries,
    ...(listing.truncated ? ["[more entries than are listed]"] : []),
  ].join("\n");
};

const readTrace = async (cx: ReviewerContext): Promise<string> => {
  const entries = await traceEntriesOfVersion(cx.version.id, 200);
  if (entries.length === 0) return "No trace was recorded for this version.";
  return entries
    .map((entry) => {
      const parts = [`[${entry.kind}] ${entry.body}`];
      for (const anchor of entry.anchors) {
        parts.push(`  about ${anchor.path}${anchor.startLine ? `:${anchor.startLine}` : ""}`);
      }
      const evidence = entry.evidence;
      if (evidence) {
        if (evidence.command) parts.push(`  says it ran: ${evidence.command}`);
        if (evidence.exitCode != null) parts.push(`  says it exited: ${evidence.exitCode}`);
        if (evidence.ciRunId) parts.push(`  names CI run ${evidence.ciRunId}`);
        if (evidence.output) parts.push(`  says it printed:\n${bounded(evidence.output, 2000)}`);
      }
      return parts.join("\n");
    })
    .join("\n\n");
};

const tail = (value: string, limit: number): string =>
  value.length > limit ? `[the end of ${value.length} characters]\n${value.slice(-limit)}` : value;

const PASSING = new Set(["passed", "success", "skipped", "cancelled"]);

const readChecks = async (cx: ReviewerContext): Promise<string> => {
  const { pull } = cx.found;
  const statuses = await statusesForCommit(pull.repositoryId, cx.version.tipOid);
  if (statuses.length === 0) return "No check has reported on this version's commit.";
  const out = statuses.map(
    (status) =>
      `${status.context}: ${status.state}${status.description ? ` (${maskSecrets(status.description)})` : ""}`,
  );
  if (cx.fork) {
    out.push("", "This branch is from a fork: check logs are not read here.");
    return out.join("\n");
  }
  const organizationId = runsInOrganization(cx.base.owner);
  const failed = statuses.filter(
    (status) => (status.state === "failure" || status.state === "error") && status.ciRunId,
  );
  const seen = new Set<string>();
  for (const status of failed.slice(0, 4)) {
    const runId = status.ciRunId!;
    if (organizationId === null || seen.has(runId)) continue;
    seen.add(runId);
    const run = await getCiRun(pull.repositoryId, organizationId, runId);
    // A Terraform run prints a plan's attribute values: its output takes `write`, a finding only `read`.
    if (!run || run.terraformRunId !== null) continue;
    let jobs: Awaited<ReturnType<CiJobsReader>> = null;
    try {
      jobs = await cx.ciJobs(organizationId, runId);
    } catch {
      jobs = null;
    }
    if (!jobs) {
      out.push("", `The log of ${status.context} could not be read.`);
      continue;
    }
    for (const job of jobs.filter((candidate) => !PASSING.has(candidate.status)).slice(0, 4)) {
      const log = maskSecrets(tail([job.stdout, job.stderr].filter(Boolean).join("\n"), 4000));
      out.push(
        "",
        `--- job ${job.name}: ${job.status}${job.reason ? ` (${job.reason})` : ""}`,
        log === "" ? "(no output)" : log,
      );
    }
  }
  return out.join("\n");
};

const readTerraformPlan = async (cx: ReviewerContext): Promise<string> => {
  const { pull, thread } = cx.found;
  if (cx.fork) return "This branch is from a fork: no Terraform plan is made or read for it.";
  const [page, workspaces] = await Promise.all([
    listTerraformRuns(pull.repositoryId, { pull: thread.number, kind: "plan", limit: 50 }),
    listWorkspaces(pull.repositoryId),
  ]);
  const nameOf = new Map(workspaces.map((workspace) => [workspace.id, workspace.name]));
  // Newest first: the first seen of each workspace is its newest plan.
  const newest = new Map<string, (typeof page.items)[number]>();
  for (const run of page.items) if (!newest.has(run.workspaceId)) newest.set(run.workspaceId, run);
  if (newest.size === 0) return "No Terraform plan has been made for this branch.";
  const out: string[] = [];
  for (const run of newest.values()) {
    const stale = run.commitSha === cx.version.tipOid ? "" : " (of an older commit)";
    out.push(`Workspace ${nameOf.get(run.workspaceId) ?? run.workspaceId}: ${run.status}${stale}`);
    const plan = run.planSummary as {
      resources?: ReadonlyArray<{
        address: string;
        action: string;
        attributes?: ReadonlyArray<{ name: string }>;
        replacePaths?: readonly string[];
      }>;
      resourcesOmitted?: number;
    } | null;
    if (run.error) out.push(`  failed: ${maskSecrets(run.error)}`);
    const resources = plan?.resources;
    if (!plan || !resources) {
      out.push("  no plan to read yet", "");
      continue;
    }
    out.push(
      `  ${run.resourcesToAdd ?? 0} to add, ${run.resourcesToChange ?? 0} to change, ${run.resourcesToDestroy ?? 0} to destroy`,
    );
    for (const resource of resources.slice(0, 200)) {
      const attributes = (resource.attributes ?? []).map((attribute) => attribute.name);
      const forced = resource.replacePaths ?? [];
      out.push(
        `  ${resource.action} ${resource.address}${attributes.length > 0 ? `: ${attributes.join(", ")}` : ""}${forced.length > 0 ? ` (replaced because of ${forced.join(", ")})` : ""}`,
      );
    }
    const omitted = (plan.resourcesOmitted ?? 0) + Math.max(0, resources.length - 200);
    if (omitted > 0) out.push(`  and ${omitted} more`);
    out.push("");
  }
  return out.join("\n").trimEnd();
};

const where = (finding: FindingRow): string =>
  finding.path === null
    ? "the change as a whole"
    : `${finding.path}${finding.startLine === null ? "" : `:${finding.startLine}`}`;

const listKnownFindings = async (cx: ReviewerContext): Promise<string> => {
  const findings = await listFindings(cx.found.pull.issueId);
  if (findings.length === 0) return "Nothing has been found on this branch yet.";
  return findings
    .map((finding) => {
      const own = finding.reviewerKind === cx.kind;
      const state =
        finding.status === "dismissed"
          ? `dismissed by a person: ${finding.dismissalReason ?? "no reason given"}`
          : finding.status === "fixed"
            ? `fixed in version ${finding.fixedInVersionNumber}`
            : `open since version ${finding.versionNumber}, last seen on version ${finding.lastSeenVersionNumber}`;
      return [
        `${finding.id} [${finding.reviewerKind}${own ? ", yours" : ""}] ${finding.severity}: ${finding.title}`,
        `  at ${where(finding)}; ${state}`,
        ...(own && finding.status === "open" && finding.body !== ""
          ? [`  ${bounded(finding.body, 600).replace(/\n/g, "\n  ")}`]
          : []),
      ].join("\n");
    })
    .join("\n");
};

const recheckFinding = async (cx: ReviewerContext, input: Input): Promise<string> => {
  const id = requiredText(input, "finding_id");
  const verdict = oneOf(input, "verdict", ["still_present", "fixed"] as const);
  const [finding] = (await listFindings(cx.found.pull.issueId, { reviewerKind: cx.kind })).filter(
    (candidate) => candidate.id === id,
  );
  if (!finding) throw new ToolRefusal("That is not one of your findings on this branch");
  if (finding.status !== "open") return `That finding is ${finding.status}: nothing to recheck.`;
  if (verdict === "fixed") {
    const fixed = await markFindingsFixed([finding.id], cx.version.number);
    return fixed.length > 0
      ? `Marked fixed in version ${cx.version.number}.`
      : "It was raised or seen on this version, so it is not marked fixed.";
  }
  const path = text(input, "path");
  const startLine = line(input, "start_line");
  const endLine = line(input, "end_line");
  await confirmFinding(
    finding.id,
    cx.version,
    path === undefined && startLine === undefined
      ? null
      : {
          path: path === undefined ? finding.path : cleanPath(path),
          startLine: startLine ?? endLine ?? null,
          endLine: endLine ?? startLine ?? null,
        },
  );
  return `Still open, now seen on version ${cx.version.number}.`;
};

const reportFinding = async (
  cx: ReviewerContext,
  state: ReviewerState,
  input: Input,
): Promise<string> => {
  if (state.raised >= cx.limits.maxFindingsPerReviewer) {
    throw new ToolRefusal(
      `You have recorded ${state.raised} findings, which is the most one review records. Stop here.`,
    );
  }
  const severity = oneOf(input, "severity", SEVERITIES);
  const title = requiredText(input, "title");
  const rawPath = text(input, "path");
  const path = rawPath === undefined || rawPath.trim() === "" ? null : cleanPath(rawPath);
  const evidence = Array.isArray(input["evidence"])
    ? (input["evidence"] as unknown[]).map((item) => {
        if (typeof item !== "object" || item === null) {
          throw new ToolRefusal("Each piece of `evidence` is an object with `kind` and `text`");
        }
        const piece = item as Input;
        return {
          kind: oneOf(piece, "kind", EVIDENCE_KINDS),
          text: requiredText(piece, "text"),
          url: text(piece, "url") ?? null,
        };
      })
    : [];
  if (severity === "must_fix" && evidence.length === 0) {
    throw new ToolRefusal(
      "A must_fix finding needs evidence: the code, the command or the failing check that shows it. Add it, or record this as should_fix or note.",
    );
  }
  const side = input["side"] === undefined ? undefined : oneOf(input, "side", ["LEFT", "RIGHT"]);
  const [written] = await recordFindings(
    {
      repositoryId: cx.found.pull.repositoryId,
      pullRequestId: cx.found.pull.issueId,
      version: cx.version,
      runId: cx.runId,
    },
    cx.kind,
    [
      {
        severity,
        title,
        body: text(input, "body") ?? "",
        path,
        side,
        startLine: line(input, "start_line"),
        endLine: line(input, "end_line"),
        needsCode: flag(input, "needs_code"),
        evidence,
        fingerprint: await fingerprintOf(cx.kind, path, title),
      },
    ],
  );
  const { row, outcome } = written!;
  if (outcome === "dismissed") {
    return `A person dismissed this finding (${row.dismissalReason ?? "no reason given"}). It stays dismissed and is not raised again.`;
  }
  state.raised++;
  state.written.push({ row, outcome });
  return outcome === "raised"
    ? `Recorded as ${row.id}.`
    : outcome === "reopened"
      ? `This was marked fixed before and is open again as ${row.id}.`
      : `Already known as ${row.id}: updated, and seen on version ${cx.version.number}.`;
};

/**
 * Run one tool call. Answers the text for its `tool_result` and whether it is
 * a refusal. The storage refusing (no such path, not a file) is the model's
 * to read and work around; anything else thrown is ours and goes up.
 */
export const runTool = async (
  cx: ReviewerContext,
  state: ReviewerState,
  name: string,
  input: unknown,
): Promise<{ readonly content: string; readonly isError: boolean }> => {
  const args: Input =
    typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Input) : {};
  try {
    const content = await (async () => {
      switch (name) {
        case "read_diff":
          return readDiff(cx, args);
        case "read_file":
          return readFile(cx, args);
        case "list_directory":
          return listDirectory(cx, args);
        case "read_trace":
          return readTrace(cx);
        case "read_checks":
          return readChecks(cx);
        case "read_terraform_plan":
          return readTerraformPlan(cx);
        case "list_findings":
          return listKnownFindings(cx);
        case "recheck_finding":
          return recheckFinding(cx, args);
        case "report_finding":
          return reportFinding(cx, state, args);
        default:
          throw new ToolRefusal(`There is no tool called ${name}`);
      }
    })();
    return { content: bounded(content, cx.limits.toolResultChars), isError: false };
  } catch (error) {
    if (error instanceof ToolRefusal) return { content: error.message, isError: true };
    if (error instanceof RepoReaderError) {
      const said: Partial<Record<RepoReaderError["code"], string>> = {
        path_not_found: "There is no such path at this version",
        not_a_file: "That path is a directory",
        not_a_directory: "That path is a file",
        ref_not_found: "That commit cannot be read",
        too_large: "That is too large to read",
        unavailable: "The repository's contents cannot be read right now",
      };
      return { content: said[error.code] ?? "The repository refused that", isError: true };
    }
    throw error;
  }
};
