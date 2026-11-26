import { getSingularPatch } from "@pierre/diffs";
import type { DiffFile, DiffHunk, DiffLine } from "@infrawrench/git-contract";
import { describe, expect, it } from "vitest";
import { oldLinesOf, patchOf, rowAbove } from "../patch";

const context = (oldLine: number, newLine: number, content: string): DiffLine => ({
  type: "context",
  content,
  oldLine,
  newLine,
});
const add = (newLine: number, content: string): DiffLine => ({
  type: "add",
  content,
  oldLine: null,
  newLine,
});
const del = (oldLine: number, content: string): DiffLine => ({
  type: "delete",
  content,
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

// Old: a b c d e f g h. New: a b C1 C2 d e f G h.
const first: DiffHunk = {
  oldStart: 1,
  oldLines: 4,
  newStart: 1,
  newLines: 5,
  section: "",
  lines: [
    context(1, 1, "a"),
    context(2, 2, "b"),
    del(3, "c"),
    add(3, "C1"),
    add(4, "C2"),
    context(4, 5, "d"),
  ],
};
const second: DiffHunk = {
  oldStart: 6,
  oldLines: 3,
  newStart: 7,
  newLines: 3,
  section: "fn tail()",
  lines: [context(6, 7, "f"), del(7, "g"), add(8, "G"), context(8, 9, "h")],
};
const file = fileOf([first, second]);

describe("patchOf", () => {
  it("writes hunks the renderer reads back with the same line numbers", () => {
    const parsed = getSingularPatch(patchOf(file));
    expect(parsed.name).toBe("src/a.ts");
    expect(parsed.type).toBe("change");
    expect(parsed.hunks).toHaveLength(2);
    expect(parsed.hunks.map((hunk) => [hunk.deletionStart, hunk.additionStart])).toEqual([
      [1, 1],
      [6, 7],
    ]);
    expect(parsed.hunks[1]!.hunkContext).toBe("fn tail()");
    expect(parsed.isPartial).toBe(true);
  });

  it("names a new file, a deleted one and a renamed one as Git does", () => {
    const added = patchOf(
      fileOf([{ ...first, oldStart: 0, oldLines: 0, lines: [add(1, "x")], newLines: 1 }], {
        status: "added",
        oldMode: null,
      }),
    );
    expect(added).toContain("new file mode 100644\n--- /dev/null\n+++ b/src/a.ts\n@@ -0,0 +1 @@");
    expect(getSingularPatch(added).type).toBe("new");

    const deleted = patchOf(fileOf([], { status: "deleted", newMode: null }));
    expect(deleted).toContain("deleted file mode 100644\n--- a/src/a.ts\n+++ /dev/null");

    const renamed = patchOf(fileOf([first], { status: "renamed", oldPath: "src/old.ts" }));
    expect(renamed).toContain("similarity index 50%\nrename from src/old.ts\nrename to src/a.ts");
    expect(getSingularPatch(renamed).prevName).toBe("src/old.ts");
  });

  it("writes bidirectional controls out, in a line and in a name", () => {
    const text = patchOf(
      fileOf([{ ...first, lines: [add(1, "ok‮ evil")], oldLines: 0, oldStart: 0, newLines: 1 }], {
        path: "a‮txt.exe",
      }),
    );
    expect(text).not.toContain("‮");
    expect(text).toContain("+ok<U+202E> evil");
    expect(text).toContain("b/a<U+202E>txt.exe");
  });

  it("keeps a missing final newline", () => {
    const text = patchOf(
      fileOf([
        {
          ...first,
          lines: [{ ...add(1, "last"), noNewlineAtEnd: true }],
          oldStart: 0,
          oldLines: 0,
          newLines: 1,
        },
      ]),
    );
    expect(text).toContain("+last\n\\ No newline at end of file\n");
  });
});

describe("oldLinesOf", () => {
  it("works the old file back from the new one and the hunks", () => {
    const next = ["a", "b", "C1", "C2", "d", "e", "f", "G", "h"];
    expect(oldLinesOf(next, file.hunks)).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
  });

  it("handles a hunk that only removes, and lines after the last hunk", () => {
    // Old: a x y b c. New: a b c.
    const hunk: DiffHunk = {
      oldStart: 1,
      oldLines: 4,
      newStart: 1,
      newLines: 2,
      section: "",
      lines: [context(1, 1, "a"), del(2, "x"), del(3, "y"), context(4, 2, "b")],
    };
    expect(oldLinesOf(["a", "b", "c"], [hunk])).toEqual(["a", "x", "y", "b", "c"]);
    // A hunk with no new lines at all names the line before it.
    const gone: DiffHunk = {
      oldStart: 2,
      oldLines: 1,
      newStart: 1,
      newLines: 0,
      section: "",
      lines: [del(2, "x")],
    };
    expect(oldLinesOf(["a", "b"], [gone])).toEqual(["a", "x", "b"]);
  });
});

describe("rowAbove", () => {
  it("is the context line before", () => {
    expect(rowAbove(file, 5, "unified")).toEqual({ side: "additions", lineNumber: 4 });
    expect(rowAbove(file, 2, "split")).toEqual({ side: "additions", lineNumber: 1 });
  });

  it("is the added line before, inside a run of added lines", () => {
    expect(rowAbove(file, 4, "unified")).toEqual({ side: "additions", lineNumber: 3 });
    expect(rowAbove(file, 4, "split")).toEqual({ side: "additions", lineNumber: 3 });
  });

  it("is the last removed line in a unified diff, and the line before the removals in a split one", () => {
    expect(rowAbove(file, 3, "unified")).toEqual({ side: "deletions", lineNumber: 3 });
    expect(rowAbove(file, 3, "split")).toEqual({ side: "additions", lineNumber: 2 });
  });

  it("is above the file for the first line of the first hunk, and the line itself in a later one", () => {
    expect(rowAbove(file, 1, "unified")).toEqual({ side: "additions", lineNumber: 0 });
    expect(rowAbove(file, 7, "unified")).toEqual({ side: "additions", lineNumber: 7 });
  });

  it("is nothing for a line the diff does not show", () => {
    expect(rowAbove(file, 6, "unified")).toBeNull();
  });
});
