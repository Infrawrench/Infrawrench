/** Commits with what they changed, comparisons, and the diffs of both. */
import type { Diff, DiffFile, DiffHunk, ResolvedRef } from "@infrawrench/git-contract";
import { GitError, type ObjectId } from "@infrawrench/git-core";
import {
  type FileChange,
  type DiffOptions as OpsDiffOptions,
  aheadBehind,
  commitsBetween as opsCommitsBetween,
  diffFile,
  diffTreeFiles,
  mergeBase,
  mergeCommits,
  renderFileDiff,
} from "@infrawrench/git-ops";
import {
  type CompareInput,
  type DiffAnchorInput,
  type DiffOptions,
  type ReaderCommitDetail,
  type ReaderComparison,
  RepoReaderError,
} from "../reader";
import {
  BRANCH,
  type ReaderContext,
  type Session,
  TAG,
  boundedCache,
  commitShape,
  fileSummary,
  hunkShape,
  offsetOf,
  openSession,
  resolve,
  resolveCommitId,
  summaryOf,
} from "./session";

/** What a single file asked for by `path` may be: larger than a page's files, still bounded. */
const SINGLE_FILE_LIMITS = { maxTextBytes: 4 * 1024 * 1024, maxTextLines: 400_000 };

const ANCHOR_CONTEXT = 3;
/** Files of a diff whose lines are counted at once. */
const COUNT_AT_ONCE = 12;

interface Counts {
  readonly binary: boolean;
  readonly tooLarge: boolean;
  readonly additions: number;
  readonly deletions: number;
}

interface DiffSummary {
  readonly changes: readonly FileChange[];
  /** Counts of the first `diffFiles` changes; the rest were not read. */
  readonly counts: readonly Counts[];
  readonly stats: Diff["stats"];
  readonly truncated: boolean;
}

const lineOptions = (options: {
  readonly context?: number | undefined;
  readonly whitespace?: "show" | "ignore" | undefined;
}): OpsDiffOptions => ({
  context: options.context ?? 3,
  ignoreWhitespace: options.whitespace === "ignore" ? "all" : "none",
});

/** A history too large for a bounded walk is a refusal, not a failure. */
const tooLarge = (error: unknown): never => {
  if (error instanceof GitError && error.code === "limit") {
    throw new RepoReaderError("too_large", error.message);
  }
  throw error;
};

/**
 * The changed files between two trees with their line counts. Kept for a
 * while by the pair of trees: a commit page asks for it with the commit and
 * again with each page of its diff.
 */
async function summarise(
  session: Session,
  oldTree: ObjectId | null,
  newTree: ObjectId,
  whitespace: "show" | "ignore" | undefined,
): Promise<DiffSummary> {
  const { state, limits } = session.cx;
  const key = `${oldTree ?? ""}:${newTree}:${whitespace ?? "show"}`;
  const known = state.diffs.get(key) as DiffSummary | undefined;
  if (known) return known;
  const { changes, truncated } = await diffTreeFiles(session.cache, oldTree, newTree);
  const options = lineOptions({ whitespace });
  // Several files at a time: each is two blobs read from wherever they lie in the packs, and
  // the reads are what takes the time. Order is kept, so what is counted is a prefix of the list.
  const wanted = Math.min(changes.length, limits.diffFiles);
  const deadline = Date.now() + limits.diffCountMillis;
  const slots: Array<Counts | undefined> = new Array<Counts | undefined>(wanted);
  // The deadline only moves across reads, and blobs already in memory are not reads: three
  // hundred files that pair the same few blobs would be diffed with the clock standing still.
  // So the lines compared are counted too, and a pair of blobs is diffed once.
  let compared = 0;
  const pairs = new Map<string, Promise<Counts>>();
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < wanted && Date.now() < deadline && compared < limits.diffCountLines) {
      const index = next++;
      const change = changes[index]!;
      const pair = `${change.old?.oid ?? ""}:${change.new?.oid ?? ""}:${change.old?.mode ?? ""}:${change.new?.mode ?? ""}`;
      let counted = pairs.get(pair);
      if (!counted) {
        counted = diffFile(session.cache, change, options).then((raw) => {
          compared += raw.oldLines.count + raw.newLines.count;
          return {
            binary: raw.binary,
            tooLarge: raw.tooLarge,
            additions: raw.additions,
            deletions: raw.deletions,
          };
        });
        pairs.set(pair, counted);
      }
      slots[index] = await counted;
    }
  };
  await Promise.all(Array.from({ length: Math.min(COUNT_AT_ONCE, wanted) }, worker));
  const counts: Counts[] = [];
  let additions = 0;
  let deletions = 0;
  for (const slot of slots) {
    if (slot === undefined) break;
    counts.push(slot);
    additions += slot.additions;
    deletions += slot.deletions;
  }
  const summary: DiffSummary = {
    changes,
    counts,
    stats: { filesChanged: changes.length, additions, deletions },
    truncated: truncated || changes.length > counts.length,
  };
  state.diffs.set(key, summary);
  return summary;
}

async function renderFile(
  session: Session,
  change: FileChange,
  options: OpsDiffOptions,
  single: boolean,
): Promise<{ readonly file: DiffFile; readonly compared: number; readonly bytes: number }> {
  const cache = single ? boundedCache(session, SINGLE_FILE_LIMITS) : session.cache;
  const raw = await diffFile(cache, change, options);
  const rendered = renderFileDiff(raw);
  let bytes = 0;
  for (const hunk of rendered.hunks) for (const line of hunk.lines) bytes += line.text.length;
  return {
    file: {
      ...fileSummary(change, raw),
      hunks: rendered.hunks.map((hunk, index) => hunkShape(hunk, raw.hunks[index]?.section ?? "")),
      tooLarge: raw.tooLarge,
    },
    compared: raw.oldLines.count + raw.newLines.count,
    bytes,
  };
}

/** One page of a diff between two trees, in path order. */
export async function diffPage(
  session: Session,
  baseOid: ObjectId | null,
  headOid: ObjectId,
  oldTree: ObjectId | null,
  newTree: ObjectId,
  options: DiffOptions,
): Promise<Diff> {
  const summary = await summarise(session, oldTree, newTree, options.whitespace);
  const rendering = lineOptions(options);
  const answer = (files: DiffFile[], nextCursor: string | null): Diff => ({
    baseOid,
    headOid,
    stats: summary.stats,
    files,
    nextCursor,
  });
  if (options.path !== undefined) {
    const change = summary.changes.find(
      (each) => each.newPath === options.path || each.oldPath === options.path,
    );
    return answer(change ? [(await renderFile(session, change, rendering, true)).file] : [], null);
  }
  const offset = offsetOf(options.cursor);
  const files: DiffFile[] = [];
  const { limits } = session.cx;
  let lines = 0;
  // A page is bounded by its text as well as its lines (one line can be a megabyte), and by
  // the lines it compares, which cost the time whether or not they come out as hunks.
  let bytes = 0;
  let compared = 0;
  for (
    let index = offset;
    index < Math.min(summary.changes.length, offset + options.limit);
    index++
  ) {
    const change = summary.changes[index]!;
    if (
      lines >= limits.diffPageLines ||
      bytes >= limits.diffPageBytes ||
      compared >= limits.diffPageCompared
    ) {
      // The page is full: listed with its counts, its hunks a request of its own away.
      files.push({
        ...fileSummary(change, summary.counts[index] ?? null),
        hunks: [],
        tooLarge: true,
      });
      continue;
    }
    const rendered = await renderFile(session, change, rendering, false);
    for (const hunk of rendered.file.hunks) lines += hunk.lines.length;
    bytes += rendered.bytes;
    compared += rendered.compared;
    files.push(rendered.file);
  }
  const next = offset + options.limit;
  return answer(files, next < summary.changes.length ? String(next) : null);
}

export const treeOf = async (session: Session, commit: ObjectId): Promise<ObjectId> => {
  try {
    return (await session.cache.node(commit)).tree;
  } catch (error) {
    if (error instanceof GitError) {
      throw new RepoReaderError("ref_not_found", `There is no commit ${commit}`);
    }
    throw error;
  }
};

async function commitById(session: Session, sha: string): Promise<ObjectId> {
  const oid = await resolveCommitId(session, sha);
  if (!oid) throw new RepoReaderError("ref_not_found", `There is no commit ${sha}`);
  return oid;
}

export async function commit(cx: ReaderContext, sha: string): Promise<ReaderCommitDetail> {
  const session = await openSession(cx);
  const oid = await commitById(session, sha);
  const found = await session.cache.commit(oid);
  const parent = found.parents[0];
  const summary = await summarise(
    session,
    parent ? await treeOf(session, parent) : null,
    found.tree,
    undefined,
  );
  return {
    commit: commitShape(oid, found),
    stats: summary.stats,
    files: summary.counts.map((counts, index) => fileSummary(summary.changes[index]!, counts)),
    filesTruncated: summary.truncated,
    branches: session.refs
      .filter((ref) => ref.name.startsWith(BRANCH) && ref.oid === oid)
      .map((ref) => ref.name.slice(BRANCH.length)),
    tags: session.refs
      .filter((ref) => ref.name.startsWith(TAG) && (ref.peeled ?? ref.oid) === oid)
      .map((ref) => ref.name.slice(TAG.length)),
  };
}

export async function commitDiff(
  cx: ReaderContext,
  sha: string,
  options: DiffOptions,
): Promise<Diff> {
  const session = await openSession(cx);
  const oid = await commitById(session, sha);
  const node = await session.cache.node(oid);
  const parent = node.parents[0] ?? null;
  return diffPage(
    session,
    parent,
    oid,
    parent ? await treeOf(session, parent) : null,
    node.tree,
    options,
  );
}

/**
 * Resolves a head where it lives and makes sure its commit is in this
 * repository. A head in another repository (a fork, or the parent) is
 * looked up in that repository's refs and its objects are copied in, after
 * which the session is a new one that sees them.
 */
export async function headIn(
  session: Session,
  head: string,
  headRepositoryId: string | undefined,
): Promise<{ readonly ref: ResolvedRef; readonly session: Session }> {
  const { cx } = session;
  if (headRepositoryId === undefined || headRepositoryId === cx.locator.id) {
    return { ref: await resolve(session, head), session };
  }
  const missing = (): RepoReaderError =>
    new RepoReaderError("ref_not_found", `Nothing there is called ${JSON.stringify(head)}`);
  let ref: ResolvedRef;
  // Not `isObjectId`: an id is a string, and its guard would leave nothing for the other branch.
  if (/^[0-9a-f]{40}$/.test(head)) {
    ref = { name: head, kind: "commit", fullName: null, commitOid: head };
  } else {
    const { refs } = await cx.repo.peer(headRepositoryId).listRefs();
    const found = (head.startsWith("refs/") ? [head] : [BRANCH + head, TAG + head])
      .map((name) => refs.find((each) => each.name === name))
      .find((each) => each !== undefined);
    if (!found) throw missing();
    const isBranch = found.name.startsWith(BRANCH);
    const isTag = found.name.startsWith(TAG);
    const kind = isBranch ? "branch" : isTag ? "tag" : null;
    const commitOid = found.peeled ?? found.oid;
    ref =
      kind === null
        ? { name: commitOid, kind: "commit", fullName: null, commitOid }
        : {
            name: found.name.slice((kind === "branch" ? BRANCH : TAG).length),
            kind,
            fullName: found.name,
            commitOid,
          };
  }
  if (!(await cx.repo.importFrom(headRepositoryId, [ref.commitOid]))) throw missing();
  return { ref, session: await openSession(cx) };
}

/** Both sides of a comparison, in one session that has both. */
async function sides(cx: ReaderContext, input: CompareInput) {
  const first = await openSession(cx);
  const base = await resolve(first, input.base);
  const { ref: head, session } = await headIn(first, input.head, input.headRepositoryId);
  let mergeBaseOid: ObjectId | null = null;
  try {
    mergeBaseOid = await mergeBase(session.cache, base.commitOid, head.commitOid);
  } catch (error) {
    tooLarge(error);
  }
  return { session, base, head, mergeBaseOid };
}

export interface Trial {
  readonly conflictFiles: string[];
  readonly mergeBaseOid: ObjectId | null;
}

/**
 * A merge of `head` into `base` with nothing written, kept by the pair of
 * commits. A merge too large to try is kept too, as its refusal: every view
 * of a pull request asks, and the work before the limit was reached is the
 * same each time.
 */
export async function trialMerge(
  session: Session,
  baseOid: ObjectId,
  headOid: ObjectId,
): Promise<Trial> {
  const outcome = await session.cx.state.remember(
    `trial:${baseOid}:${headOid}`,
    async (): Promise<Trial | { readonly refused: string }> => {
      try {
        const merged = await mergeCommits(session.cache, baseOid, headOid);
        return {
          conflictFiles: [...new Set(merged.conflicts.map((conflict) => conflict.path))],
          mergeBaseOid: merged.bases[0] ?? null,
        };
      } catch (error) {
        if (error instanceof GitError && error.code === "limit") return { refused: error.message };
        throw error;
      }
    },
  );
  if ("refused" in outcome) throw new RepoReaderError("too_large", outcome.refused);
  return outcome;
}

export async function compare(cx: ReaderContext, input: CompareInput): Promise<ReaderComparison> {
  const { session, base, head, mergeBaseOid } = await sides(cx, input);
  let counts = { ahead: 0, behind: 0 };
  try {
    counts = await aheadBehind(session.cache, head.commitOid, base.commitOid);
  } catch (error) {
    tooLarge(error);
  }
  const listed = await opsCommitsBetween(session.cache, base.commitOid, head.commitOid, {
    limit: cx.limits.compareCommits,
  });
  const summary = await summarise(
    session,
    mergeBaseOid ? await treeOf(session, mergeBaseOid) : null,
    await treeOf(session, head.commitOid),
    undefined,
  );
  return {
    base,
    head,
    mergeBaseOid,
    ahead: counts.ahead,
    behind: counts.behind,
    commits: listed.entries.reverse().map((entry) => summaryOf(entry.oid, entry.commit)),
    commitsTruncated: listed.hasMore || listed.truncated,
    stats: summary.stats,
    files: summary.counts.map((each, index) => fileSummary(summary.changes[index]!, each)),
    filesTruncated: summary.truncated,
    mergeable:
      counts.ahead === 0
        ? null
        : (await trialMerge(session, base.commitOid, head.commitOid)).conflictFiles.length === 0,
  };
}

export async function compareDiff(
  cx: ReaderContext,
  input: CompareInput,
  options: DiffOptions,
): Promise<Diff> {
  const { session, head, mergeBaseOid } = await sides(cx, input);
  return diffPage(
    session,
    mergeBaseOid,
    head.commitOid,
    mergeBaseOid ? await treeOf(session, mergeBaseOid) : null,
    await treeOf(session, head.commitOid),
    options,
  );
}

export async function diffAnchor(
  cx: ReaderContext,
  input: DiffAnchorInput,
): Promise<DiffHunk | null> {
  let session = await openSession(cx);
  if (input.headRepositoryId !== undefined && input.headRepositoryId !== cx.locator.id) {
    if (!(await cx.repo.importFrom(input.headRepositoryId, [input.headOid]))) {
      throw new RepoReaderError("ref_not_found", "The pull request's head commit is not there");
    }
    session = await openSession(cx);
  }
  const summary = await summarise(
    session,
    await treeOf(session, input.baseOid),
    await treeOf(session, input.headOid),
    undefined,
  );
  const left = input.side === "LEFT";
  const change =
    summary.changes.find((each) => (left ? each.oldPath : each.newPath) === input.path) ??
    summary.changes.find((each) => each.newPath === input.path || each.oldPath === input.path);
  if (!change) return null;
  const { file } = await renderFile(session, change, lineOptions({}), true);
  const first = input.startLine ?? input.line;
  for (const hunk of file.hunks) {
    const numberOf = (index: number): number | null => {
      const line = hunk.lines[index]!;
      return left ? line.oldLine : line.newLine;
    };
    const at: number[] = [];
    for (let wanted = first; wanted <= input.line; wanted++) {
      const index = hunk.lines.findIndex((_, each) => numberOf(each) === wanted);
      if (index < 0) break;
      at.push(index);
    }
    if (at.length !== input.line - first + 1) continue;
    const from = Math.max(0, at[0]! - ANCHOR_CONTEXT);
    const lines = hunk.lines.slice(from, at.at(-1)! + 1);
    const before = hunk.lines.slice(0, from);
    const oldLines = lines.filter((line) => line.oldLine !== null).length;
    const newLines = lines.filter((line) => line.newLine !== null).length;
    return {
      oldStart: hunk.oldStart + before.filter((line) => line.oldLine !== null).length,
      oldLines,
      newStart: hunk.newStart + before.filter((line) => line.newLine !== null).length,
      newLines,
      section: hunk.section,
      lines,
    };
  }
  return null;
}

/** A cache with the bound a long listing walks under, and messages cut to what a list shows. */
export const scanCache = (session: Session) =>
  boundedCache(session, {
    maxCommits: session.cx.limits.logScanCommits,
    maxMessageBytes: session.cx.limits.listedMessageBytes,
  });
