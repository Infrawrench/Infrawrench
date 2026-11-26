/** Directories and files at a ref: the code page. */
import type {
  CommitSummary,
  FileBlob,
  ResolvedRef,
  TreeLastCommits,
  TreeListing,
} from "@infrawrench/git-contract";
import {
  GitError,
  type ObjectId,
  type TreeEntry,
  type TreeEntryMode,
  decodeTextStrict,
} from "@infrawrench/git-core";
import {
  type EntryRef,
  aheadBehind,
  isBinary,
  lastCommitsForEntries,
  log,
  splitLines,
  splitPath,
} from "@infrawrench/git-ops";
import { type RefInput, RepoReaderError } from "../reader";
import {
  type ReaderContext,
  type Session,
  boundedCache,
  cleanPath,
  openSession,
  rawUrl,
  resolve,
  summaries,
  summaryOf,
} from "./session";
import type { LastCommitsProgress } from "./state";

const TYPE_OF: Record<TreeEntryMode, "tree" | "blob" | "symlink" | "submodule"> = {
  "040000": "tree",
  "100644": "blob",
  "100755": "blob",
  "120000": "symlink",
  "160000": "submodule",
};

/** The names a README goes by, best first; compared without case. */
const README_NAMES = ["readme.md", "readme", "readme.txt", "readme.rst"];
/** Where else the root's README may be. */
const ROOT_README_PATHS = [".infrawrench/README.md", "docs/README.md"];

const SIZE_PROBES_AT_ONCE = 24;

/** Sizes of blobs, each a small read of its pack entry's header, several at a time. */
async function sizesOf(
  session: Session,
  oids: readonly ObjectId[],
): Promise<Map<ObjectId, number>> {
  const { sizes } = session.cx.state;
  const out = new Map<ObjectId, number>();
  const todo: ObjectId[] = [];
  for (const oid of new Set(oids)) {
    const known = sizes.get(oid);
    if (known !== undefined) out.set(oid, known);
    else todo.push(oid);
  }
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < todo.length) {
      const oid = todo[next++]!;
      const size = await session.objects.size(oid);
      if (size === null) continue;
      sizes.set(oid, size);
      out.set(oid, size);
    }
  };
  await Promise.all(Array.from({ length: Math.min(SIZE_PROBES_AT_ONCE, todo.length) }, worker));
  return out;
}

/** The entry at a path, with the refusals a page shows. */
async function entryAt(session: Session, tree: ObjectId, path: string): Promise<EntryRef> {
  const entry = await session.cache.entryAt(tree, splitPath(path));
  if (entry === null) {
    throw new RepoReaderError("path_not_found", `There is no ${JSON.stringify(path)} here`);
  }
  return entry;
}

function readmeIn(entries: readonly TreeEntry[]): string | null {
  for (const wanted of README_NAMES) {
    const found = entries.find(
      (entry) =>
        entry.name.toLowerCase() === wanted && entry.mode !== "040000" && entry.mode !== "160000",
    );
    if (found) return found.name;
  }
  return null;
}

async function readmePathOf(
  session: Session,
  rootTree: ObjectId,
  path: string,
  entries: readonly TreeEntry[],
): Promise<string | null> {
  const here = readmeIn(entries);
  if (here !== null) return path === "" ? here : `${path}/${here}`;
  if (path !== "") return null;
  for (const candidate of ROOT_README_PATHS) {
    const entry = await session.cache.entryAt(rootTree, splitPath(candidate));
    if (entry !== null && entry.mode !== "040000" && entry.mode !== "160000") return candidate;
  }
  return null;
}

/** The newest commit that changed a path, or null when the bounded walk did not find it. */
async function lastChange(
  session: Session,
  commit: ObjectId,
  path: string,
): Promise<CommitSummary | null> {
  if (path === "") return summaryOf(commit, await session.cache.commit(commit));
  return session.cx.state.remember(`last:${commit}:${path}`, async () => {
    const found = await log(
      boundedCache(session, { maxCommits: session.cx.limits.lastChangeCommits }),
      commit,
      { path, limit: 1 },
    );
    const entry = found.entries[0];
    return entry ? summaryOf(entry.oid, entry.commit) : null;
  });
}

/**
 * How many commits the ref reaches. Counting is a walk of every commit, so
 * the answer is written down by commit, and a ref that has moved forward is
 * the last count plus what it added. Null while a first count of a long
 * history is still under way: each call gets further, because the commits it
 * read stay in the graph, and the listing is not held up for it.
 */
async function countCommits(session: Session, commit: ObjectId): Promise<number | null> {
  const { state, limits, repo, now } = session.cx;
  const key = `count:${commit}`;
  const known = state.memo.get(key) as number | undefined;
  if (known !== undefined) return known;
  const sql = repo.database;
  const done = (count: number): number => {
    state.memo.set(key, count);
    state.saveCount(sql, commit, count, now());
    return count;
  };
  const stored = state.counts(sql);
  for (const [at, count] of stored) {
    if (at === commit) {
      state.memo.set(key, count);
      return count;
    }
  }
  for (const [at, count] of stored.slice(0, 2)) {
    if (!(await session.objects.has(at))) continue;
    try {
      const { ahead, behind } = await aheadBehind(session.cache, commit, at);
      // Only when everything counted then is still reached now.
      if (behind === 0) return done(count + ahead);
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
    }
  }
  const deadline = Date.now() + limits.countMillis;
  const seen = new Set<ObjectId>([commit]);
  const stack = [commit];
  for (let visited = 0; stack.length > 0; visited++) {
    if ((visited & 255) === 255 && Date.now() >= deadline) return null;
    const node = await session.cache.node(stack.pop()!);
    for (const parent of node.parents) {
      if (seen.has(parent)) continue;
      if (seen.size >= limits.countCommits) return null;
      seen.add(parent);
      stack.push(parent);
    }
  }
  return done(seen.size);
}

/** Carries a directory's walk on within a budget, and writes it down once it is whole. */
async function advanceWalk(
  session: Session,
  commit: ObjectId,
  path: string,
  names: readonly string[],
  budget: { readonly maxCommits: number; readonly maxMillis: number },
): Promise<LastCommitsProgress> {
  const { state, repo, now } = session.cx;
  const sql = repo.database;
  const stored = state.answers(sql, commit, path);
  if (stored) return { resolved: stored };
  let progress = state.walk(commit, path);
  if (progress && !progress.continuation) return progress;
  const result = await lastCommitsForEntries(
    session.cache,
    progress?.continuation ?? commit,
    path,
    names,
    {
      ...budget,
      // An answer worked out for an older commit settles whatever reaches it.
      known: (at) => (at === commit ? undefined : state.answers(sql, at, path)),
    },
  );
  progress ??= { resolved: new Map() };
  for (const [name, oid] of result.resolved) progress.resolved.set(name, oid);
  if (result.continuation) progress.continuation = result.continuation;
  else delete progress.continuation;
  state.setWalk(commit, path, progress);
  if (!progress.continuation) state.saveAnswers(sql, commit, path, progress.resolved, now());
  return progress;
}

interface Directory {
  readonly ref: ResolvedRef;
  readonly path: string;
  readonly rootTree: ObjectId;
  readonly oid: ObjectId;
  readonly entries: readonly TreeEntry[];
}

async function directory(session: Session, ref: RefInput, rawPath: string): Promise<Directory> {
  const resolved = await resolve(session, ref);
  const path = cleanPath(rawPath);
  const rootTree = (await session.cache.node(resolved.commitOid)).tree;
  const at = await entryAt(session, rootTree, path);
  if (at.mode !== "040000") {
    throw new RepoReaderError("not_a_directory", `${JSON.stringify(path)} is a file`);
  }
  return {
    ref: resolved,
    path,
    rootTree,
    oid: at.oid,
    entries: await session.cache.tree(at.oid),
  };
}

export async function tree(
  cx: ReaderContext,
  input: { readonly ref: RefInput; readonly path: string; readonly lastCommits: boolean },
): Promise<TreeListing> {
  const session = await openSession(cx);
  const dir = await directory(session, input.ref, input.path);
  const { limits } = cx;
  // Directories first, then by name, as a file table reads.
  const sorted = [...dir.entries].sort(
    (a, b) =>
      Number(b.mode === "040000") - Number(a.mode === "040000") ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  const listed = sorted.slice(0, limits.maxTreeEntries);
  const sizes = await sizesOf(
    session,
    listed
      .filter((entry) => entry.mode !== "040000" && entry.mode !== "160000")
      .map((entry) => entry.oid),
  );

  let resolved = new Map<string, ObjectId>();
  let complete = false;
  if (input.lastCommits) {
    const progress = await advanceWalk(
      session,
      dir.ref.commitOid,
      dir.path,
      dir.entries.map((entry) => entry.name),
      { maxCommits: limits.treeWalkCommits, maxMillis: limits.treeWalkMillis },
    );
    resolved = progress.resolved;
    complete = !progress.continuation;
  }
  const commits = await summaries(
    session,
    listed.flatMap((entry) => resolved.get(entry.name) ?? []),
  );
  const prefix = dir.path === "" ? "" : `${dir.path}/`;
  return {
    ref: dir.ref,
    path: dir.path,
    oid: dir.oid,
    entries: listed.map((entry) => ({
      name: entry.name,
      path: prefix + entry.name,
      type: TYPE_OF[entry.mode],
      mode: entry.mode,
      oid: entry.oid,
      size: sizes.get(entry.oid) ?? null,
      lastCommit: commits.get(resolved.get(entry.name) ?? "") ?? null,
    })),
    truncated: sorted.length > listed.length,
    lastCommit: input.lastCommits ? await lastChange(session, dir.ref.commitOid, dir.path) : null,
    lastCommitsComplete: complete,
    commitCount: dir.path === "" ? await countCommits(session, dir.ref.commitOid) : null,
    readmePath: await readmePathOf(session, dir.rootTree, dir.path, dir.entries),
  };
}

export async function treeLastCommits(
  cx: ReaderContext,
  input: { readonly ref: RefInput; readonly path: string },
): Promise<TreeLastCommits> {
  const session = await openSession(cx);
  const dir = await directory(session, input.ref, input.path);
  const progress = await advanceWalk(
    session,
    dir.ref.commitOid,
    dir.path,
    dir.entries.map((entry) => entry.name),
    { maxCommits: cx.limits.lastCommitsCommits, maxMillis: cx.limits.lastCommitsMillis },
  );
  const present = new Set(dir.entries.map((entry) => entry.name));
  const commits = await summaries(session, progress.resolved.values());
  const byName: Record<string, CommitSummary> = {};
  for (const [name, oid] of progress.resolved) {
    const commit = commits.get(oid);
    if (commit && present.has(name)) byName[name] = commit;
  }
  return {
    commitOid: dir.ref.commitOid,
    path: dir.path,
    commits: byName,
    complete: !progress.continuation,
  };
}

const LFS_POINTER =
  /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:([0-9a-f]{64})\nsize (\d+)\n/;

async function fileAt(
  session: Session,
  ref: ResolvedRef,
  path: string,
  options: { readonly lastCommit: boolean },
): Promise<FileBlob> {
  const { limits, locator } = session.cx;
  const rootTree = (await session.cache.node(ref.commitOid)).tree;
  const entry = await entryAt(session, rootTree, path);
  if (entry.mode === "040000" || entry.mode === "160000") {
    throw new RepoReaderError(
      "not_a_file",
      entry.mode === "040000"
        ? `${JSON.stringify(path)} is a directory`
        : `${JSON.stringify(path)} is a submodule`,
    );
  }
  const size = (await sizesOf(session, [entry.oid])).get(entry.oid);
  let binary = false;
  let truncated = false;
  let text: string | null = null;
  let lineCount: number | null = null;
  let lfs: FileBlob["lfs"] = null;
  let bytes = size ?? 0;
  // A file past the sniffing bound is never read: it is shown by its link alone.
  if (size !== undefined && size > limits.blobSniffBytes) {
    truncated = true;
  } else {
    const data = await session.cache.blob(entry.oid);
    bytes = data.length;
    const decoded = isBinary(data) ? null : decodeTextStrict(data);
    if (decoded === null) binary = true;
    else if (data.length > limits.blobTextBytes) truncated = true;
    else {
      text = decoded;
      lineCount = splitLines(data).count;
      const pointer = data.length < 1024 ? LFS_POINTER.exec(decoded) : null;
      if (pointer) lfs = { oid: pointer[1]!, size: Number(pointer[2]) };
    }
  }
  return {
    ref,
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    oid: entry.oid,
    mode: entry.mode,
    size: bytes,
    binary,
    truncated,
    text,
    lineCount,
    lfs,
    rawUrl: rawUrl(locator, ref.commitOid, path),
    lastCommit: options.lastCommit ? await lastChange(session, ref.commitOid, path) : null,
  };
}

/** A file at a ref, on a session a caller already has (blame shows the file beside its ranges). */
export const blobIn = (session: Session, ref: ResolvedRef, path: string): Promise<FileBlob> =>
  fileAt(session, ref, cleanPath(path), { lastCommit: true });

export async function blob(
  cx: ReaderContext,
  input: { readonly ref: RefInput; readonly path: string },
): Promise<FileBlob> {
  const session = await openSession(cx);
  const path = cleanPath(input.path);
  if (path === "") throw new RepoReaderError("not_a_file", "The root is a directory");
  return fileAt(session, await resolve(session, input.ref), path, { lastCommit: true });
}

export async function readme(
  cx: ReaderContext,
  input: { readonly ref: RefInput; readonly path: string },
): Promise<FileBlob | null> {
  const session = await openSession(cx);
  let dir: Directory;
  try {
    dir = await directory(session, input.ref, input.path);
  } catch (error) {
    // No README where there is no directory, or nothing at all yet.
    if (
      error instanceof RepoReaderError &&
      (error.code === "path_not_found" || error.code === "repository_empty")
    ) {
      return null;
    }
    throw error;
  }
  const path = await readmePathOf(session, dir.rootTree, dir.path, dir.entries);
  // Shown under the file table, which already says when things changed: no walk for it.
  return path === null ? null : fileAt(session, dir.ref, path, { lastCommit: false });
}
