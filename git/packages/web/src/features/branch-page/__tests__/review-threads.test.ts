import { describe, expect, it } from "vitest";
import type { DiffLine, ReviewComment, ReviewThread } from "@infrawrench/git-contract";
import {
  anchorOfLine,
  countThreads,
  describeAnchor,
  extendAnchor,
  fileTree,
  indexThreads,
  startsCollapsed,
  threadsAt,
  threadsPerFile,
} from "../review-threads";

const OID = "a".repeat(40);

const comment = (id: string, at: string, pending = false): ReviewComment => ({
  id,
  reviewId: "r1",
  threadId: id,
  inReplyToId: null,
  author: null,
  body: "",
  pending,
  createdAt: at,
  updatedAt: at,
  edited: false,
  viewerCanEdit: false,
  viewerCanDelete: false,
});

const thread = (id: string, fields: Partial<ReviewThread> = {}): ReviewThread => ({
  id,
  path: "main.tf",
  side: "RIGHT",
  line: 10,
  startLine: null,
  startSide: null,
  commitOid: OID,
  originalCommitOid: OID,
  originalLine: 10,
  originalStartLine: null,
  outdated: false,
  hunk: null,
  resolved: false,
  resolvedBy: null,
  comments: [comment(id, "2026-11-01T10:00:00.000Z")],
  viewerCanResolve: true,
  viewerCanReply: true,
  ...fields,
});

const add = (newLine: number): DiffLine => ({ type: "add", content: "", oldLine: null, newLine });
const del = (oldLine: number): DiffLine => ({
  type: "delete",
  content: "",
  oldLine,
  newLine: null,
});
const context = (oldLine: number, newLine: number): DiffLine => ({
  type: "context",
  content: "",
  oldLine,
  newLine,
});

describe("anchorOfLine", () => {
  it("anchors a deleted line on the old file and anything else on the new one", () => {
    expect(anchorOfLine("a.tf", del(7))).toEqual({ path: "a.tf", side: "LEFT", line: 7 });
    expect(anchorOfLine("a.tf", add(9))).toEqual({ path: "a.tf", side: "RIGHT", line: 9 });
    expect(anchorOfLine("a.tf", context(7, 9))).toEqual({ path: "a.tf", side: "RIGHT", line: 9 });
  });
});

describe("indexThreads and threadsAt", () => {
  const threads = [
    thread("t-right", { line: 10 }),
    thread("t-left", { side: "LEFT", line: 10 }),
    thread("t-other-file", { path: "other.tf", line: 10 }),
    thread("t-outdated", { outdated: true, line: null }),
    thread("t-later", {
      line: 10,
      comments: [comment("t-later", "2026-11-02T10:00:00.000Z")],
    }),
  ];
  const index = indexThreads(threads);
  const ids = (line: DiffLine, path = "main.tf") => threadsAt(index, path, line).map((t) => t.id);

  it("finds a thread under the line of its side only", () => {
    expect(ids(add(10))).toEqual(["t-right", "t-later"]);
    expect(ids(del(10))).toEqual(["t-left"]);
    // A context line is a line of the new file: old-side threads do not land on it.
    expect(ids(context(10, 10))).toEqual(["t-right", "t-later"]);
    expect(ids(context(10, 12))).toEqual([]);
  });

  it("keeps files apart", () => {
    expect(ids(add(10), "other.tf")).toEqual(["t-other-file"]);
    expect(ids(add(10), "missing.tf")).toEqual([]);
  });

  it("leaves outdated threads out of the diff", () => {
    expect([...index.values()].flat().some((t) => t.id === "t-outdated")).toBe(false);
  });

  it("orders the threads on one line oldest first", () => {
    const reversed = indexThreads([...threads].reverse());
    expect(threadsAt(reversed, "main.tf", add(10)).map((t) => t.id)).toEqual([
      "t-right",
      "t-later",
    ]);
  });
});

describe("extendAnchor", () => {
  const at = (line: number, side: "LEFT" | "RIGHT" = "RIGHT", path = "main.tf") => ({
    path,
    side,
    line,
  });

  it("starts at the picked line when nothing is open", () => {
    expect(extendAnchor(null, at(5))).toEqual(at(5));
  });

  it("makes a range whichever end was picked first", () => {
    expect(extendAnchor(at(5), at(9))).toEqual({ ...at(9), startLine: 5 });
    expect(extendAnchor(at(9), at(5))).toEqual({ ...at(9), startLine: 5 });
  });

  it("grows a range it already has", () => {
    expect(extendAnchor({ ...at(9), startLine: 5 }, at(12))).toEqual({ ...at(12), startLine: 5 });
    expect(extendAnchor({ ...at(9), startLine: 5 }, at(2))).toEqual({ ...at(9), startLine: 2 });
  });

  it("is a single line again when both ends are the same", () => {
    expect(extendAnchor(at(5), at(5))).toEqual(at(5));
  });

  it("starts over on another file or the other side", () => {
    expect(extendAnchor(at(5), at(9, "RIGHT", "other.tf"))).toEqual(at(9, "RIGHT", "other.tf"));
    expect(extendAnchor(at(5), at(9, "LEFT"))).toEqual(at(9, "LEFT"));
  });
});

describe("describeAnchor", () => {
  it("names a line, a range, the old side, and an outdated thread", () => {
    expect(describeAnchor({ side: "RIGHT", line: 12 })).toBe("Line 12");
    expect(describeAnchor({ side: "RIGHT", line: 15, startLine: 12 })).toBe("Lines 12 to 15");
    expect(describeAnchor({ side: "RIGHT", line: 12, startLine: 12 })).toBe("Line 12");
    expect(describeAnchor({ side: "LEFT", line: 4 })).toBe("Line 4 (removed)");
    expect(describeAnchor({ side: "RIGHT", line: null })).toBe("Outdated");
  });
});

describe("counts", () => {
  const threads = [
    thread("a"),
    thread("b", { resolved: true }),
    thread("c", { outdated: true, line: null, path: "old.tf" }),
    thread("d", {
      path: "docs.md",
      comments: [
        comment("d", "2026-11-01T10:00:00.000Z", true),
        comment("d2", "2026-11-01T11:00:00.000Z", true),
      ],
    }),
  ];

  it("counts unresolved, outdated and the viewer's pending comments", () => {
    expect(countThreads(threads)).toEqual({ total: 4, unresolved: 3, outdated: 1, pending: 2 });
    expect(countThreads([])).toEqual({ total: 0, unresolved: 0, outdated: 0, pending: 0 });
  });

  it("counts the threads on each file's current diff", () => {
    expect([...threadsPerFile(threads)]).toEqual([
      ["main.tf", 2],
      ["docs.md", 1],
    ]);
  });

  it("starts a settled thread collapsed", () => {
    expect(threads.map(startsCollapsed)).toEqual([false, true, true, false]);
  });
});

describe("fileTree", () => {
  it("nests files under their directories, directories first", () => {
    const tree = fileTree([
      "README.md",
      "modules/network/main.tf",
      "modules/network/variables.tf",
      "modules/cluster/main.tf",
      "docs/peering.md",
    ]);
    expect(tree.map((node) => node.name)).toEqual(["docs", "modules", "README.md"]);
    const modules = tree[1]!;
    expect(modules.children.map((node) => node.name)).toEqual(["cluster", "network"]);
    expect(modules.children[1]!.children.map((node) => node.path)).toEqual([
      "modules/network/main.tf",
      "modules/network/variables.tf",
    ]);
  });

  it("folds a chain of directories with one child into one row", () => {
    const tree = fileTree(["environments/staging/main.tf", "a.tf"]);
    expect(tree[0]).toMatchObject({ name: "environments/staging", path: null });
    expect(tree[0]!.children).toEqual([
      { name: "main.tf", path: "environments/staging/main.tf", children: [] },
    ]);
  });

  it("keeps a file and a directory of the same name apart", () => {
    const tree = fileTree(["docs", "docs/a.md"]);
    expect(tree).toEqual([
      { name: "docs", path: null, children: [{ name: "a.md", path: "docs/a.md", children: [] }] },
      { name: "docs", path: "docs", children: [] },
    ]);
  });
});
