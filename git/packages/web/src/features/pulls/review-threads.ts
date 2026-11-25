/**
 * Review threads against a diff: which line of which file a thread sits
 * under, the anchor a new comment on a line (or a range) is sent with, and
 * the counts the page's buttons show.
 */
import type { DiffLine, ReviewThread } from "@infrawrench/git-contract";
import type { DiffSide } from "@infrawrench/git-contract";

export interface LineAnchor {
  readonly path: string;
  readonly side: DiffSide;
  readonly line: number;
  /** The first line of a range; absent for a single line. */
  readonly startLine?: number;
}

/**
 * Where a diff line is anchored: a deleted line on the old file (`LEFT`),
 * anything else on the new one (`RIGHT`).
 */
export function anchorOfLine(path: string, line: DiffLine): LineAnchor | null {
  if (line.type === "delete") {
    return line.oldLine === null ? null : { path, side: "LEFT", line: line.oldLine };
  }
  return line.newLine === null ? null : { path, side: "RIGHT", line: line.newLine };
}

const key = (path: string, side: DiffSide, line: number): string => `${side}:${line}:${path}`;

export type ThreadIndex = ReadonlyMap<string, ReadonlyArray<ReviewThread>>;

/** The threads that still sit on a line of the current diff, by that line. */
export function indexThreads(threads: ReadonlyArray<ReviewThread>): ThreadIndex {
  const index = new Map<string, ReviewThread[]>();
  for (const thread of threads) {
    if (thread.outdated || thread.line === null) continue;
    const at = key(thread.path, thread.side, thread.line);
    const list = index.get(at);
    if (list) list.push(thread);
    else index.set(at, [thread]);
  }
  for (const list of index.values()) {
    list.sort((a, b) =>
      (a.comments[0]?.createdAt ?? "").localeCompare(b.comments[0]?.createdAt ?? ""),
    );
  }
  return index;
}

/** The threads under one line of a file's diff. */
export function threadsAt(
  index: ThreadIndex,
  path: string,
  line: DiffLine,
): ReadonlyArray<ReviewThread> {
  const anchor = anchorOfLine(path, line);
  return anchor === null ? [] : (index.get(key(anchor.path, anchor.side, anchor.line)) ?? []);
}

/**
 * The anchor after a second line is picked while a comment box is open: the
 * two lines become a range when they are in the same file and on the same
 * side, whichever was picked first. Otherwise the new line replaces the old.
 */
export function extendAnchor(current: LineAnchor | null, picked: LineAnchor): LineAnchor {
  if (current === null || current.path !== picked.path || current.side !== picked.side) {
    return picked;
  }
  const from = Math.min(current.startLine ?? current.line, picked.line);
  const to = Math.max(current.line, picked.line);
  return from === to
    ? { path: picked.path, side: picked.side, line: to }
    : { path: picked.path, side: picked.side, line: to, startLine: from };
}

/** `Line 12` or `Lines 12 to 15`, with the side named when it is the old file. */
export function describeAnchor(anchor: {
  readonly side: DiffSide;
  readonly line: number | null;
  readonly startLine?: number | null | undefined;
}): string {
  if (anchor.line === null) return "Outdated";
  const range =
    anchor.startLine !== undefined && anchor.startLine !== null && anchor.startLine !== anchor.line
      ? `Lines ${anchor.startLine} to ${anchor.line}`
      : `Line ${anchor.line}`;
  return anchor.side === "LEFT" ? `${range} (removed)` : range;
}

export interface ThreadCounts {
  readonly total: number;
  readonly unresolved: number;
  readonly outdated: number;
  /** Comments of the viewer's own unsubmitted review. */
  readonly pending: number;
}

export function countThreads(threads: ReadonlyArray<ReviewThread>): ThreadCounts {
  let unresolved = 0;
  let outdated = 0;
  let pending = 0;
  for (const thread of threads) {
    if (!thread.resolved) unresolved++;
    if (thread.outdated) outdated++;
    pending += thread.comments.filter((comment) => comment.pending).length;
  }
  return { total: threads.length, unresolved, outdated, pending };
}

/** How many threads each file has, for the file list beside the diff. */
export function threadsPerFile(threads: ReadonlyArray<ReviewThread>): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const thread of threads) {
    if (thread.outdated) continue;
    counts.set(thread.path, (counts.get(thread.path) ?? 0) + 1);
  }
  return counts;
}

/** A thread starts collapsed once it is settled: resolved, or on lines that have since changed. */
export const startsCollapsed = (thread: ReviewThread): boolean =>
  thread.resolved || thread.outdated;

export interface FileNode {
  readonly name: string;
  /** The full path for a file; null for a directory. */
  readonly path: string | null;
  readonly children: FileNode[];
}

/**
 * Paths as a tree for the file list, directories first, with a chain of
 * single-child directories folded into one row (`modules/network`).
 */
export function fileTree(paths: ReadonlyArray<string>): FileNode[] {
  const root: FileNode = { name: "", path: null, children: [] };
  for (const path of paths) {
    const parts = path.split("/");
    let node = root;
    parts.forEach((part, index) => {
      const last = index === parts.length - 1;
      let child = node.children.find(
        (item) => item.name === part && (item.path === null) === !last,
      );
      if (!child) {
        child = { name: part, path: last ? path : null, children: [] };
        node.children.push(child);
      }
      node = child;
    });
  }
  const order = (a: FileNode, b: FileNode): number =>
    Number(a.path !== null) - Number(b.path !== null) || a.name.localeCompare(b.name);
  const fold = (node: FileNode): FileNode => {
    let current = node;
    while (
      current.path === null &&
      current.children.length === 1 &&
      current.children[0]!.path === null
    ) {
      const only = current.children[0]!;
      current = { name: `${current.name}/${only.name}`, path: null, children: only.children };
    }
    return { ...current, children: current.children.map(fold).sort(order) };
  };
  return root.children.map(fold).sort(order);
}
