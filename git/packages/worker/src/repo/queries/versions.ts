/**
 * Versions of a branch, as the reader serves them: what the storage
 * recorded (`../do/versions.ts`), the diffs between two versions, and where
 * a review comment's lines went from one version to the next.
 *
 * The commit ids here come from the forge's own rows (`git_branch_versions`),
 * never from a caller, so they are read without asking whether a ref reaches
 * them. A version's ref keeps its commit until the version is pruned; a
 * pruned version's row is kept, and its commit is then read only while some
 * other ref reaches it (`reachableOnly`).
 */
import { GitError, type GitObject, type ObjectId } from "@infrawrench/git-core";
import { ObjectCache, diffFile, mergeTrees, resolvePath } from "@infrawrench/git-ops";
import {
  type DiffOptions,
  type LineAnchor,
  type MappedLine,
  type ReaderVersion,
  type ReaderVersionDiff,
  RepoReaderError,
  type VersionDiffInput,
} from "../reader";
import { diffPage, treeOf } from "./diffs";
import { type ReaderContext, type Session, openSession, reachable, unavailable } from "./session";

export async function listVersions(
  cx: ReaderContext,
  input: {
    readonly branch: string;
    readonly after?: { readonly lineage: number; readonly number: number } | undefined;
  },
): Promise<readonly ReaderVersion[]> {
  if (!cx.repo.isReady()) throw unavailable();
  return cx.repo.versions(input.branch, input.after);
}

export async function pruneVersions(
  cx: ReaderContext,
  input: {
    readonly branch: string;
    readonly versions: ReadonlyArray<{ readonly lineage: number; readonly number: number }>;
  },
): Promise<{ readonly dropped: number }> {
  // A repository that is gone has nothing left to prune.
  if (!cx.repo.isReady()) return { dropped: 0 };
  return { dropped: cx.repo.pruneVersions(input.branch, input.versions) };
}

/** The session with objects a merge made in memory on top of the stored ones. */
const withObjects = (
  session: Session,
  made: readonly (GitObject & { oid: ObjectId })[],
): Session => {
  const extra = new Map(made.map((object) => [object.oid, object]));
  const objects = {
    ...session.objects,
    read: async (oid: ObjectId) => extra.get(oid) ?? session.objects.read(oid),
    has: async (oid: ObjectId) => extra.has(oid) || session.objects.has(oid),
    hasSync: (oid: ObjectId) => extra.has(oid) || session.objects.hasSync(oid),
    size: async (oid: ObjectId) => extra.get(oid)?.data.length ?? session.objects.size(oid),
  };
  return {
    ...session,
    objects,
    cache: new ObjectCache(
      objects,
      { maxMessageBytes: session.cx.limits.shownMessageBytes },
      { graph: session.cx.state.graph },
    ),
  };
};

/**
 * A diff of a version: its whole change (base to tip), or what it changed
 * since an older version.
 *
 * The second is an interdiff. With one base it is the two tips compared.
 * After a rebase the tips differ by everything the new base brought, which
 * is not what the author changed, so the older version is first carried to
 * the newer base: a three-way merge of its tip onto the newer base, from its
 * own base, made in memory and never stored. That tree against the newer
 * tip is what the push changed in the change itself. When the older version
 * does not apply to the newer base without conflicts there is no such tree,
 * and the tips are compared as they are (`exact: false`).
 */
export async function versionDiff(
  cx: ReaderContext,
  input: VersionDiffInput,
  options: DiffOptions,
): Promise<ReaderVersionDiff> {
  const session = await openSession(cx);
  const { from, to } = input;
  if (input.reachableOnly === true) {
    // What a pruned version's ref held is a leftover unless something else keeps it.
    for (const oid of from === null ? [to.tipOid] : [from.tipOid, to.tipOid]) {
      if (!(await reachable(session, oid))) {
        throw new RepoReaderError("ref_not_found", "That version's commits are no longer kept");
      }
    }
  }
  const toTree = await treeOf(session, to.tipOid);
  if (from === null) {
    return {
      diff: await diffPage(
        session,
        to.baseOid,
        to.tipOid,
        to.baseOid ? await treeOf(session, to.baseOid) : null,
        toTree,
        options,
      ),
      rebased: false,
      exact: true,
    };
  }
  const fromTree = await treeOf(session, from.tipOid);
  const rebased = from.baseOid !== to.baseOid;
  const tips = async (exact: boolean): Promise<ReaderVersionDiff> => ({
    diff: await diffPage(session, from.tipOid, to.tipOid, fromTree, toTree, options),
    rebased,
    exact,
  });
  if (!rebased) return tips(true);
  // Without both bases there is nothing to carry the older version across.
  if (from.baseOid === null || to.baseOid === null) return tips(false);
  let carried: Awaited<ReturnType<typeof mergeTrees>>;
  try {
    carried = await mergeTrees(
      session.cache,
      await treeOf(session, from.baseOid),
      await treeOf(session, to.baseOid),
      fromTree,
    );
  } catch (error) {
    // Too large to merge within the bounds: the plain comparison still answers.
    if (error instanceof GitError && error.code === "limit") return tips(false);
    throw error;
  }
  if (carried.conflicts.length > 0) return tips(false);
  return {
    diff: await diffPage(
      withObjects(session, carried.objects),
      from.tipOid,
      to.tipOid,
      carried.tree,
      toTree,
      options,
    ),
    rebased: true,
    exact: true,
  };
}

/** Anchors mapped in one call. */
const MAX_ANCHORS = 500;

/**
 * Where lines of files at one commit are at another: for each anchor its new
 * line numbers when every line it covers is unchanged, or `changed`. A file
 * that is gone, renamed, binary or too large to compare counts as changed.
 */
export async function mapLines(
  cx: ReaderContext,
  input: {
    readonly fromOid: string;
    readonly toOid: string;
    readonly anchors: readonly LineAnchor[];
  },
): Promise<readonly MappedLine[]> {
  if (input.anchors.length > MAX_ANCHORS) {
    throw new RepoReaderError("too_large", "Too many comments to carry forward at once");
  }
  const session = await openSession(cx);
  const fromTree = await treeOf(session, input.fromOid);
  const toTree = await treeOf(session, input.toOid);
  const byPath = new Map<string, LineAnchor[]>();
  for (const anchor of input.anchors) {
    byPath.set(anchor.path, [...(byPath.get(anchor.path) ?? []), anchor]);
  }
  const mapped: MappedLine[] = [];
  for (const [path, anchors] of byPath) {
    const changed = () => {
      for (const anchor of anchors) mapped.push({ key: anchor.key, changed: true });
    };
    const before = await resolvePath(session.cache, fromTree, path);
    const after = await resolvePath(session.cache, toTree, path);
    if (!before || !after || before.mode === "040000" || after.mode === "040000") {
      changed();
      continue;
    }
    if (before.oid === after.oid) {
      for (const anchor of anchors) {
        mapped.push({ key: anchor.key, line: anchor.line, startLine: anchor.startLine });
      }
      continue;
    }
    const raw = await diffFile(
      session.cache,
      { status: "modified", oldPath: path, newPath: path, old: before, new: after },
      { context: 0 },
    );
    if (raw.binary || raw.tooLarge) {
      changed();
      continue;
    }
    const changes = raw.hunks.flatMap((hunk) => hunk.changes);
    /** The new 1-based number of old line `line`, or null when the line was removed or rewritten. */
    const at = (line: number): number | null => {
      const index = line - 1;
      if (index < 0 || index >= raw.oldLines.count) return null;
      let shift = 0;
      for (const change of changes) {
        if (index < change.i1) break;
        if (index < change.i1 + change.chg1) return null;
        shift = change.i2 + change.chg2 - (change.i1 + change.chg1);
      }
      return index + shift + 1;
    };
    for (const anchor of anchors) {
      const first = anchor.startLine ?? anchor.line;
      const line = at(anchor.line);
      const start = at(first);
      // Every line of the range has to stand, with nothing put between them.
      let intact = line !== null && start !== null && line - start === anchor.line - first;
      for (let each = first + 1; intact && each < anchor.line; each++) intact = at(each) !== null;
      if (!intact || line === null || start === null) {
        mapped.push({ key: anchor.key, changed: true });
      } else {
        mapped.push({ key: anchor.key, line, startLine: anchor.startLine === null ? null : start });
      }
    }
  }
  return mapped;
}
