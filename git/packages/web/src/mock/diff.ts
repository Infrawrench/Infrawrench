/**
 * A line diff for the mock's commit and compare diffs: longest common
 * subsequence over lines, grouped into unified hunks. Fixture files are a few
 * hundred lines at most, so the quadratic table is fine here.
 */
import type { DiffHunk, DiffLine } from "@infrawrench/git-contract";

export interface SplitText {
  readonly lines: string[];
  /** The text does not end in a newline. */
  readonly noNewlineAtEnd: boolean;
}

export function splitLines(text: string): SplitText {
  if (text === "") return { lines: [], noNewlineAtEnd: false };
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
    return { lines, noNewlineAtEnd: false };
  }
  return { lines, noNewlineAtEnd: true };
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** Every line of both sides in order, each marked context, add or delete. */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const out: Array<Mutable<DiffLine>> = [];

  let start = 0;
  while (start < a.lines.length && start < b.lines.length && a.lines[start] === b.lines[start]) {
    start++;
  }
  let endA = a.lines.length;
  let endB = b.lines.length;
  while (endA > start && endB > start && a.lines[endA - 1] === b.lines[endB - 1]) {
    endA--;
    endB--;
  }

  for (let i = 0; i < start; i++) {
    out.push({ type: "context", content: a.lines[i]!, oldLine: i + 1, newLine: i + 1 });
  }

  const n = endA - start;
  const m = endB - start;
  // lcs[i][j]: the longest common subsequence of a[start+i..] and b[start+j..].
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] =
        a.lines[start + i] === b.lines[start + j]
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a.lines[start + i] === b.lines[start + j]) {
      out.push({
        type: "context",
        content: a.lines[start + i]!,
        oldLine: start + i + 1,
        newLine: start + j + 1,
      });
      i++;
      j++;
    } else if (i < n && (j === m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      out.push({
        type: "delete",
        content: a.lines[start + i]!,
        oldLine: start + i + 1,
        newLine: null,
      });
      i++;
    } else {
      out.push({
        type: "add",
        content: b.lines[start + j]!,
        oldLine: null,
        newLine: start + j + 1,
      });
      j++;
    }
  }

  for (let k = 0; endA + k < a.lines.length; k++) {
    out.push({
      type: "context",
      content: a.lines[endA + k]!,
      oldLine: endA + k + 1,
      newLine: endB + k + 1,
    });
  }

  if (a.noNewlineAtEnd || b.noNewlineAtEnd) {
    for (const line of out) {
      const lastOld = a.noNewlineAtEnd && line.oldLine === a.lines.length;
      const lastNew = b.noNewlineAtEnd && line.newLine === b.lines.length;
      if (lastOld || lastNew) line.noNewlineAtEnd = true;
    }
  }
  return out;
}

/** The nearest line above `index` that starts at column 0 with a word, as `git diff` shows after `@@`. */
function sectionFor(lines: ReadonlyArray<DiffLine>, index: number): string {
  for (let k = index - 1; k >= 0; k--) {
    const line = lines[k]!;
    if (line.type === "add") continue;
    if (/^[A-Za-z_$]/.test(line.content)) return line.content.slice(0, 80);
  }
  return "";
}

/** Groups a full line diff into hunks with `context` unchanged lines around each change. */
export function buildHunks(lines: ReadonlyArray<DiffLine>, context = 3): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let index = 0;
  while (index < lines.length) {
    while (index < lines.length && lines[index]!.type === "context") index++;
    if (index >= lines.length) break;
    const from = Math.max(0, index - context);
    let to = index;
    let lastChange = index;
    while (to < lines.length) {
      if (lines[to]!.type !== "context") lastChange = to;
      else if (to - lastChange > context * 2) break;
      to++;
    }
    const until = Math.min(lines.length, lastChange + context + 1);
    const slice = lines.slice(from, until);
    const oldLines = slice.filter((l) => l.type !== "add");
    const newLines = slice.filter((l) => l.type !== "delete");
    hunks.push({
      oldStart: oldLines[0]?.oldLine ?? previousLine(lines, from, "oldLine"),
      oldLines: oldLines.length,
      newStart: newLines[0]?.newLine ?? previousLine(lines, from, "newLine"),
      newLines: newLines.length,
      section: sectionFor(lines, from),
      lines: slice,
    });
    index = until;
  }
  return hunks;
}

/** A side with no lines in the hunk starts at the line before it (0 for an empty file). */
function previousLine(
  lines: ReadonlyArray<DiffLine>,
  from: number,
  side: "oldLine" | "newLine",
): number {
  for (let k = from - 1; k >= 0; k--) {
    const value = lines[k]![side];
    if (value !== null) return value;
  }
  return 0;
}

export function countChanges(lines: ReadonlyArray<DiffLine>): {
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const line of lines) {
    if (line.type === "add") additions++;
    else if (line.type === "delete") deletions++;
  }
  return { additions, deletions };
}
