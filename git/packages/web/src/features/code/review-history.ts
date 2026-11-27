/**
 * The review record of merged branch pages, as the code pages read it: how a
 * finding was settled in a few words, where it goes on a blame, and its
 * address on the branch page.
 */
import type {
  BlameRange,
  FindingSeverity,
  MergedFinding,
  MergedReview,
  UserRef,
} from "@infrawrench/git-contract";
import { paths, type RepoRef } from "../../lib/paths";

export const FINDING_ANCHOR = "finding-";

/** A finding's place on its branch page. */
export const findingHref = (repo: RepoRef, pageKey: string, findingId: string): string =>
  `${paths.branchPage(repo, pageKey)}#${FINDING_ANCHOR}${findingId}`;

export type SettledTone = "success" | "warning" | "outline";

export interface Settled {
  readonly tone: SettledTone;
  /** `Fixed in v2`, `Dismissed`, `Open at merge`, `Merged past it`. */
  readonly label: string;
  /** Who decided and why, where somebody did. */
  readonly detail: {
    readonly verb: string;
    readonly by: UserRef | null;
    readonly reason: string | null;
  } | null;
}

/** How a finding stood when its branch was merged. */
export function settledAs(finding: MergedFinding): Settled {
  if (finding.status === "fixed") {
    return {
      tone: "success",
      label: finding.fixedInVersion === null ? "Fixed" : `Fixed in v${finding.fixedInVersion}`,
      detail: null,
    };
  }
  if (finding.status === "dismissed") {
    return {
      tone: "outline",
      label: "Dismissed",
      detail:
        finding.dismissedBy === null && finding.dismissalReason === null
          ? null
          : { verb: "Dismissed", by: finding.dismissedBy, reason: finding.dismissalReason },
    };
  }
  if (finding.override !== null) {
    return {
      tone: "warning",
      label: "Merged past it",
      detail: { verb: "Allowed", by: finding.override.by, reason: finding.override.reason },
    };
  }
  return { tone: "warning", label: "Open at merge", detail: null };
}

const nameOf = (user: UserRef | null): string | null =>
  user === null ? null : (user.username ?? user.displayName);

/** {@link settledAs} as one line of text, for a tooltip. */
export function settledText(finding: MergedFinding): string {
  const { label, detail } = settledAs(finding);
  if (detail === null) return label;
  const who = nameOf(detail.by);
  const said = `${detail.verb}${who === null ? "" : ` by ${who}`}${
    detail.reason === null ? "" : `: ${detail.reason}`
  }`;
  return detail.verb === label ? said : `${label}. ${said}`;
}

export const SEVERITY_ORDER: ReadonlyArray<FindingSeverity> = ["must_fix", "should_fix", "note"];

export const countFindings = (pages: ReadonlyArray<MergedReview>): number =>
  pages.reduce((total, page) => total + page.findings.length, 0);

export interface PlacedFinding {
  readonly page: MergedReview;
  readonly finding: MergedFinding;
}

export interface BlamePlacement {
  /** Findings by the first line they are about, in the file as blamed. */
  readonly starts: ReadonlyMap<number, ReadonlyArray<PlacedFinding>>;
  /** The lines after the first that a placed finding covers, with the gravest finding there. */
  readonly covered: ReadonlyMap<number, PlacedFinding>;
  /** Findings on the path whose lines could not be matched to the file as it is now. */
  readonly unplaced: ReadonlyArray<PlacedFinding>;
}

const rank = (finding: MergedFinding): number => SEVERITY_ORDER.indexOf(finding.severity);

/**
 * Where merged branch pages' findings sit on a blame.
 *
 * A finding's lines are numbered in one commit (`commitOid`), and a blame
 * range says where its lines were in the commit that last changed them. So a
 * finding has a place when a range of that same commit covers all its lines:
 * the numbers are then about the very same file. A squash has no such commit
 * in history, so there the merge commit stands in for the branch's last one
 * (`linesAtHead`): the lines the squash introduced are numbered as the branch
 * had them unless the base changed the same file meanwhile. Everything else
 * (a line since rewritten, a file renamed, a finding about the whole change's
 * file) is `unplaced`, and is counted on the file's header instead.
 */
export function placeOnBlame(
  ranges: ReadonlyArray<BlameRange>,
  pages: ReadonlyArray<MergedReview>,
): BlamePlacement {
  const starts = new Map<number, PlacedFinding[]>();
  const covered = new Map<number, PlacedFinding>();
  const unplaced: PlacedFinding[] = [];
  for (const page of pages) {
    for (const finding of page.findings) {
      const placed = { page, finding };
      const first = finding.startLine ?? finding.endLine;
      const last = finding.endLine ?? finding.startLine;
      const range =
        first === null || last === null || finding.side !== "RIGHT" || finding.path === null
          ? undefined
          : ranges.find(
              (candidate) =>
                candidate.originalPath === finding.path &&
                (candidate.commitOid === finding.commitOid ||
                  (finding.linesAtHead && candidate.commitOid === page.mergeCommitOid)) &&
                candidate.originalStartLine <= first &&
                last < candidate.originalStartLine + candidate.lineCount,
            );
      if (range === undefined || first === null || last === null) {
        unplaced.push(placed);
        continue;
      }
      const line = range.startLine + (first - range.originalStartLine);
      starts.set(
        line,
        [...(starts.get(line) ?? []), placed].sort((a, b) => rank(a.finding) - rank(b.finding)),
      );
      for (let next = line + 1; next <= line + (last - first); next++) {
        const there = covered.get(next);
        if (there === undefined || rank(finding) < rank(there.finding)) covered.set(next, placed);
      }
    }
  }
  return { starts, covered, unplaced };
}
