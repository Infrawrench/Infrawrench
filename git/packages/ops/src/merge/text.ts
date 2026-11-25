/**
 * Three-way merge of text, as git's xmerge.c does it at its default level:
 * diff the base against each side, take changes that do not touch, compare
 * the ones that do, and narrow each conflict to the lines that really
 * differ between the two sides.
 */
import { concatBytes, encodeText } from "@infrawrench/git-core";
import { type Lines, lineBytes, sameLine, splitLines } from "../diff/lines";
import { type Change, type DiffAlgorithm, diffLineRanges, diffLines } from "../diff/xdiff";

export interface MergeTextOptions {
  /** Names after the `<<<<<<<` and `>>>>>>>` markers, and after `|||||||` for diff3. */
  readonly ours?: string;
  readonly theirs?: string;
  readonly base?: string;
  /** `merge` shows the two sides; `diff3` also shows the base between them. */
  readonly style?: "merge" | "diff3";
  /** Marker length. Git's default is 7. */
  readonly markerSize?: number;
  /** Git merges with `histogram`; that is the default here too. */
  readonly algorithm?: DiffAlgorithm;
  /** Resolve every conflict by taking one side, or both in order (git's `ours`, `theirs`, `union`). */
  readonly favor?: "ours" | "theirs" | "union";
}

export interface MergeTextResult {
  /** The merged file. With conflicts, it has conflict markers in it. */
  readonly data: Uint8Array;
  /** How many conflict blocks the result has. Zero means a clean merge. */
  readonly conflicts: number;
}

/** A region of the result: mode 0 is a conflict, 1 takes ours, 2 takes theirs, 3 both. */
interface Region {
  mode: number;
  i0: number;
  chg0: number;
  i1: number;
  chg1: number;
  i2: number;
  chg2: number;
}

function append(
  regions: Region[],
  mode: number,
  i0: number,
  chg0: number,
  i1: number,
  chg1: number,
  i2: number,
  chg2: number,
): void {
  const last = regions[regions.length - 1];
  // A change that touches the previous region joins it; if they came from different sides, that is a conflict.
  if (last && (i1 <= last.i1 + last.chg1 || i2 <= last.i2 + last.chg2)) {
    if (mode !== last.mode) last.mode = 0;
    last.chg0 = i0 + chg0 - last.i0;
    last.chg1 = i1 + chg1 - last.i1;
    last.chg2 = i2 + chg2 - last.i2;
    return;
  }
  regions.push({ mode, i0, chg0, i1, chg1, i2, chg2 });
}

function linesDiffer(a: Lines, i: number, b: Lines, j: number, count: number): boolean {
  for (let k = 0; k < count; k++) if (!sameLine(a, i + k, b, j + k)) return true;
  return false;
}

/** Whether line `i` ends in CRLF: 1 yes, 0 no, -1 cannot tell. */
function eolIsCrlf(file: Lines, i: number): number {
  const crlfAt = (index: number): number => {
    const size = file.starts[index + 1]! - file.starts[index]!;
    return size > 1 && file.data[file.starts[index + 1]! - 2] === 0x0d ? 1 : 0;
  };
  if (i < file.count - 1) return crlfAt(i);
  if (file.count === 0) return -1;
  const end = file.starts[i + 1]!;
  if (end > file.starts[i]! && file.data[end - 1] === 0x0a) return crlfAt(i);
  if (i === 0) return -1;
  return crlfAt(i - 1);
}

export function mergeText(
  baseData: Uint8Array,
  oursData: Uint8Array,
  theirsData: Uint8Array,
  options: MergeTextOptions = {},
): MergeTextResult {
  const base = splitLines(baseData);
  const ours = splitLines(oursData);
  const theirs = splitLines(theirsData);
  const algorithm = options.algorithm ?? "histogram";
  const diffOptions = { algorithm };
  const script1 = diffLines(base, ours, diffOptions).changes;
  const script2 = diffLines(base, theirs, diffOptions).changes;
  // One side did nothing: the other side is the result.
  if (script1.length === 0) return { data: theirsData, conflicts: 0 };
  if (script2.length === 0) return { data: oursData, conflicts: 0 };

  const regions: Region[] = [];
  let x = 0;
  let y = 0;
  while (x < script1.length && y < script2.length) {
    const a: Change = script1[x]!;
    const b: Change = script2[y]!;
    if (a.i1 + a.chg1 < b.i1) {
      append(regions, 1, a.i1, a.chg1, a.i2, a.chg2, b.i2 - b.i1 + a.i1, a.chg1);
      x++;
      continue;
    }
    if (b.i1 + b.chg1 < a.i1) {
      append(regions, 2, b.i1, b.chg1, a.i2 - a.i1 + b.i1, b.chg1, b.i2, b.chg2);
      y++;
      continue;
    }
    if (
      a.i1 !== b.i1 ||
      a.chg1 !== b.chg1 ||
      a.chg2 !== b.chg2 ||
      linesDiffer(ours, a.i2, theirs, b.i2, a.chg2)
    ) {
      const off = a.i1 - b.i1;
      const ffo = off + a.chg1 - b.chg1;
      let i0 = a.i1;
      let i1 = a.i2;
      let i2 = b.i2;
      if (off > 0) {
        i0 -= off;
        i1 -= off;
      } else i2 += off;
      let chg0 = a.i1 + a.chg1 - i0;
      let chg1 = a.i2 + a.chg2 - i1;
      let chg2 = b.i2 + b.chg2 - i2;
      if (ffo < 0) {
        chg0 -= ffo;
        chg1 -= ffo;
      } else chg2 += ffo;
      append(regions, 0, i0, chg0, i1, chg1, i2, chg2);
    }
    const end1 = a.i1 + a.chg1;
    const end2 = b.i1 + b.chg1;
    if (end1 >= end2) y++;
    if (end2 >= end1) x++;
  }
  for (; x < script1.length; x++) {
    const a = script1[x]!;
    append(regions, 1, a.i1, a.chg1, a.i2, a.chg2, a.i1 + theirs.count - base.count, a.chg1);
  }
  for (; y < script2.length; y++) {
    const b = script2[y]!;
    append(regions, 2, b.i1, b.chg1, b.i1 + ours.count - base.count, b.chg1, b.i2, b.chg2);
  }

  // Narrow each conflict to where the two sides differ from each other; what they share is not in dispute.
  // With the base shown (diff3) a narrowed conflict would no longer line up with it, so those stay whole.
  const whole = options.style === "diff3";
  const refined: Region[] = [];
  for (const region of regions) {
    if (whole || region.mode !== 0 || region.chg1 === 0 || region.chg2 === 0) {
      refined.push(region);
      continue;
    }
    const inner = diffLineRanges(
      ours,
      region.i1,
      region.chg1,
      theirs,
      region.i2,
      region.chg2,
      diffOptions,
    ).changes;
    if (inner.length === 0) {
      // Both sides made the same change. Mode 4 is skipped below, and ours is copied through.
      refined.push({ ...region, mode: 4 });
      continue;
    }
    for (const change of inner) {
      refined.push({
        mode: 0,
        i0: region.i0,
        chg0: region.chg0,
        i1: region.i1 + change.i1,
        chg1: change.chg1,
        i2: region.i2 + change.i2,
        chg2: change.chg2,
      });
    }
  }
  // Conflicts three lines or fewer apart read better as one.
  const merged: Region[] = [];
  for (const region of refined) {
    const last = merged[merged.length - 1];
    const near = last !== undefined && region.i1 - (last.i1 + last.chg1) <= 3;
    if (last && !whole && near && last.mode === 0 && region.mode === 0) {
      last.chg1 = region.i1 + region.chg1 - last.i1;
      last.chg2 = region.i2 + region.chg2 - last.i2;
      continue;
    }
    merged.push({ ...region });
  }

  const favor = options.favor === "ours" ? 1 : options.favor === "theirs" ? 2 : 0;
  const union = options.favor === "union";
  const markerSize = options.markerSize ?? 7;
  const out: Uint8Array[] = [];
  const LF = encodeText("\n");
  const CRLF = encodeText("\r\n");
  const copy = (file: Lines, from: number, count: number, crlf: boolean, addNewline: boolean) => {
    if (count <= 0) return;
    out.push(lineBytes(file, from, from + count));
    if (!addNewline) return;
    const end = file.starts[from + count]!;
    if (end === file.starts[from + count - 1]! || file.data[end - 1] !== 0x0a) {
      out.push(crlf ? CRLF : LF);
    }
  };
  const marker = (char: string, label: string | undefined, crlf: boolean): void => {
    const name = label === undefined || label === "" ? "" : ` ${label}`;
    out.push(encodeText(`${char.repeat(markerSize)}${name}${crlf ? "\r\n" : "\n"}`));
  };

  let conflicts = 0;
  let at = 0;
  for (const region of merged) {
    let mode = region.mode;
    if (mode === 0 && favor !== 0) mode = favor;
    if (mode === 0 && union) mode = 3;
    if (mode === 4) continue;
    copy(ours, at, region.i1 - at, false, false);
    // Markers end the way the lines around them do, so a CRLF file stays one.
    let crlf = eolIsCrlf(ours, region.i1 > 0 ? region.i1 - 1 : 0);
    if (crlf !== 0) crlf = eolIsCrlf(theirs, region.i2 > 0 ? region.i2 - 1 : 0);
    if (crlf !== 0) crlf = eolIsCrlf(base, 0);
    const needsCr = crlf > 0;
    if (mode === 0) {
      conflicts++;
      marker("<", options.ours, needsCr);
      copy(ours, region.i1, region.chg1, needsCr, true);
      if (options.style === "diff3") {
        marker("|", options.base, needsCr);
        copy(base, region.i0, region.chg0, needsCr, true);
      }
      marker("=", undefined, needsCr);
      copy(theirs, region.i2, region.chg2, needsCr, true);
      marker(">", options.theirs, needsCr);
    } else {
      if (mode & 1) copy(ours, region.i1, region.chg1, needsCr, (mode & 2) !== 0);
      if (mode & 2) copy(theirs, region.i2, region.chg2, false, false);
    }
    at = region.i1 + region.chg1;
  }
  copy(ours, at, ours.count - at, false, false);
  return { data: concatBytes(out), conflicts };
}
