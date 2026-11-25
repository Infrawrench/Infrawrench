/**
 * The diff a page renders: changed files, each with its hunks and numbered
 * lines. The same computation feeds the patch text (`patch.ts`), which is
 * why a file's diff exists first in a raw form that still points at bytes.
 */
import { type ObjectId, type ObjectReader, encodeText } from "@infrawrench/git-core";
import type { Limits } from "../limits";
import { type EntryRef, type ObjectCache, cacheOf } from "../objects";
import { type HunkOptions, type HunkRange, buildHunks, hunkHeader, hunkLines } from "./hunks";
import { type Lines, hasNewline, isBinary, lineText, splitLines } from "./lines";
import { type FileChange, type RenameOptions, detectRenames, plainChanges } from "./renames";
import { diffTreeEntries } from "./tree-diff";
import { type LineDiffOptions, diffLines } from "./xdiff";

export interface DiffOptions extends LineDiffOptions, HunkOptions, RenameOptions {
  /** Detect renames. On by default, as in git. */
  readonly renames?: boolean;
  readonly limits?: Partial<Limits>;
}

/** A file's diff before it is rendered: ranges over the two files' lines. */
export interface RawFileDiff {
  readonly change: FileChange;
  /** One side has a NUL in its first 8000 bytes; there are no hunks. */
  readonly binary: boolean;
  /** One side is over the text limit; there are no hunks. */
  readonly tooLarge: boolean;
  readonly oldLines: Lines;
  readonly newLines: Lines;
  readonly hunks: readonly HunkRange[];
  readonly additions: number;
  readonly deletions: number;
}

export interface DiffLine {
  readonly kind: "context" | "add" | "delete";
  /** 1-based line numbers; null on the side the line is not on. */
  readonly oldNumber: number | null;
  readonly newNumber: number | null;
  /** The line without its newline, as UTF-8 with replacement characters. */
  readonly text: string;
  /** Set on a last line that has no newline (`\ No newline at end of file`). */
  readonly noNewline?: true;
}

export interface DiffHunk {
  /** 1-based, as in the `@@` header. */
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly header: string;
  readonly lines: readonly DiffLine[];
}

export interface FileDiff extends FileChange {
  readonly binary: boolean;
  readonly tooLarge: boolean;
  /** The call's file or line budget ran out before this file; it is listed without its content. */
  readonly skipped: boolean;
  readonly additions: number;
  readonly deletions: number;
  readonly hunks: readonly DiffHunk[];
}

export interface DiffResult {
  readonly files: readonly FileDiff[];
  readonly additions: number;
  readonly deletions: number;
  /** More paths differ than the limit lists. */
  readonly truncated: boolean;
}

const NO_LINES: Lines = splitLines(new Uint8Array(0));

/** What a side of a file diff is compared as. A submodule is one line naming its commit, as git shows it. */
async function contentOf(cache: ObjectCache, entry: EntryRef | null): Promise<Uint8Array> {
  if (entry === null) return new Uint8Array(0);
  if (entry.mode === "160000") return encodeText(`Subproject commit ${entry.oid}\n`);
  return cache.blob(entry.oid);
}

/** Diffs one changed file. */
export async function diffFile(
  reader: ObjectReader,
  change: FileChange,
  options: DiffOptions = {},
): Promise<RawFileDiff> {
  const cache = cacheOf(reader, options.limits);
  const empty = (flags: { binary?: boolean; tooLarge?: boolean }): RawFileDiff => ({
    change,
    binary: flags.binary === true,
    tooLarge: flags.tooLarge === true,
    oldLines: NO_LINES,
    newLines: NO_LINES,
    hunks: [],
    additions: 0,
    deletions: 0,
  });
  // A pure rename or a change of mode alone has nothing to compare.
  if (change.old !== null && change.new !== null && change.old.oid === change.new.oid) {
    return empty({});
  }
  const oldData = await contentOf(cache, change.old);
  const newData = await contentOf(cache, change.new);
  const limit = cache.limits.maxTextBytes;
  if (oldData.length > limit || newData.length > limit) return empty({ tooLarge: true });
  if (isBinary(oldData) || isBinary(newData)) return empty({ binary: true });
  const oldLines = splitLines(oldData);
  const newLines = splitLines(newData);
  if (oldLines.count > cache.limits.maxTextLines || newLines.count > cache.limits.maxTextLines) {
    return empty({ tooLarge: true });
  }
  const { changes } = diffLines(oldLines, newLines, options);
  let additions = 0;
  let deletions = 0;
  for (const item of changes) {
    deletions += item.chg1;
    additions += item.chg2;
  }
  return {
    change,
    binary: false,
    tooLarge: false,
    oldLines,
    newLines,
    hunks: buildHunks(oldLines, newLines, changes, options),
    additions,
    deletions,
  };
}

/** A raw file diff as the lines a page shows. */
export function renderFileDiff(raw: RawFileDiff, skipped = false): FileDiff {
  const hunks: DiffHunk[] = raw.hunks.map((hunk) => {
    const lines: DiffLine[] = [];
    for (const line of hunkLines(hunk)) {
      const fromOld = line.kind === "delete";
      const source = fromOld ? raw.oldLines : raw.newLines;
      const index = fromOld ? line.oldIndex : line.newIndex;
      const entry: DiffLine = {
        kind: line.kind,
        oldNumber: line.oldIndex < 0 ? null : line.oldIndex + 1,
        newNumber: line.newIndex < 0 ? null : line.newIndex + 1,
        text: lineText(source, index),
      };
      lines.push(hasNewline(source, index) ? entry : { ...entry, noNewline: true });
    }
    return {
      oldStart: hunk.oldLines === 0 ? hunk.oldStart : hunk.oldStart + 1,
      oldLines: hunk.oldLines,
      newStart: hunk.newLines === 0 ? hunk.newStart : hunk.newStart + 1,
      newLines: hunk.newLines,
      header: hunkHeader(hunk),
      lines,
    };
  });
  return {
    ...raw.change,
    binary: raw.binary,
    tooLarge: raw.tooLarge,
    skipped,
    additions: raw.additions,
    deletions: raw.deletions,
    hunks,
  };
}

/** The changed files between two trees (`git diff --name-status -M`), without their content. */
export async function diffTreeFiles(
  reader: ObjectReader,
  oldTree: ObjectId | null,
  newTree: ObjectId | null,
  options: DiffOptions = {},
): Promise<{ changes: FileChange[]; truncated: boolean }> {
  const cache = cacheOf(reader, options.limits);
  const { changes, truncated } = await diffTreeEntries(cache, oldTree, newTree);
  // A list cut short would pair the wrong files, so renames are only looked for in a whole one.
  const detect = options.renames !== false && !truncated;
  return {
    changes: detect ? await detectRenames(cache, changes, options) : plainChanges(changes),
    truncated,
  };
}

/** The whole diff between two trees. A null tree is the empty tree. */
export async function diffTrees(
  reader: ObjectReader,
  oldTree: ObjectId | null,
  newTree: ObjectId | null,
  options: DiffOptions = {},
): Promise<DiffResult> {
  const cache = cacheOf(reader, options.limits);
  const { changes, truncated } = await diffTreeFiles(cache, oldTree, newTree, options);
  const files: FileDiff[] = [];
  let additions = 0;
  let deletions = 0;
  let lines = 0;
  for (const change of changes) {
    if (files.length >= cache.limits.maxDiffFiles || lines >= cache.limits.maxDiffLines) {
      files.push({
        ...change,
        binary: false,
        tooLarge: false,
        skipped: true,
        additions: 0,
        deletions: 0,
        hunks: [],
      });
      continue;
    }
    const file = renderFileDiff(await diffFile(cache, change, options));
    for (const hunk of file.hunks) lines += hunk.lines.length;
    additions += file.additions;
    deletions += file.deletions;
    files.push(file);
  }
  return { files, additions, deletions, truncated };
}

/** The diff a commit page shows: against its first parent, or against nothing for a root commit. */
export async function diffCommit(
  reader: ObjectReader,
  commit: ObjectId,
  options: DiffOptions = {},
): Promise<DiffResult> {
  const cache = cacheOf(reader, options.limits);
  const node = await cache.node(commit);
  const parent = node.parents[0];
  return diffTrees(cache, parent ? (await cache.node(parent)).tree : null, node.tree, options);
}
