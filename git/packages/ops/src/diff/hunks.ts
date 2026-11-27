/** Groups a line diff into unified hunks with context, as xemit.c does. */
import { decodeText } from "@infrawrench/git-core";
import type { Lines } from "./lines";
import type { Change } from "./xdiff";

/** A hunk as ranges: the changes it covers and the lines around them. Line numbers are 0-based. */
export interface HunkRange {
  /** First line shown of the old file, and how many. */
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly changes: readonly Change[];
  /** The text git prints after the second `@@`: the nearest earlier line that looks like a heading. */
  readonly section: string;
}

function isAlpha(byte: number): boolean {
  return (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a);
}

/** Git's default: a line that starts with a letter, `_` or `$` names the section. At most 80 bytes of it. */
function sectionAt(lines: Lines, index: number): string | null {
  const start = lines.starts[index]!;
  let end = lines.starts[index + 1]!;
  if (end === start) return null;
  const first = lines.data[start]!;
  if (!isAlpha(first) && first !== 0x5f && first !== 0x24) return null;
  if (end - start > 80) end = start + 80;
  while (end > start) {
    const c = lines.data[end - 1]!;
    if (c !== 0x20 && (c < 0x09 || c > 0x0d)) break;
    end--;
  }
  return decodeText(lines.data.subarray(start, end));
}

export interface HunkOptions {
  /** Unchanged lines shown around each change. Git's default is 3. */
  readonly context?: number;
  /** Changes this close (beyond twice the context) share a hunk. Git's default is 0. */
  readonly interHunkContext?: number;
}

export function buildHunks(
  oldLines: Lines,
  newLines: Lines,
  changes: readonly Change[],
  options: HunkOptions = {},
): HunkRange[] {
  const context = options.context ?? 3;
  const maxCommon = 2 * context + (options.interHunkContext ?? 0);
  const hunks: HunkRange[] = [];
  let section = "";
  let searchedFrom = -1;

  for (let first = 0; first < changes.length;) {
    let last = first;
    while (last + 1 < changes.length) {
      const previous = changes[last]!;
      if (changes[last + 1]!.i1 - (previous.i1 + previous.chg1) > maxCommon) break;
      last++;
    }
    const head = changes[first]!;
    const tail = changes[last]!;
    const s1 = Math.max(head.i1 - context, 0);
    const s2 = Math.max(head.i2 - context, 0);
    const after = Math.min(
      context,
      oldLines.count - (tail.i1 + tail.chg1),
      newLines.count - (tail.i2 + tail.chg2),
    );
    const e1 = tail.i1 + tail.chg1 + after;
    const e2 = tail.i2 + tail.chg2 + after;

    // Look back from just above the hunk to where the previous hunk's search began.
    for (let l = s1 - 1; l > searchedFrom && l >= 0; l--) {
      const found = sectionAt(oldLines, l);
      if (found !== null) {
        section = found;
        break;
      }
    }
    searchedFrom = s1 - 1;

    hunks.push({
      oldStart: s1,
      oldLines: e1 - s1,
      newStart: s2,
      newLines: e2 - s2,
      changes: changes.slice(first, last + 1),
      section,
    });
    first = last + 1;
  }
  return hunks;
}

/** `@@ -a,b +c,d @@ section`. A count of one is left out, and an empty range names the line before it. */
export function hunkHeader(hunk: HunkRange): string {
  const range = (start: number, count: number): string =>
    count === 1 ? `${start + 1}` : `${count === 0 ? start : start + 1},${count}`;
  const head = `@@ -${range(hunk.oldStart, hunk.oldLines)} +${range(hunk.newStart, hunk.newLines)} @@`;
  return hunk.section === "" ? head : `${head} ${hunk.section}`;
}

export type HunkLineKind = "context" | "delete" | "add";

/** Walks a hunk's lines in the order a unified diff prints them. Context comes from the new file. */
export function* hunkLines(
  hunk: HunkRange,
): Generator<{ kind: HunkLineKind; oldIndex: number; newIndex: number }, void, void> {
  let o = hunk.oldStart;
  let n = hunk.newStart;
  for (const change of hunk.changes) {
    for (; n < change.i2; o++, n++) yield { kind: "context", oldIndex: o, newIndex: n };
    for (let k = 0; k < change.chg1; k++) yield { kind: "delete", oldIndex: o++, newIndex: -1 };
    for (let k = 0; k < change.chg2; k++) yield { kind: "add", oldIndex: -1, newIndex: n++ };
  }
  for (; n < hunk.newStart + hunk.newLines; o++, n++) {
    yield { kind: "context", oldIndex: o, newIndex: n };
  }
}
