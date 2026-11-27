import { getSingularPatch } from "@pierre/diffs";
import type { DiffFile, DiffHunk, DiffLine } from "@infrawrench/git-contract";
import { describe, expect, it } from "vitest";
import {
  EMPTY_VIEW,
  EXCERPT_ROWS,
  excerptOf,
  fileView,
  focusFile,
  linesOfHunks,
  orderFiles,
  rankOf,
  reveal,
  setAll,
  setFull,
  setOpen,
  type FileNotes,
  type FocusGap,
  type FocusLines,
  type FocusRange,
} from "../focus";
import { patchOf } from "../patch";

const context = (oldLine: number, newLine: number): DiffLine => ({
  type: "context",
  content: `same ${newLine}`,
  oldLine,
  newLine,
});
const add = (newLine: number): DiffLine => ({
  type: "add",
  content: `new ${newLine}`,
  oldLine: null,
  newLine,
});
const del = (oldLine: number): DiffLine => ({
  type: "delete",
  content: `old ${oldLine}`,
  oldLine,
  newLine: null,
});

const fileOf = (hunks: DiffHunk[], over: Partial<DiffFile> = {}): DiffFile => ({
  path: "src/a.ts",
  oldPath: null,
  status: "modified",
  oldMode: "100644",
  newMode: "100644",
  oldOid: null,
  newOid: null,
  binary: false,
  additions: 0,
  deletions: 0,
  similarity: null,
  hunks,
  tooLarge: false,
  ...over,
});

const count = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, at) => from + at);

/** Three unchanged lines, lines 4 to 43 added, three unchanged lines. */
const added: DiffHunk = {
  oldStart: 1,
  oldLines: 6,
  newStart: 1,
  newLines: 46,
  section: "fn main()",
  lines: [
    ...count(1, 3).map((line) => context(line, line)),
    ...count(4, 43).map(add),
    ...count(44, 46).map((line) => context(line - 40, line)),
  ],
};

const on = (start: number, end = start, side: FocusRange["side"] = "additions"): FocusRange => ({
  side,
  start,
  end,
});
const linesOf = (piece: FocusLines | FocusGap | undefined): FocusLines => {
  if (piece?.kind !== "lines") throw new Error("not lines");
  return piece;
};
const gapOf = (piece: FocusLines | FocusGap | undefined): FocusGap => {
  if (piece?.kind !== "gap") throw new Error("not a gap");
  return piece;
};
const newLines = (hunk: DiffHunk): number[] =>
  hunk.lines.flatMap((line) => (line.newLine === null ? [] : [line.newLine]));
/** What the renderer makes of the hunks: it has to read them as a patch. */
const parsed = (file: DiffFile, hunks: ReadonlyArray<DiffHunk>) =>
  getSingularPatch(patchOf({ ...file, hunks })).hunks.map((hunk) => ({
    additionStart: hunk.additionStart,
    deletionStart: hunk.deletionStart,
    additionCount: hunk.additionCount,
    deletionCount: hunk.deletionCount,
  }));

describe("focusFile", () => {
  it("shows three lines either side of a line, and counts what it leaves out", () => {
    const file = fileOf([added]);
    const focused = focusFile(file, [on(20)])!;
    expect(focused.pieces.map((piece) => piece.kind)).toEqual(["gap", "lines", "gap"]);
    const before = gapOf(focused.pieces[0]);
    const window = linesOf(focused.pieces[1]);
    const after = gapOf(focused.pieces[2]);
    expect(newLines(window.hunks[0]!)).toEqual(count(17, 23));
    expect(before.changed).toBe(13);
    expect(after.changed).toBe(20);
    expect(focused.shownChanged).toBe(7);
    expect(focused.totalChanged).toBe(40);
    // The window is a hunk of its own, numbered where it starts on both sides.
    expect(window.hunks[0]).toMatchObject({ oldStart: 3, oldLines: 0, newStart: 17, newLines: 7 });
    expect(parsed(file, window.hunks)).toEqual([
      { additionStart: 17, deletionStart: 3, additionCount: 7, deletionCount: 0 },
    ]);
  });

  it("shows a range whole, with its lines around it", () => {
    const focused = focusFile(fileOf([added]), [on(10, 14)])!;
    expect(newLines(linesOf(focused.pieces[1]).hunks[0]!)).toEqual(count(7, 17));
  });

  it("merges windows that meet, and keeps apart the ones that do not", () => {
    const merged = focusFile(fileOf([added]), [on(10), on(15)])!;
    expect(merged.pieces.map((piece) => piece.kind)).toEqual(["gap", "lines", "gap"]);
    expect(newLines(linesOf(merged.pieces[1]).hunks[0]!)).toEqual(count(7, 18));

    const apart = focusFile(fileOf([added]), [on(10), on(30)])!;
    expect(apart.pieces.map((piece) => piece.kind)).toEqual([
      "gap",
      "lines",
      "gap",
      "lines",
      "gap",
    ]);
    expect(gapOf(apart.pieces[2]).changed).toBe(13);
    expect(gapOf(apart.pieces[2]).reveal).toEqual([on(14, 26)]);
  });

  it("leaves out unchanged lines without a word, as between any two hunks", () => {
    // Lines 1 to 10 unchanged, 11 added, 12 to 31 unchanged, 32 added, the rest unchanged.
    const hunk: DiffHunk = {
      oldStart: 1,
      oldLines: 38,
      newStart: 1,
      newLines: 40,
      section: "",
      lines: [
        ...count(1, 10).map((line) => context(line, line)),
        add(11),
        ...count(12, 31).map((line) => context(line - 1, line)),
        add(32),
        ...count(33, 40).map((line) => context(line - 2, line)),
        ...count(41, 60).map(add),
      ],
    };
    const file = fileOf([hunk]);
    const focused = focusFile(file, [on(11), on(32)])!;
    // Both windows in one piece: only unchanged lines lie between them.
    expect(focused.pieces.map((piece) => piece.kind)).toEqual(["lines", "gap"]);
    const window = linesOf(focused.pieces[0]);
    expect(window.hunks.map(newLines)).toEqual([count(8, 14), count(29, 35)]);
    expect(parsed(file, window.hunks)).toEqual([
      { additionStart: 8, deletionStart: 8, additionCount: 7, deletionCount: 6 },
      { additionStart: 29, deletionStart: 28, additionCount: 7, deletionCount: 6 },
    ]);
    expect(gapOf(focused.pieces[1]).changed).toBe(20);
  });

  it("cuts a rewritten block so each removed line stays beside the line that replaced it", () => {
    // Old lines 2 to 21 replaced by new lines 2 to 21, one for one.
    const hunk: DiffHunk = {
      oldStart: 1,
      oldLines: 22,
      newStart: 1,
      newLines: 22,
      section: "",
      lines: [context(1, 1), ...count(2, 21).map(del), ...count(2, 21).map(add), context(22, 22)],
    };
    const file = fileOf([hunk]);
    const focused = focusFile(file, [on(10)])!;
    const window = linesOf(focused.pieces[1]).hunks[0]!;
    expect(window.lines.map((line) => `${line.type}:${line.oldLine ?? line.newLine}`)).toEqual([
      ...count(7, 13).map((line) => `delete:${line}`),
      ...count(7, 13).map((line) => `add:${line}`),
    ]);
    expect(window).toMatchObject({ oldStart: 7, oldLines: 7, newStart: 7, newLines: 7 });
    // Both halves of each pair are counted.
    expect(gapOf(focused.pieces[0]).changed).toBe(10);
    expect(gapOf(focused.pieces[0]).reveal).toEqual([on(2, 6, "deletions"), on(2, 6)]);
    expect(focused.shownChanged).toBe(14);
    expect(focused.totalChanged).toBe(40);
  });

  it("finds a removed line by its number in the old file", () => {
    const hunk: DiffHunk = {
      oldStart: 1,
      oldLines: 30,
      newStart: 0,
      newLines: 0,
      section: "",
      lines: count(1, 30).map(del),
    };
    const focused = focusFile(fileOf([hunk], { status: "deleted" }), [on(15, 15, "deletions")])!;
    const window = linesOf(focused.pieces[1]).hunks[0]!;
    expect(window.lines.map((line) => line.oldLine)).toEqual(count(12, 18));
    expect(window).toMatchObject({ oldStart: 12, oldLines: 7, newStart: 0, newLines: 0 });
  });

  it("is nothing to cut down when every changed line would show, or nothing is in focus", () => {
    const small: DiffHunk = {
      oldStart: 1,
      oldLines: 2,
      newStart: 1,
      newLines: 4,
      section: "",
      lines: [context(1, 1), add(2), add(3), context(2, 4)],
    };
    expect(focusFile(fileOf([small]), [on(2)])).toBeNull();
    expect(focusFile(fileOf([added]), [])).toBeNull();
    // A line the diff does not have focuses on nothing.
    expect(focusFile(fileOf([added]), [on(400)])).toBeNull();
  });

  it("shows more when a gap is asked for, and all of it when every gap is", () => {
    const file = fileOf([added]);
    const first = focusFile(file, [on(20)])!;
    const after = gapOf(first.pieces[2]);
    const wider = focusFile(file, [on(20), ...after.reveal])!;
    expect(wider.pieces.map((piece) => piece.kind)).toEqual(["gap", "lines"]);
    expect(newLines(linesOf(wider.pieces[1]).hunks[0]!)).toEqual(count(17, 46));
    const before = gapOf(wider.pieces[0]);
    expect(focusFile(file, [on(20), ...after.reveal, ...before.reveal])).toBeNull();
  });

  it("keeps a revealed region open when a comment is written on a line of it", () => {
    const file = fileOf([added]);
    const first = focusFile(file, [on(8)])!;
    const state = reveal(EMPTY_VIEW, file.path, gapOf(first.pieces[2]).reveal);
    // The comment's line is one more thing in focus; what was revealed still is.
    const commented = [on(8), on(40), ...fileView(state, file.path).reveals];
    const shown = linesOfHunks(linesOf(focusFile(file, commented)!.pieces[1]).hunks);
    expect(shown.has("additions:40")).toBe(true);
    expect(shown.has("additions:25")).toBe(true);
  });
});

describe("excerptOf", () => {
  it("is the lines with one either side, and no more than a card holds", () => {
    const file = fileOf([added]);
    expect(excerptOf(file, on(20, 22)).map(newLines)).toEqual([count(19, 23)]);
    expect(excerptOf(file, on(4, 43)).map(newLines)).toEqual([count(3, 4 + EXCERPT_ROWS)]);
    expect(excerptOf(file, on(400))).toEqual([]);
  });
});

describe("what the page remembers of a file", () => {
  it("starts closed, opens, and keeps what was revealed through expand and collapse all", () => {
    expect(fileView(EMPTY_VIEW, "a")).toEqual({ open: false, full: false, reveals: [] });
    let state = setOpen(EMPTY_VIEW, "a", true);
    expect(fileView(state, "a").open).toBe(true);
    expect(fileView(state, "b").open).toBe(false);

    state = reveal(state, "b", [on(5, 9)]);
    expect(fileView(state, "b")).toEqual({ open: true, full: false, reveals: [on(5, 9)] });
    // Asking for lines already asked for adds nothing.
    expect(reveal(state, "b", [on(6, 7)]).files.get("b")!.reveals).toEqual([on(5, 9)]);

    state = setFull(state, "a", true);
    state = setAll(state, false);
    expect(fileView(state, "a")).toEqual({ open: false, full: true, reveals: [] });
    expect(fileView(state, "b")).toEqual({ open: false, full: false, reveals: [on(5, 9)] });
    state = setAll(state, true);
    expect(fileView(state, "c").open).toBe(true);
    // One closed after "Expand all" stays closed.
    expect(fileView(setOpen(state, "c", false), "c").open).toBe(false);
  });
});

describe("orderFiles", () => {
  const notes: FileNotes = {
    mustFix: new Set(["z/must.tf"]),
    traced: new Map([
      ["m/second.tf", 4],
      ["x/first.tf", 1],
      ["z/must.tf", 6],
    ]),
    noted: new Set(["b/thread.tf", "z/must.tf"]),
  };
  const files = [
    "a/plain.tf",
    "b/thread.tf",
    "c/plain.tf",
    "m/second.tf",
    "x/first.tf",
    "z/must.tf",
  ];

  it("puts what must be fixed first, then the trace's files in its order, then the rest", () => {
    expect(
      orderFiles(
        files.map((path) => ({ path })),
        notes,
      ).map((file) => file.path),
    ).toEqual([
      "z/must.tf",
      "x/first.tf",
      "m/second.tf",
      "b/thread.tf",
      "a/plain.tf",
      "c/plain.tf",
    ]);
    expect(files.map((path) => rankOf(path, notes))).toEqual([3, 2, 3, 1, 1, 0]);
  });

  it("keeps a file where it was while the reader writes on it", () => {
    const held = new Map([["c/plain.tf", 3]]);
    const after: FileNotes = { ...notes, noted: new Set([...notes.noted, "c/plain.tf"]) };
    expect(
      orderFiles(
        files.map((path) => ({ path })),
        after,
        held,
      ).map((file) => file.path),
    ).toEqual([
      "z/must.tf",
      "x/first.tf",
      "m/second.tf",
      "b/thread.tf",
      "a/plain.tf",
      "c/plain.tf",
    ]);
  });
});
