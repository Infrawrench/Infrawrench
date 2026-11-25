/**
 * Blame: for each line of a file, the commit that put it there.
 *
 * The file's lines start out pinned on the commit asked about. Each commit
 * in turn diffs its version against each parent's and passes the lines the
 * parent already had down to it, keeping only the lines it added. A file
 * that is new in a commit is looked for under another name in the parent,
 * so blame follows whole-file renames, as `git blame` does by default.
 */
import { GitError, type ObjectId, type ObjectReader } from "@infrawrench/git-core";
import { isBinary, splitLines } from "./diff/lines";
import { findRenameSource } from "./diff/renames";
import { diffLines } from "./diff/xdiff";
import { Heap } from "./heap";
import type { Limits } from "./limits";
import { type CommitNode, type ObjectCache, cacheOf, splitPath } from "./objects";

export interface BlameOptions {
  /** Commits to examine before the rest is pinned where it stands. Default 10 000. */
  readonly maxCommits?: number;
  /** Stop after this long, checked between commits. */
  readonly maxMillis?: number;
  readonly limits?: Partial<Limits>;
}

/** A run of consecutive lines that one commit is responsible for. */
export interface BlameRange {
  /** 1-based first line in the file being blamed. */
  readonly start: number;
  readonly lines: number;
  readonly commit: ObjectId;
  /** The file's name in that commit, which differs from the one asked for after a rename. */
  readonly path: string;
  /** 1-based first line in that commit's version of the file. */
  readonly originalStart: number;
  /**
   * False when the walk ran out of budget before it could look past this
   * commit: the lines are at least this old, and may be older.
   */
  readonly settled: boolean;
}

export interface BlameResult {
  /** In line order, covering every line once. Empty for a binary or too-large file. */
  readonly ranges: BlameRange[];
  readonly lineCount: number;
  readonly binary: boolean;
  readonly tooLarge: boolean;
  /** True when every range is settled. */
  readonly complete: boolean;
  readonly walked: number;
}

/** Lines of the final file that a suspect is still held responsible for. */
interface Span {
  /** 0-based in the final file. */
  final: number;
  /** 0-based in the suspect's version. */
  at: number;
  count: number;
}

interface Suspect {
  readonly node: CommitNode;
  readonly path: string;
  readonly blob: ObjectId;
  spans: Span[];
}

function key(commit: ObjectId, path: string): string {
  return `${commit}\0${path}`;
}

/**
 * Splits spans by a diff between the parent's file and the suspect's:
 * lines the parent has go to `passed` with their line numbers there, lines
 * the suspect added stay in `kept`.
 */
function passSpans(
  spans: readonly Span[],
  added: Uint8Array,
  toParent: Int32Array,
  passed: Span[],
  kept: Span[],
): void {
  for (const span of spans) {
    let i = 0;
    while (i < span.count) {
      const line = span.at + i;
      const mine = added[line] === 1;
      let run = 1;
      if (mine) {
        while (i + run < span.count && added[line + run] === 1) run++;
        kept.push({ final: span.final + i, at: line, count: run });
      } else {
        while (
          i + run < span.count &&
          added[line + run] !== 1 &&
          toParent[line + run] === toParent[line]! + run
        ) {
          run++;
        }
        passed.push({ final: span.final + i, at: toParent[line]!, count: run });
      }
      i += run;
    }
  }
}

export async function blame(
  reader: ObjectReader,
  commit: ObjectId,
  path: string,
  options: BlameOptions = {},
): Promise<BlameResult> {
  const cache: ObjectCache = cacheOf(reader, options.limits);
  const maxCommits = options.maxCommits ?? 10_000;
  const deadline = options.maxMillis === undefined ? null : Date.now() + options.maxMillis;
  const startNode = await cache.node(commit);
  const cleanPath = splitPath(path).join("/");
  const entry = await cache.entryAt(startNode.tree, splitPath(path));
  if (entry === null || entry.mode === "040000" || entry.mode === "160000") {
    throw new GitError("missing-object", `no file at ${JSON.stringify(cleanPath)} in ${commit}`);
  }
  const data = await cache.blob(entry.oid);
  const none = (flags: { binary?: boolean; tooLarge?: boolean }): BlameResult => ({
    ranges: [],
    lineCount: 0,
    binary: flags.binary === true,
    tooLarge: flags.tooLarge === true,
    complete: true,
    walked: 0,
  });
  if (data.length > cache.limits.maxTextBytes) return none({ tooLarge: true });
  if (isBinary(data)) return none({ binary: true });
  const lineCount = splitLines(data).count;
  if (lineCount > cache.limits.maxTextLines) return none({ tooLarge: true });

  const suspects = new Map<string, Suspect>();
  const queue = new Heap<Suspect>((a, b) => a.node.time > b.node.time);
  const suspect = (node: CommitNode, suspectPath: string, blob: ObjectId): Suspect => {
    const id = key(node.oid, suspectPath);
    let found = suspects.get(id);
    if (!found) {
      found = { node, path: suspectPath, blob, spans: [] };
      suspects.set(id, found);
      queue.push(found);
    }
    return found;
  };
  if (lineCount > 0) {
    suspect(startNode, cleanPath, entry.oid).spans.push({ final: 0, at: 0, count: lineCount });
  }

  const ranges: BlameRange[] = [];
  const settle = (who: Suspect, spans: readonly Span[], settled: boolean): void => {
    for (const span of spans) {
      ranges.push({
        start: span.final + 1,
        lines: span.count,
        commit: who.node.oid,
        path: who.path,
        originalStart: span.at + 1,
        settled,
      });
    }
  };

  let walked = 0;
  let complete = true;
  while (queue.size > 0) {
    const current = queue.pop()!;
    suspects.delete(key(current.node.oid, current.path));
    if (current.spans.length === 0) continue;
    if (walked >= maxCommits || (deadline !== null && Date.now() >= deadline)) {
      complete = false;
      settle(current, current.spans, false);
      continue;
    }
    walked++;

    // Where the file is in each parent: under the same name, or failing that under the name it was renamed from.
    const parts = splitPath(current.path);
    const origins: Array<{ node: CommitNode; path: string; blob: ObjectId } | null> = [];
    let whole: { node: CommitNode; path: string; blob: ObjectId } | null = null;
    for (const parentOid of current.node.parents) {
      const parent = await cache.node(parentOid);
      const there = await cache.entryAt(parent.tree, parts);
      if (there === null || there.mode === "040000" || there.mode === "160000") {
        origins.push(null);
        continue;
      }
      const origin = { node: parent, path: current.path, blob: there.oid };
      origins.push(origin);
      if (there.oid === current.blob) {
        whole = origin;
        break;
      }
    }
    if (whole === null) {
      for (let p = 0; p < current.node.parents.length; p++) {
        if (origins.length > p && origins[p] !== null) continue;
        const parent = await cache.node(current.node.parents[p]!);
        const source = await findRenameSource(cache, parent.tree, current.node.tree, current.path);
        const origin = source ? { node: parent, path: source.path, blob: source.entry.oid } : null;
        origins[p] = origin;
        if (origin && origin.blob === current.blob) {
          whole = origin;
          break;
        }
      }
    }
    if (whole !== null) {
      // Identical in a parent: nothing here is this commit's doing.
      suspect(whole.node, whole.path, whole.blob).spans.push(...current.spans);
      continue;
    }

    let remaining = current.spans;
    const tried = new Set<ObjectId>();
    let mine: ReturnType<typeof splitLines> | null = null;
    for (const origin of origins) {
      if (!origin || remaining.length === 0) continue;
      // Two parents with the same content would only repeat the same diff.
      if (tried.has(origin.blob)) continue;
      tried.add(origin.blob);
      const parentData = await cache.blob(origin.blob);
      if (parentData.length > cache.limits.maxTextBytes || isBinary(parentData)) continue;
      mine ??= splitLines(await cache.blob(current.blob));
      const theirs = splitLines(parentData);
      const { added, removed } = diffLines(theirs, mine);
      const toParent = new Int32Array(mine.count);
      for (let i = 0, j = 0; i < mine.count; i++) {
        if (added[i] === 1) continue;
        while (removed[j] === 1) j++;
        toParent[i] = j++;
      }
      const passed: Span[] = [];
      const kept: Span[] = [];
      passSpans(remaining, added, toParent, passed, kept);
      if (passed.length > 0) suspect(origin.node, origin.path, origin.blob).spans.push(...passed);
      remaining = kept;
    }
    settle(current, remaining, true);
  }

  ranges.sort((a, b) => a.start - b.start);
  // Neighbouring runs from the same commit that are also neighbours there read as one.
  const joined: BlameRange[] = [];
  for (const range of ranges) {
    const last = joined[joined.length - 1];
    if (
      last &&
      last.commit === range.commit &&
      last.path === range.path &&
      last.settled === range.settled &&
      last.start + last.lines === range.start &&
      last.originalStart + last.lines === range.originalStart
    ) {
      joined[joined.length - 1] = { ...last, lines: last.lines + range.lines };
    } else joined.push(range);
  }
  return { ranges: joined, lineCount, binary: false, tooLarge: false, complete, walked };
}
