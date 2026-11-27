/**
 * The arithmetic of a diff view: the unchanged lines hidden between hunks
 * (gaps), revealing them from the file's text, and pairing lines for the
 * split view. Pure functions over the contract's `DiffHunk`.
 */
import type { DiffHunk, DiffLine } from "@infrawrench/git-contract";

/**
 * The first line a hunk covers on a side. A side with no lines in the hunk
 * (a pure addition's old side) carries the line before it as its start, as
 * `git diff` writes it.
 */
const firstLine = (start: number, count: number): number => (count === 0 ? start + 1 : start);
/** The line after the last one a hunk covers on a side. */
const nextLine = (start: number, count: number): number =>
  count === 0 ? start + 1 : start + count;

export interface Gap {
  /** `0` is before the first hunk, `hunks.length` after the last. */
  readonly index: number;
  readonly oldStart: number;
  readonly newStart: number;
  /** Hidden lines. Null for the gap after the last hunk until the file's length is known. */
  readonly count: number | null;
}

/**
 * The gap before hunk `index` (or after the last hunk for `hunks.length`).
 * `newLineCount` is the new file's length, when known.
 */
export function gapAt(
  hunks: ReadonlyArray<DiffHunk>,
  index: number,
  newLineCount: number | null,
): Gap {
  const previous = hunks[index - 1];
  const next = hunks[index];
  const oldStart = previous ? nextLine(previous.oldStart, previous.oldLines) : 1;
  const newStart = previous ? nextLine(previous.newStart, previous.newLines) : 1;
  if (next) {
    return { index, oldStart, newStart, count: firstLine(next.newStart, next.newLines) - newStart };
  }
  return {
    index,
    oldStart,
    newStart,
    count: newLineCount === null ? null : Math.max(0, newLineCount - newStart + 1),
  };
}

const contextLines = (
  text: ReadonlyArray<string>,
  oldStart: number,
  newStart: number,
  count: number,
): DiffLine[] =>
  Array.from({ length: count }, (_, offset) => ({
    type: "context" as const,
    content: text[newStart - 1 + offset] ?? "",
    oldLine: oldStart + offset,
    newLine: newStart + offset,
  }));

const withLines = (hunk: DiffHunk, before: DiffLine[], after: DiffLine[]): DiffHunk => ({
  ...hunk,
  oldStart: before.length > 0 ? before[0]!.oldLine! : firstLine(hunk.oldStart, hunk.oldLines),
  newStart: before.length > 0 ? before[0]!.newLine! : firstLine(hunk.newStart, hunk.newLines),
  oldLines: hunk.oldLines + before.length + after.length,
  newLines: hunk.newLines + before.length + after.length,
  // The section named the hidden lines above; once they show, it says nothing.
  section: before.length > 0 ? "" : hunk.section,
  lines: [...before, ...hunk.lines, ...after],
});

/**
 * Reveals lines of the gap at `gapIndex` from the new file's text
 * (`newText`, one string per line).
 *
 * `down` shows up to `amount` lines following the hunk above the gap, `up`
 * the lines preceding the hunk below it, `all` the whole gap. When nothing is
 * left hidden between two hunks they become one.
 */
export function expandGap(
  hunks: ReadonlyArray<DiffHunk>,
  gapIndex: number,
  direction: "up" | "down" | "all",
  newText: ReadonlyArray<string>,
  amount = 20,
): DiffHunk[] {
  const gap = gapAt(hunks, gapIndex, newText.length);
  const hidden = gap.count ?? 0;
  if (hidden <= 0) return [...hunks];
  const above = hunks[gapIndex - 1];
  const below = hunks[gapIndex];
  const take = direction === "all" ? hidden : Math.min(amount, hidden);
  const result = [...hunks];

  if (take === hidden && above && below) {
    const middle = contextLines(newText, gap.oldStart, gap.newStart, hidden);
    result.splice(gapIndex - 1, 2, {
      oldStart: firstLine(above.oldStart, above.oldLines),
      newStart: firstLine(above.newStart, above.newLines),
      oldLines: above.oldLines + hidden + below.oldLines,
      newLines: above.newLines + hidden + below.newLines,
      section: above.section,
      lines: [...above.lines, ...middle, ...below.lines],
    });
    return result;
  }

  // With a hunk on one side only, the lines join that hunk whatever the direction.
  const toAbove = above !== undefined && (below === undefined || direction !== "up");
  if (toAbove) {
    result[gapIndex - 1] = withLines(
      above,
      [],
      contextLines(newText, gap.oldStart, gap.newStart, take),
    );
  } else if (below) {
    const skip = hidden - take;
    result[gapIndex] = withLines(
      below,
      contextLines(newText, gap.oldStart + skip, gap.newStart + skip, take),
      [],
    );
  }
  return result;
}

export interface SplitRow {
  readonly left: DiffLine | null;
  readonly right: DiffLine | null;
}

/**
 * A hunk's lines side by side: context on both sides, and each run of
 * deletions paired row by row with the additions that follow it.
 */
export function splitRows(lines: ReadonlyArray<DiffLine>): SplitRow[] {
  const rows: SplitRow[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.type === "context") {
      rows.push({ left: line, right: line });
      index++;
      continue;
    }
    const deletions: DiffLine[] = [];
    const additions: DiffLine[] = [];
    while (index < lines.length && lines[index]!.type === "delete") deletions.push(lines[index++]!);
    while (index < lines.length && lines[index]!.type === "add") additions.push(lines[index++]!);
    const height = Math.max(deletions.length, additions.length);
    for (let row = 0; row < height; row++) {
      rows.push({ left: deletions[row] ?? null, right: additions[row] ?? null });
    }
  }
  return rows;
}

/** `@@ -1,5 +1,7 @@`, as `git diff` writes a hunk header. */
export function hunkHeader(hunk: DiffHunk): string {
  const side = (start: number, count: number) => (count === 1 ? `${start}` : `${start},${count}`);
  return `@@ -${side(hunk.oldStart, hunk.oldLines)} +${side(hunk.newStart, hunk.newLines)} @@`;
}

/** The text of one side of a file's hunks, for highlighting, with each line's number. */
export function sideText(
  hunks: ReadonlyArray<DiffHunk>,
  side: "old" | "new",
): { text: string; numbers: number[] } {
  const content: string[] = [];
  const numbers: number[] = [];
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      const number = side === "old" ? line.oldLine : line.newLine;
      if (number === null) continue;
      content.push(line.content);
      numbers.push(number);
    }
  }
  return { text: content.join("\n"), numbers };
}
