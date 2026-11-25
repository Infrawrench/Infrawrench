import type { DiffHunk } from "@infrawrench/git-contract";
import { describe, expect, test } from "vitest";
import { buildHunks, diffLines } from "../../mock/diff";
import { expandGap, gapAt, hunkHeader, sideText, splitRows } from "../diff-rows";

const numbered = (count: number, change: Record<number, string> = {}): string =>
  Array.from({ length: count }, (_, i) => change[i + 1] ?? `line ${i + 1}`).join("\n") + "\n";

/** A 60-line file with line 10 and line 50 changed: two hunks with a gap between. */
const oldText = numbered(60);
const newText = numbered(60, { 10: "ten", 50: "fifty" });
const newLines = newText.split("\n").slice(0, -1);
const hunks = buildHunks(diffLines(oldText, newText), 3);

/** Every hunk's lines carry consecutive numbers on both sides and match the file. */
function expectConsistent(result: ReadonlyArray<DiffHunk>) {
  for (const hunk of result) {
    const newSide = hunk.lines.filter((line) => line.newLine !== null);
    const oldSide = hunk.lines.filter((line) => line.oldLine !== null);
    expect(newSide.length).toBe(hunk.newLines);
    expect(oldSide.length).toBe(hunk.oldLines);
    newSide.forEach((line, index) => {
      expect(line.newLine).toBe(hunk.newStart + index);
      expect(line.content).toBe(newLines[line.newLine! - 1]);
    });
    oldSide.forEach((line, index) => expect(line.oldLine).toBe(hunk.oldStart + index));
  }
}

describe("the mock's line diff", () => {
  test("two separate changes make two hunks with three lines of context", () => {
    expect(hunks.map(hunkHeader)).toEqual(["@@ -7,7 +7,7 @@", "@@ -47,7 +47,7 @@"]);
    expect(hunks[0]!.lines.map((line) => line.type)).toEqual([
      "context",
      "context",
      "context",
      "delete",
      "add",
      "context",
      "context",
      "context",
    ]);
    expectConsistent(hunks);
  });

  test("changes close together share a hunk", () => {
    const close = buildHunks(diffLines(oldText, numbered(60, { 10: "a", 14: "b" })), 3);
    expect(close.map(hunkHeader)).toEqual(["@@ -7,11 +7,11 @@"]);
  });

  test("an added file is one hunk starting at 0 on the old side", () => {
    const added = buildHunks(diffLines("", "a\nb\n"), 3);
    expect(added.map(hunkHeader)).toEqual(["@@ -0,0 +1,2 @@"]);
  });

  test("a missing final newline is marked on the last line", () => {
    const lines = diffLines("a\nb\n", "a\nb");
    expect(lines.at(-1)).toMatchObject({ content: "b", noNewlineAtEnd: true });
  });
});

describe("gapAt", () => {
  test("before, between and after the hunks", () => {
    expect(gapAt(hunks, 0, null)).toEqual({ index: 0, oldStart: 1, newStart: 1, count: 6 });
    expect(gapAt(hunks, 1, null)).toEqual({ index: 1, oldStart: 14, newStart: 14, count: 33 });
    expect(gapAt(hunks, 2, null)).toMatchObject({ newStart: 54, count: null });
    expect(gapAt(hunks, 2, 60)).toMatchObject({ newStart: 54, count: 7 });
  });

  test("line numbers shift after an insertion", () => {
    const grown = buildHunks(
      diffLines(oldText, newText.replace("line 20\n", "line 20\nextra\n")),
      3,
    );
    expect(gapAt(grown, 2, null)).toMatchObject({ oldStart: 24, newStart: 25 });
  });
});

describe("expandGap", () => {
  test("down adds lines under the hunk above", () => {
    const result = expandGap(hunks, 1, "down", newLines, 20);
    expect(result.map(hunkHeader)).toEqual(["@@ -7,27 +7,27 @@", "@@ -47,7 +47,7 @@"]);
    expect(gapAt(result, 1, 60).count).toBe(13);
    expectConsistent(result);
  });

  test("up adds lines over the hunk below", () => {
    const result = expandGap(hunks, 1, "up", newLines, 20);
    expect(result.map(hunkHeader)).toEqual(["@@ -7,7 +7,7 @@", "@@ -27,27 +27,27 @@"]);
    expectConsistent(result);
  });

  test("revealing the whole gap joins the two hunks", () => {
    const result = expandGap(hunks, 1, "all", newLines);
    expect(result.map(hunkHeader)).toEqual(["@@ -7,47 +7,47 @@"]);
    expectConsistent(result);
  });

  test("two partial steps that meet also join the hunks", () => {
    const once = expandGap(hunks, 1, "down", newLines, 20);
    const twice = expandGap(once, 1, "up", newLines, 20);
    expect(twice).toHaveLength(1);
    expectConsistent(twice);
  });

  test("the gaps at the ends grow the first and last hunk", () => {
    const top = expandGap(hunks, 0, "up", newLines);
    expect(hunkHeader(top[0]!)).toBe("@@ -1,13 +1,13 @@");
    const bottom = expandGap(hunks, 2, "down", newLines);
    expect(hunkHeader(bottom[1]!)).toBe("@@ -47,14 +47,14 @@");
    expect(gapAt(bottom, 2, 60).count).toBe(0);
    expectConsistent(top);
    expectConsistent(bottom);
  });

  test("a gap with nothing hidden changes nothing", () => {
    const all = expandGap(hunks, 0, "up", newLines);
    expect(expandGap(all, 0, "up", newLines)).toEqual(all);
  });
});

describe("splitRows", () => {
  test("pairs deletions with the additions that follow", () => {
    const lines = diffLines("a\nb\nc\nd\n", "a\nB\nC\nextra\nd\n");
    const rows = splitRows(lines).map((row) => [
      row.left?.content ?? null,
      row.right?.content ?? null,
    ]);
    expect(rows).toEqual([
      ["a", "a"],
      ["b", "B"],
      ["c", "C"],
      [null, "extra"],
      ["d", "d"],
    ]);
  });

  test("a deletion with no addition leaves the right side empty", () => {
    const rows = splitRows(diffLines("a\nb\n", "a\n"));
    expect(rows[1]).toMatchObject({ left: { content: "b" }, right: null });
  });
});

test("sideText gives each side's lines with their numbers", () => {
  const first = [hunks[0]!];
  expect(sideText(first, "old").numbers).toEqual([7, 8, 9, 10, 11, 12, 13]);
  expect(sideText(first, "new").text.split("\n")[3]).toBe("ten");
});
