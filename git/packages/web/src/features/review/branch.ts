/**
 * What the branch page works out from the API's answers and nothing else:
 * the line that says what a branch needs now, which diff a mode asks for,
 * the notice an inexact diff carries, and where on a diff each trace entry
 * and finding goes.
 */
import type {
  BranchPageState,
  BranchVersionList,
  DiffFile,
  FindingSeverity,
  FindingsTally,
  Instruction,
  ReviewFinding,
  TraceEntry,
  VersionDiff,
} from "@infrawrench/git-contract";
import { CI_AGENT_KIND, ciReviewerJob } from "@infrawrench/git-contract";
import { plural } from "../../lib/format";

export type DiffMode = "whole" | "step" | "since";

export const DIFF_MODES: ReadonlyArray<{ value: DiffMode; label: string }> = [
  { value: "whole", label: "Whole change" },
  { value: "step", label: "This step" },
  { value: "since", label: "Since you last looked" },
];

/** The `from` of `versions.diff` for a mode. */
export const diffFrom = (mode: DiffMode): "base" | "previous" | "reviewed" =>
  mode === "whole" ? "base" : mode === "step" ? "previous" : "reviewed";

export const parseDiffMode = (value: unknown): DiffMode | undefined =>
  value === "whole" || value === "step" || value === "since" ? value : undefined;

/** A branch page's address query: the version and diff picked, and the tab (`commits`, `checks`). */
export function parseBranchSearch(search: Record<string, unknown>): {
  v: number | undefined;
  diff: DiffMode | undefined;
  tab: "commits" | "checks" | undefined;
} {
  const v = Number(search.v);
  return {
    v: Number.isInteger(v) && v > 0 ? v : undefined,
    diff: parseDiffMode(search.diff),
    tab: search.tab === "commits" || search.tab === "checks" ? search.tab : undefined,
  };
}

/**
 * What a branch opens on: its newest version, and what changed since the
 * reader last marked one as reviewed when there is anything newer.
 */
export function defaultSelection(list: Pick<BranchVersionList, "latest" | "viewerReviewed">): {
  version: number | null;
  mode: DiffMode;
} {
  const { latest, viewerReviewed } = list;
  return {
    version: latest,
    mode: latest !== null && viewerReviewed !== null && viewerReviewed < latest ? "since" : "whole",
  };
}

export type Tone = "success" | "warning" | "danger" | "neutral" | "notice";

/** One line on what the branch needs now. */
export function needsNow(state: BranchPageState): { tone: Tone; text: string } {
  switch (state.state) {
    case "merged":
      return { tone: "neutral", text: "Merged" };
    case "closed":
      return { tone: "neutral", text: "Closed without merging" };
    case "agent_working":
      return {
        tone: "notice",
        text:
          state.workingOnVersion === null
            ? "The agent is working"
            : `The agent is working on v${state.workingOnVersion}`,
      };
    case "checks_failing":
      return { tone: "danger", text: "Checks are failing" };
    case "must_fix_open":
      return {
        tone: "danger",
        text: `${plural(state.findings.mustFixOpen, "must-fix finding")} to settle`,
      };
    case "needs_your_review":
      return {
        tone: "warning",
        text:
          state.viewerReviewedVersion === null
            ? "Needs your review"
            : `${plural(state.unreviewedVersions, "version")} since you last looked`,
      };
    case "ready_to_merge":
      return { tone: "success", text: "Ready to merge" };
    default:
      return { tone: "neutral", text: "Nothing is waiting on you" };
  }
}

/**
 * Whether the branch page lists findings. The repository's setting only says
 * whether the forge's own agents run: a reviewer outside the forge (one in
 * CI, one on somebody's machine) reports all the same, so what was found, or
 * a run that looked, is shown whatever the setting says.
 */
export const showsFindings = (shown: {
  readonly agentsEnabled: boolean;
  readonly findings: number;
  readonly run: BranchPageState["reviewRun"];
}): boolean => shown.agentsEnabled || shown.findings > 0 || shown.run !== null;

/** While any of this holds, the page asks again every few seconds. */
export const isLive = (state: BranchPageState | undefined): boolean =>
  state !== undefined &&
  (state.state === "agent_working" ||
    state.openInstructions > 0 ||
    state.reviewRun === "queued" ||
    state.reviewRun === "running");

/**
 * What to say in place of a diff the server no longer has: a pruned
 * version's commits went thirty days after its branch was merged or deleted.
 */
export function prunedNotice(shown: {
  readonly version: number;
  readonly mode: DiffMode;
  readonly merged: boolean;
}): string {
  const what =
    shown.mode === "whole"
      ? `The change at v${shown.version} cannot be shown`
      : `What v${shown.version} changed since an earlier version cannot be shown`;
  return `${what}: its commits were removed 30 days after the branch was ${
    shown.merged ? "merged" : "deleted"
  }. What was recorded and found on it is kept.`;
}

/** What to say above a diff that is not simply one version against another. */
export function diffNotice(diff: Pick<VersionDiff, "kind" | "from" | "to" | "rebased" | "exact">) {
  if (diff.kind !== "interdiff" || diff.from === null) return null;
  if (!diff.exact) {
    return `v${diff.from} did not apply cleanly onto the base v${diff.to} was rebased to, so this compares the two as they were pushed and includes what the rebase brought in.`;
  }
  if (diff.rebased) {
    return `The branch was rebased between v${diff.from} and v${diff.to}. What the rebase brought in is left out.`;
  }
  return null;
}

export const SEVERITY_LABEL: Record<FindingSeverity, string> = {
  must_fix: "Must fix",
  should_fix: "Should fix",
  note: "Note",
};

const SEVERITY_RANK: Record<FindingSeverity, number> = { must_fix: 0, should_fix: 1, note: 2 };
const STATUS_RANK: Record<ReviewFinding["status"], number> = { open: 0, dismissed: 1, fixed: 2 };

/** Open before settled, the gravest first, then by where they are. */
export function sortFindings(findings: ReadonlyArray<ReviewFinding>): ReviewFinding[] {
  return [...findings].sort(
    (a, b) =>
      STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      (a.path ?? "").localeCompare(b.path ?? "") ||
      (a.startLine ?? 0) - (b.startLine ?? 0),
  );
}

/** `2 must fix, 1 should fix`: the open findings by severity. */
export function openBySeverity(findings: ReadonlyArray<ReviewFinding>): string {
  const count = (severity: FindingSeverity) =>
    findings.filter((item) => item.status === "open" && item.severity === severity).length;
  const parts = [
    [count("must_fix"), "must fix"],
    [count("should_fix"), "should fix"],
    [count("note"), count("note") === 1 ? "note" : "notes"],
  ] as const;
  return parts
    .filter(([n]) => n > 0)
    .map(([n, label]) => `${n} ${label}`)
    .join(", ");
}

/** The tally in a sentence, for the merge box. */
export function tallySentence(tally: FindingsTally): string {
  const parts = [
    tally.open > 0 ? `${tally.open} open` : null,
    tally.fixed > 0 ? `${tally.fixed} fixed` : null,
    tally.dismissed > 0 ? `${tally.dismissed} dismissed` : null,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? "Nothing found" : parts.join(", ");
}

/** A finding as it stood on a version: raised by then and not yet gone. */
export const seenOn = (finding: ReviewFinding, version: number): boolean =>
  finding.version <= version && finding.lastSeenVersion >= version;

export const lineKey = (path: string, side: "LEFT" | "RIGHT", line: number): string =>
  `${side}:${line}:${path}`;

export interface Placement {
  /** Trace entries above the line they start on, by `lineKey` (always the new side). */
  readonly traceAt: ReadonlyMap<string, ReadonlyArray<TraceEntry>>;
  /** Findings under the line they end on, by `lineKey`. */
  readonly findingAt: ReadonlyMap<string, ReadonlyArray<ReviewFinding>>;
  /** What belongs to a file of the diff, on lines the diff does not show. */
  readonly traceOfFile: ReadonlyMap<string, ReadonlyArray<TraceEntry>>;
  readonly findingOfFile: ReadonlyMap<string, ReadonlyArray<ReviewFinding>>;
  /** What is about the change as a whole, or a file this diff does not have. */
  readonly traces: ReadonlyArray<TraceEntry>;
  readonly findings: ReadonlyArray<ReviewFinding>;
}

const push = <T>(map: Map<string, T[]>, key: string, value: T): void => {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
};

/**
 * Where each trace entry and finding goes on a version's diff. An entry with
 * several anchors is shown at its first that the diff has.
 *
 * Lines are numbered in the version an entry was recorded for and the commit
 * a finding was seen on. On that very version they are placed on any line
 * the diff shows. On a later one the numbers may have moved, so they are
 * placed only on lines this diff adds, and otherwise named above the file.
 */
export function placeOnDiff(
  files: ReadonlyArray<DiffFile>,
  traces: ReadonlyArray<TraceEntry>,
  findings: ReadonlyArray<ReviewFinding>,
  options: {
    /** The diff's old side is the version's base: a finding on a removed line has a place. */
    readonly oldSide: boolean;
    /** The version shown, and its commit. */
    readonly version: number;
    readonly headOid: string;
  },
): Placement {
  const shown = new Map<string, { left: Set<number>; right: Set<number>; added: Set<number> }>();
  for (const file of files) {
    const left = new Set<number>();
    const right = new Set<number>();
    const added = new Set<number>();
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.type === "delete") {
          if (line.oldLine !== null) left.add(line.oldLine);
        } else if (line.newLine !== null) {
          right.add(line.newLine);
          if (line.type === "add") added.add(line.newLine);
        }
      }
    }
    shown.set(file.path, { left, right, added });
  }
  const traceAt = new Map<string, TraceEntry[]>();
  const findingAt = new Map<string, ReviewFinding[]>();
  const traceOfFile = new Map<string, TraceEntry[]>();
  const findingOfFile = new Map<string, ReviewFinding[]>();
  const looseTraces: TraceEntry[] = [];
  const looseFindings: ReviewFinding[] = [];

  for (const entry of traces) {
    const anchor = entry.anchors.find((item) => shown.has(item.path));
    if (anchor === undefined) {
      looseTraces.push(entry);
      continue;
    }
    const file = shown.get(anchor.path)!;
    const lines = entry.version === options.version ? file.right : file.added;
    const start = anchor.startLine ?? null;
    const end = anchor.endLine ?? start;
    // The first line of the range the diff shows: a hunk may start partway into it.
    let at: number | null = null;
    if (start !== null && end !== null) {
      for (let line = start; line <= end; line++) {
        if (lines.has(line)) {
          at = line;
          break;
        }
      }
    }
    if (at === null) push(traceOfFile, anchor.path, entry);
    else push(traceAt, lineKey(anchor.path, "RIGHT", at), entry);
  }

  for (const finding of findings) {
    const lines = finding.path === null ? undefined : shown.get(finding.path);
    if (finding.path === null || lines === undefined) {
      looseFindings.push(finding);
      continue;
    }
    const at = finding.endLine ?? finding.startLine;
    const exact = finding.commitOid === options.headOid;
    const side = finding.side === "LEFT" ? lines.left : exact ? lines.right : lines.added;
    if (at === null || !side.has(at) || (finding.side === "LEFT" && !(options.oldSide && exact))) {
      push(findingOfFile, finding.path, finding);
    } else push(findingAt, lineKey(finding.path, finding.side, at), finding);
  }
  return {
    traceAt,
    findingAt,
    traceOfFile,
    findingOfFile,
    traces: looseTraces,
    findings: looseFindings,
  };
}

/** `main.tf:101`, `main.tf:97-103`, or the path alone for a whole file. */
export function whereLabel(
  path: string,
  start: number | null | undefined,
  end: number | null | undefined,
): string {
  const first = start ?? end ?? null;
  const last = end ?? start ?? null;
  if (first === null || last === null) return path;
  return first === last ? `${path}:${first}` : `${path}:${first}-${last}`;
}

/** `Line 12`, `Lines 12 to 15`, or nothing for an anchor on a whole file. */
export function describeLines(
  start: number | null | undefined,
  end: number | null | undefined,
): string | null {
  if (start === null || start === undefined) return null;
  return end === null || end === undefined || end === start
    ? `Line ${start}`
    : `Lines ${start} to ${end}`;
}

export const INSTRUCTION_STATUS: Record<
  Instruction["status"],
  { label: string; tone: "neutral" | "notice" | "success" | "outline" }
> = {
  queued: { label: "Queued", tone: "neutral" },
  delivered: { label: "With the agent", tone: "notice" },
  answered: { label: "Answered", tone: "success" },
  dismissed: { label: "Withdrawn", tone: "outline" },
};

/** The instruction a thread or a finding was sent as, the newest that was not withdrawn. */
export function instructionFor(
  instructions: ReadonlyArray<Instruction>,
  source: { readonly findingId?: string; readonly commentIds?: ReadonlyArray<string> },
): Instruction | null {
  const matches = instructions.filter(
    (item) =>
      item.status !== "dismissed" &&
      ((source.findingId !== undefined && item.findingId === source.findingId) ||
        (item.reviewCommentId !== null &&
          (source.commentIds ?? []).includes(item.reviewCommentId))),
  );
  return matches[matches.length - 1] ?? null;
}

/** `my-new-feature` from an ask's first line, for a branch name to start from. */
export function branchNameFor(ask: string): string {
  const words = (ask.split("\n")[0] ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter((word) => word !== "");
  let name = "";
  for (const word of words) {
    if (name.length + word.length + 1 > 40) break;
    name = name === "" ? word : `${name}-${word}`;
  }
  return name === "" ? "" : `work/${name}`;
}

/**
 * Where a note came from when Infrawrench CI wrote it from a job's note
 * command: the job, as `<pipeline>/<job>`, and the line of the run's log it
 * was printed on (the run's page, at that line), when the note carries one.
 */
export interface CiSource {
  readonly job: string;
  readonly href: string | null;
}

/** A finding's, by its reviewer (`ci:<pipeline>/<job>`). Null for any other reviewer's. */
export const findingCiSource = (
  finding: Pick<ReviewFinding, "reviewerKind" | "evidence">,
): CiSource | null => {
  const job = ciReviewerJob(finding.reviewerKind);
  if (job === null) return null;
  const from = finding.evidence.find(
    (item) => item.kind === "ci" && item.url !== undefined && item.url !== null,
  );
  return { job, href: from?.url ?? null };
};

/** A trace entry's, by its agent (kind `ci`). Null for an entry an agent or a person recorded. */
export const traceCiSource = (entry: Pick<TraceEntry, "agent" | "evidence">): CiSource | null => {
  if (entry.agent === null || entry.agent.kind !== CI_AGENT_KIND) return null;
  return { job: entry.agent.name, href: entry.evidence?.url ?? null };
};
