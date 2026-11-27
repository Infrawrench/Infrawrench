/**
 * Three-way merge of trees. Directories that only one side changed are
 * taken whole without being read, so the work follows what the two sides
 * changed in common, not the size of the repository. Files both sides
 * changed are merged as text; renames one side made are followed so that
 * the other side's edits land in the renamed file.
 */
import {
  GitError,
  type ObjectId,
  type ObjectReader,
  type TreeEntry,
  type TreeEntryMode,
} from "@infrawrench/git-core";
import { isBinary } from "../diff/lines";
import { type RenameCandidate, matchRenames } from "../diff/renames";
import { diffTreeEntries, entryKind } from "../diff/tree-diff";
import type { Limits } from "../limits";
import {
  EMPTY_TREE_OID,
  type EntryRef,
  type ObjectCache,
  cacheOf,
  sameEntry,
  splitPath,
} from "../objects";
import { type NewObject, ObjectSink, editTree } from "./sink";
import { type MergeTextOptions, mergeText } from "./text";

export type ConflictKind =
  /** Both sides changed the same lines. The file in the result has conflict markers. */
  | "content"
  /** Both sides added the path with different content. Markers as for `content`. */
  | "add-add"
  /** Both sides changed a binary file. The result keeps ours. */
  | "binary"
  /** Both sides changed a file over the text limit. The result keeps ours. */
  | "too-large"
  /** One side changed the file, the other deleted it. The result keeps the changed file. */
  | "modify-delete"
  /** One side has a file where the other has a directory. The file is in the result as `path~side`. */
  | "file-directory"
  /** The two sides made the path different kinds of thing (file, symlink, submodule). */
  | "distinct-types"
  /** Both sides changed a symlink, or a submodule's commit. The result keeps ours. */
  | "symlink"
  | "submodule"
  /** Both sides changed the file's mode differently. The result keeps ours. */
  | "mode"
  /** One side renamed the file and the other deleted it. The renamed file is in the result. */
  | "rename-delete"
  /** The two sides renamed the file to different names. Both names are in the result. */
  | "rename-rename"
  /** One side renamed a file onto a path the other side added. */
  | "rename-add";

export interface MergeConflict {
  readonly path: string;
  readonly kind: ConflictKind;
  readonly base: EntryRef | null;
  readonly ours: EntryRef | null;
  readonly theirs: EntryRef | null;
}

export interface MergeTreesOptions {
  /** Names for the two sides in conflict markers and in `path~side` names. Default `ours`, `theirs`. */
  readonly ours?: string;
  readonly theirs?: string;
  /** Follow renames. On by default. */
  readonly renames?: boolean;
  /** Least similarity that counts as a rename, 0 to 1. Default 0.5. */
  readonly renameThreshold?: number;
  readonly style?: MergeTextOptions["style"];
  readonly markerSize?: number;
  readonly limits?: Partial<Limits>;
}

export interface MergeTreesResult {
  /**
   * The merged tree. With conflicts it is still a whole tree, holding what
   * the kinds above describe (markers, kept sides), which is what a
   * "conflicts" view shows; it is not something to commit as it is.
   */
  readonly tree: ObjectId;
  readonly conflicts: MergeConflict[];
  /** New blobs and trees, in an order safe to write: blobs and subtrees before the trees that name them. */
  readonly objects: NewObject[];
}

interface Deleted {
  readonly path: string;
  readonly base: EntryRef;
  /** What the other side has at the path: its changed file, or null when it deleted the file too. */
  readonly other: EntryRef | null;
}

interface State {
  readonly cache: ObjectCache;
  readonly sink: ObjectSink;
  readonly options: MergeTreesOptions;
  readonly oursName: string;
  readonly theirsName: string;
  readonly conflicts: Map<string, MergeConflict>;
  readonly deletedByOurs: Deleted[];
  readonly deletedByTheirs: Deleted[];
  /** Directories both sides changed to the same thing, which are taken without being read. */
  readonly changedAlike: Array<{ prefix: string; base: ObjectId; side: ObjectId | null }>;
  /** Bytes of the files read for text merges so far (`maxMergeTextBytes`). */
  textBytes: number;
  /** Directory levels merged so far (`maxDiffTrees`). */
  trees: number;
}

/** Lines as git counts them for a text operation: newlines, plus a last line without one. */
function lineCount(data: Uint8Array): number {
  let count = data.length > 0 && data[data.length - 1] !== 0x0a ? 1 : 0;
  for (let at = data.indexOf(0x0a); at >= 0; at = data.indexOf(0x0a, at + 1)) count++;
  return count;
}

function isTree(entry: EntryRef | null): boolean {
  return entry !== null && entry.mode === "040000";
}

function conflict(
  state: State,
  path: string,
  kind: ConflictKind,
  base: EntryRef | null,
  ours: EntryRef | null,
  theirs: EntryRef | null,
): void {
  state.conflicts.set(path, { path, kind, base, ours, theirs });
}

interface Labels {
  readonly ours: string;
  readonly theirs: string;
}

/** Merges two versions of a regular file, both present and different. */
async function mergeFileEntries(
  state: State,
  path: string,
  base: EntryRef | null,
  ours: EntryRef,
  theirs: EntryRef,
  labels: Labels,
): Promise<EntryRef> {
  const baseFile = base !== null && entryKind(base.mode) === "file" ? base : null;
  let oid: ObjectId;
  let kind: ConflictKind | null = null;
  if (ours.oid === theirs.oid) oid = ours.oid;
  else if (baseFile?.oid === ours.oid) oid = theirs.oid;
  else if (baseFile?.oid === theirs.oid) oid = ours.oid;
  else {
    const { cache, sink, options } = state;
    // Where storage can say a size from its index, a file over the limit is refused unread.
    // So is every file once the merge has read its share of text: the merged blobs are all held
    // until the caller writes them, and both sides can change thousands of large files.
    let oversized = state.textBytes >= cache.limits.maxMergeTextBytes;
    for (const side of [baseFile, ours, theirs]) {
      if (!oversized && side !== null && (await cache.overTextLimit(side.oid))) oversized = true;
    }
    const none = new Uint8Array(0);
    const baseData = baseFile && !oversized ? await cache.blob(baseFile.oid) : none;
    const oursData = oversized ? none : await cache.blob(ours.oid);
    const theirsData = oversized ? none : await cache.blob(theirs.oid);
    state.textBytes += baseData.length + oursData.length + theirsData.length;
    const limit = cache.limits.maxTextBytes;
    const lines = cache.limits.maxTextLines;
    if (
      oversized ||
      baseData.length > limit ||
      oursData.length > limit ||
      theirsData.length > limit ||
      lineCount(baseData) > lines ||
      lineCount(oursData) > lines ||
      lineCount(theirsData) > lines
    ) {
      oid = ours.oid;
      kind = "too-large";
    } else if (isBinary(baseData) || isBinary(oursData) || isBinary(theirsData)) {
      oid = ours.oid;
      kind = "binary";
    } else {
      const merged = mergeText(baseData, oursData, theirsData, {
        ours: labels.ours,
        theirs: labels.theirs,
        ...(options.style !== undefined ? { style: options.style } : {}),
        ...(options.markerSize !== undefined ? { markerSize: options.markerSize } : {}),
      });
      oid = sink.write("blob", merged.data, [ours.oid, theirs.oid, baseFile?.oid ?? null]);
      if (merged.conflicts > 0) kind = baseFile ? "content" : "add-add";
    }
  }
  let mode: TreeEntryMode = ours.mode;
  if (ours.mode !== theirs.mode) {
    if (baseFile !== null && ours.mode === baseFile.mode) mode = theirs.mode;
    else if (baseFile === null || theirs.mode !== baseFile.mode) kind ??= "mode";
  }
  if (kind !== null) conflict(state, path, kind, base, ours, theirs);
  return { mode, oid };
}

/** The name a file takes when a directory has its path: `path~side`, made unique among its neighbours. */
function sideName(name: string, side: string, taken: ReadonlySet<string>): string {
  const base = `${name}~${side.replace(/\//g, "_")}`;
  let candidate = base;
  for (let n = 0; taken.has(candidate); n++) candidate = `${base}_${n}`;
  return candidate;
}

async function mergeLevel(
  state: State,
  prefix: string,
  baseTree: ObjectId | null,
  oursTree: ObjectId | null,
  theirsTree: ObjectId | null,
): Promise<ObjectId | null> {
  const { cache, sink } = state;
  // A partial merge would be a wrong one, so a merge that has to read too many trees is refused.
  if (++state.trees > cache.limits.maxDiffTrees) {
    throw new GitError("limit", `merge reads more than ${cache.limits.maxDiffTrees} trees`);
  }
  const names = new Map<string, [TreeEntry | null, TreeEntry | null, TreeEntry | null]>();
  const load = async (tree: ObjectId | null, slot: 0 | 1 | 2): Promise<void> => {
    if (tree === null) return;
    for (const entry of await cache.tree(tree)) {
      let row = names.get(entry.name);
      if (!row) names.set(entry.name, (row = [null, null, null]));
      row[slot] = entry;
    }
  };
  await load(baseTree, 0);
  await load(oursTree, 1);
  await load(theirsTree, 2);

  const result: TreeEntry[] = [];
  const taken = new Set(names.keys());
  const extras: TreeEntry[] = [];
  const keep = (name: string, source: TreeEntry | null, ref: EntryRef | null): void => {
    if (ref === null) return;
    // The entry as a side had it, when that is what is kept, so an odd stored name or mode survives.
    if (source !== null && source.oid === ref.oid && source.mode === ref.mode) result.push(source);
    else result.push({ name, mode: ref.mode, oid: ref.oid });
  };
  const aside = (name: string, side: string, ref: EntryRef): string => {
    const placed = sideName(name, side, taken);
    taken.add(placed);
    extras.push({ name: placed, mode: ref.mode, oid: ref.oid });
    return placed;
  };

  for (const [name, [o, a, b]] of names) {
    const path = prefix + name;
    if (sameEntry(a, b)) {
      keep(name, a, a);
      // Gone on both sides: if either side renamed it, the rename pass wants to know.
      if (a === null && o !== null && entryKind(o.mode) === "file") {
        state.deletedByOurs.push({ path, base: o, other: null });
        state.deletedByTheirs.push({ path, base: o, other: null });
      }
      // The same goes for files inside a directory both sides changed alike, found later if needed.
      if (isTree(o) && !sameEntry(o, a) && (a === null || isTree(a))) {
        state.changedAlike.push({ prefix: `${path}/`, base: o!.oid, side: a?.oid ?? null });
      }
      continue;
    }
    if (sameEntry(o, a)) {
      keep(name, b, b);
      continue;
    }
    if (sameEntry(o, b)) {
      keep(name, a, a);
      continue;
    }

    const baseDir = isTree(o) ? o!.oid : null;
    if (isTree(a) && isTree(b)) {
      const below = await mergeLevel(state, `${path}/`, baseDir, a!.oid, b!.oid);
      if (below !== null) result.push({ name, mode: "040000", oid: below });
      continue;
    }
    if (isTree(a) || isTree(b)) {
      const oursIsDir = isTree(a);
      const dir = (oursIsDir ? a : b)!;
      const file = oursIsDir ? b : a;
      // The directory against whatever the base had under it; the other side has nothing there.
      const below =
        baseDir === null
          ? dir.oid
          : await mergeLevel(
              state,
              `${path}/`,
              baseDir,
              oursIsDir ? dir.oid : null,
              oursIsDir ? null : dir.oid,
            );
      if (below !== null) result.push({ name, mode: "040000", oid: below });
      if (file === null) continue;
      const baseFile = baseDir === null ? o : null;
      if (baseFile !== null) {
        // The side with the directory deleted the file the other side changed.
        conflict(
          state,
          path,
          "modify-delete",
          baseFile,
          oursIsDir ? null : file,
          oursIsDir ? file : null,
        );
      }
      if (below === null) {
        result.push({ name, mode: file.mode, oid: file.oid });
        continue;
      }
      const placed = aside(name, oursIsDir ? state.theirsName : state.oursName, file);
      state.conflicts.delete(path);
      conflict(
        state,
        prefix + placed,
        "file-directory",
        baseFile,
        oursIsDir ? null : file,
        oursIsDir ? file : null,
      );
      continue;
    }

    // Neither side has a directory here. A directory in the base is gone on both, so it is no base.
    const base = isTree(o) ? null : o;
    if (a === null || b === null) {
      const changed = (a ?? b)!;
      if (base === null) {
        keep(name, a ?? b, changed);
        continue;
      }
      conflict(state, path, "modify-delete", base, a, b);
      if (entryKind(base.mode) === "file") {
        (a === null ? state.deletedByOurs : state.deletedByTheirs).push({
          path,
          base,
          other: changed,
        });
      }
      keep(name, a ?? b, changed);
      continue;
    }
    const kindA = entryKind(a.mode);
    const kindB = entryKind(b.mode);
    if (kindA !== kindB) {
      conflict(state, path, "distinct-types", base, a, b);
      keep(name, a, a);
      aside(name, state.theirsName, b);
      continue;
    }
    if (kindA !== "file") {
      conflict(state, path, kindA === "symlink" ? "symlink" : "submodule", base, a, b);
      keep(name, a, a);
      continue;
    }
    const merged = await mergeFileEntries(state, path, base, a, b, {
      ours: state.oursName,
      theirs: state.theirsName,
    });
    keep(name, sameEntry(merged, a) ? a : sameEntry(merged, b) ? b : null, merged);
  }

  result.push(...extras);
  if (result.length === 0) return null;
  return sink.writeTree(result, [baseTree, oursTree, theirsTree]);
}

type Renames = Map<string, { to: string; entry: EntryRef; record: Deleted }>;

/** The renames one side made among the files it deleted that the other side also touched. */
async function sideRenames(
  state: State,
  baseTree: ObjectId | null,
  sideTree: ObjectId | null,
  deleted: readonly Deleted[],
): Promise<Renames> {
  const renames: Renames = new Map();
  if (deleted.length === 0) return renames;
  const { changes, truncated } = await diffTreeEntries(state.cache, baseTree, sideTree);
  if (truncated) return renames;
  const added: RenameCandidate[] = [];
  for (const change of changes) {
    if (change.old === null && change.new !== null && entryKind(change.new.mode) === "file") {
      added.push({ path: change.path, entry: change.new });
    }
  }
  const matches = await matchRenames(
    state.cache,
    deleted.map((item) => ({ path: item.path, entry: item.base })),
    added,
    {
      minimumScore: Math.round((state.options.renameThreshold ?? 0.5) * 60000),
      copies: false,
      used: deleted.map(() => 0),
    },
  );
  for (const match of matches) {
    const record = deleted[match.source]!;
    const target = added[match.destination]!;
    renames.set(record.path, { to: target.path, entry: target.entry, record });
  }
  return renames;
}

/**
 * Revisits the files one side deleted in the light of renames. A file one
 * side renamed and the other edited becomes one file at the new name with
 * both changes, instead of a deletion conflict and an unrelated new file.
 */
async function applyRenames(
  state: State,
  root: ObjectId,
  baseTree: ObjectId | null,
  oursTree: ObjectId | null,
  theirsTree: ObjectId | null,
): Promise<ObjectId> {
  for (const alike of state.changedAlike) {
    const { changes } = await diffTreeEntries(state.cache, alike.base, alike.side);
    for (const change of changes) {
      if (change.old === null || change.new !== null || entryKind(change.old.mode) !== "file") {
        continue;
      }
      const gone: Deleted = { path: alike.prefix + change.path, base: change.old, other: null };
      state.deletedByOurs.push(gone);
      state.deletedByTheirs.push(gone);
    }
  }
  const byOurs = await sideRenames(state, baseTree, oursTree, state.deletedByOurs);
  const byTheirs = await sideRenames(state, baseTree, theirsTree, state.deletedByTheirs);
  if (byOurs.size === 0 && byTheirs.size === 0) return root;
  const edits = new Map<string, EntryRef | null>();
  const { cache } = state;
  const at = async (tree: ObjectId | null, path: string): Promise<EntryRef | null> =>
    tree === null ? null : cache.entryAt(tree, splitPath(path));

  for (const from of new Set([...byOurs.keys(), ...byTheirs.keys()])) {
    const ours = byOurs.get(from);
    const theirs = byTheirs.get(from);
    if (ours && theirs) {
      const base = ours.record.base;
      if (ours.to !== theirs.to) {
        for (const path of [from, ours.to, theirs.to]) {
          conflict(state, path, "rename-rename", base, ours.entry, theirs.entry);
        }
        continue;
      }
      // Both renamed it to the same place: merge the two against the file as it was, not as two new files.
      state.conflicts.delete(ours.to);
      edits.set(
        ours.to,
        await mergeFileEntries(state, ours.to, base, ours.entry, theirs.entry, {
          ours: state.oursName,
          theirs: state.theirsName,
        }),
      );
      continue;
    }
    const oursRenamed = ours !== undefined;
    const rename = (ours ?? theirs)!;
    const base = rename.record.base;
    const edited = rename.record.other;
    if (edited === null) {
      conflict(
        state,
        rename.to,
        "rename-delete",
        base,
        oursRenamed ? rename.entry : null,
        oursRenamed ? null : rename.entry,
      );
      continue;
    }
    const occupant = await at(oursRenamed ? theirsTree : oursTree, rename.to);
    if (occupant !== null) {
      conflict(
        state,
        rename.to,
        "rename-add",
        base,
        oursRenamed ? rename.entry : occupant,
        oursRenamed ? occupant : rename.entry,
      );
      continue;
    }
    state.conflicts.delete(from);
    // Git names the side and the path in the markers when the two sides know the file by different names.
    const labels: Labels = {
      ours: `${state.oursName}:${oursRenamed ? rename.to : from}`,
      theirs: `${state.theirsName}:${oursRenamed ? from : rename.to}`,
    };
    const merged = await mergeFileEntries(
      state,
      rename.to,
      base,
      oursRenamed ? rename.entry : edited,
      oursRenamed ? edited : rename.entry,
      labels,
    );
    edits.set(rename.to, merged);
    edits.set(from, null);
  }
  return edits.size === 0 ? root : editTree(state.sink, root, edits);
}

/**
 * Merges `ours` and `theirs` given the tree they both started from. A null
 * tree is the empty tree (no common history).
 */
export async function mergeTrees(
  reader: ObjectReader,
  baseTree: ObjectId | null,
  oursTree: ObjectId | null,
  theirsTree: ObjectId | null,
  options: MergeTreesOptions = {},
): Promise<MergeTreesResult> {
  const cache = cacheOf(reader, options.limits);
  const norm = (tree: ObjectId | null): ObjectId | null => (tree === EMPTY_TREE_OID ? null : tree);
  const base = norm(baseTree);
  const ours = norm(oursTree);
  const theirs = norm(theirsTree);
  const state: State = {
    cache,
    sink: new ObjectSink(cache),
    options,
    oursName: options.ours ?? "ours",
    theirsName: options.theirs ?? "theirs",
    conflicts: new Map(),
    deletedByOurs: [],
    deletedByTheirs: [],
    changedAlike: [],
    textBytes: 0,
    trees: 0,
  };
  let tree: ObjectId;
  // The same shortcuts as for any directory, at the root: nothing to do when a side did nothing.
  if (ours === theirs || base === theirs) tree = ours ?? EMPTY_TREE_OID;
  else if (base === ours) tree = theirs ?? EMPTY_TREE_OID;
  else {
    tree = (await mergeLevel(state, "", base, ours, theirs)) ?? EMPTY_TREE_OID;
    if (options.renames !== false) tree = await applyRenames(state, tree, base, ours, theirs);
  }
  const conflicts = [...state.conflicts.values()].sort((x, y) =>
    x.path < y.path ? -1 : x.path > y.path ? 1 : 0,
  );
  // Trees written before the rename pass replaced them are not part of the result.
  const objects = await reachableNew(state.sink, tree);
  return { tree, conflicts, objects };
}

/** The new objects the tree actually uses, children first. */
async function reachableNew(sink: ObjectSink, root: ObjectId): Promise<NewObject[]> {
  const made = new Map(sink.objects.map((object) => [object.oid, object]));
  const ordered: NewObject[] = [];
  const seen = new Set<ObjectId>();
  const visit = async (oid: ObjectId): Promise<void> => {
    const object = made.get(oid);
    if (!object || seen.has(oid)) return;
    seen.add(oid);
    if (object.type === "tree") for (const entry of await sink.tree(oid)) await visit(entry.oid);
    ordered.push(object);
  };
  await visit(root);
  return ordered;
}
