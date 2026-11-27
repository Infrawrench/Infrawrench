/**
 * Git for the mock: the generated fixtures (`fixtures/*.generated.json`, real
 * repositories read back by `scripts/build-fixtures.mjs`) and the operations
 * the content endpoints need over them: resolving refs, listing trees,
 * history, last-commit-per-entry, diffs and blame.
 *
 * Other mock handlers (branch pages, CI) use this too: `fixtureFor(repo)`
 * and the functions below take the place of the worker's `RepoDO`.
 */
import type {
  BlameRange,
  CommitSummary,
  Commit,
  DiffFile,
  DiffFileSummary,
  ResolvedRef,
  Signature,
  StatusState,
  TreeEntry,
  UserRef,
} from "@infrawrench/git-contract";
import { botUserForEmail, coAuthorsOf } from "@infrawrench/git-contract";
import { mockError, notFound } from "./define";
import { buildHunks, countChanges, diffLines } from "./diff";
import edgeRouterJson from "./fixtures/edge-router.generated.json";
import infraJson from "./fixtures/infra.generated.json";

type Mode = "040000" | "100644" | "100755" | "120000" | "160000";

interface FixtureChange {
  readonly status: string;
  readonly path: string;
  readonly oldPath: string | null;
  readonly similarity: number | null;
  readonly oldMode: string | null;
  readonly newMode: string | null;
  readonly oldOid: string | null;
  readonly newOid: string | null;
}

interface FixtureCommit {
  readonly oid: string;
  readonly tree: string;
  readonly parents: string[];
  author: Signature;
  committer: Signature;
  readonly message: string;
  readonly changes: FixtureChange[];
}

interface FixtureTag {
  readonly oid: string;
  readonly commit: string;
  readonly annotated: boolean;
  tagger: Signature | null;
  readonly message: string | null;
}

type FixtureBlob =
  | { readonly size: number; readonly binary: false; readonly text: string }
  | { readonly size: number; readonly binary: true; readonly base64: string };

export interface GitFixture {
  readonly defaultBranch: string;
  /** Branch name to commit id. The mock creates and deletes branches here. */
  readonly branches: Record<string, string>;
  readonly tags: Record<string, FixtureTag>;
  /** Every commit, newest first. */
  readonly order: string[];
  readonly commits: Record<string, FixtureCommit>;
  /** Tree id to `[mode, oid, name]` entries. */
  readonly trees: Record<string, Array<[string, string, string]>>;
  readonly blobs: Record<string, FixtureBlob>;
  /** `<commit>:<path>` to `[startLine, lineCount, commit, originalStartLine, originalPath, previous]`. */
  readonly blame: Record<string, Array<[number, number, string, number, string, string | null]>>;
}

export type FixtureName = "infra" | "edge-router";

/** The people the fixture commits were written by, by email. */
export const FIXTURE_PEOPLE: Record<string, UserRef> = {
  "mara@acme.example": {
    id: "user_mara",
    username: "mara",
    displayName: "Mara Lindqvist",
    avatarUrl: null,
  },
  "jonas@acme.example": {
    id: "user_jonas",
    username: "jonas",
    displayName: "Jonas Weber",
    avatarUrl: null,
  },
  "priya@acme.example": {
    id: "user_priya",
    username: "priya",
    displayName: "Priya Raman",
    avatarUrl: null,
  },
};

/**
 * Moves every date so the newest commit was `minutesAgo` minutes ago: the
 * fixtures are written once, and "3 weeks ago" should not become "2 years
 * ago" as they sit in the repository.
 */
function rebase(raw: unknown, minutesAgo: number): GitFixture {
  const fixture = structuredClone(raw) as GitFixture;
  const newest = Math.max(
    ...Object.values(fixture.commits).map((c) => Date.parse(c.committer.when)),
  );
  const shift = Date.now() - minutesAgo * 60_000 - newest;
  const moved = (signature: Signature): Signature => ({
    ...signature,
    when: new Date(Date.parse(signature.when) + shift).toISOString(),
  });
  for (const commit of Object.values(fixture.commits)) {
    commit.author = moved(commit.author);
    commit.committer = moved(commit.committer);
  }
  for (const tag of Object.values(fixture.tags)) {
    if (tag.tagger) tag.tagger = moved(tag.tagger);
  }
  return fixture;
}

const base: Record<FixtureName, { json: unknown; minutesAgo: number }> = {
  infra: { json: infraJson, minutesAgo: 47 },
  "edge-router": { json: edgeRouterJson, minutesAgo: 60 * 26 },
};

const instances = new Map<string, GitFixture>();

/**
 * The repository's own copy of a fixture, so a branch created in one mock
 * repository does not appear in another that shares its history.
 */
export function fixtureInstance(repositoryId: string, name: FixtureName): GitFixture {
  let fixture = instances.get(repositoryId);
  if (!fixture) {
    fixture = rebase(base[name].json, base[name].minutesAgo);
    instances.set(repositoryId, fixture);
  }
  return fixture;
}

const HEX40 = /^[0-9a-f]{40}$/;

export function resolveRef(fx: GitFixture, ref: string | undefined): ResolvedRef {
  const name = ref === undefined || ref === "" ? fx.defaultBranch : ref;
  const branchName = name.startsWith("refs/heads/") ? name.slice(11) : name;
  const branch = fx.branches[branchName];
  if (branch !== undefined && !name.startsWith("refs/tags/")) {
    return {
      name: branchName,
      kind: "branch",
      fullName: `refs/heads/${branchName}`,
      commitOid: branch,
    };
  }
  const tagName = name.startsWith("refs/tags/") ? name.slice(10) : name;
  const tag = fx.tags[tagName];
  if (tag !== undefined) {
    return { name: tagName, kind: "tag", fullName: `refs/tags/${tagName}`, commitOid: tag.commit };
  }
  if (/^[0-9a-f]{4,40}$/i.test(name)) {
    const lower = name.toLowerCase();
    const matches = fx.order.filter((oid) => oid.startsWith(lower));
    if (matches.length === 1) {
      return { name: matches[0]!, kind: "commit", fullName: null, commitOid: matches[0]! };
    }
  }
  throw mockError(404, `No branch, tag or commit named ${name}`, "ref_not_found");
}

export function commitOf(fx: GitFixture, oid: string): FixtureCommit {
  const commit = HEX40.test(oid)
    ? fx.commits[oid]
    : fx.commits[fx.order.find((o) => o.startsWith(oid.toLowerCase())) ?? ""];
  if (!commit) throw notFound("Commit not found");
  return commit;
}

/** `[mode, oid]` of the entry at `path` in a commit; the root tree for an empty path. */
export function entryAt(fx: GitFixture, commitOid: string, path: string): [Mode, string] | null {
  let current: [Mode, string] = ["040000", commitOf(fx, commitOid).tree];
  if (path === "") return current;
  for (const segment of path.split("/")) {
    if (current[0] !== "040000") return null;
    const entry = fx.trees[current[1]]?.find(([, , name]) => name === segment);
    if (!entry) return null;
    current = [entry[0] as Mode, entry[1]];
  }
  return current;
}

/** Every blob of a commit: path to `[mode, oid]`. */
export function flatten(fx: GitFixture, commitOid: string): Map<string, [Mode, string]> {
  const files = new Map<string, [Mode, string]>();
  const walk = (treeOid: string, prefix: string) => {
    for (const [mode, oid, name] of fx.trees[treeOid] ?? []) {
      if (mode === "040000") walk(oid, `${prefix}${name}/`);
      else files.set(prefix + name, [mode as Mode, oid]);
    }
  };
  walk(commitOf(fx, commitOid).tree, "");
  return files;
}

/** The statuses the mock gives the newest commits of the default branch. */
const STATUS_BY_DEPTH: ReadonlyArray<StatusState | null> = [
  "pending",
  "success",
  "success",
  "failure",
  "success",
  "success",
];

export function statusOf(fx: GitFixture, oid: string): StatusState | null {
  let cursor: string | undefined = fx.branches[fx.defaultBranch];
  for (let depth = 0; depth < STATUS_BY_DEPTH.length && cursor !== undefined; depth++) {
    if (cursor === oid) return STATUS_BY_DEPTH[depth] ?? null;
    cursor = fx.commits[cursor]?.parents[0];
  }
  return null;
}

/** Who an address on a commit is, as the Worker's decorator answers: a bot first, then a person. */
export const personOf = (email: string): UserRef | null =>
  botUserForEmail(email) ?? FIXTURE_PEOPLE[email] ?? null;

export function summarize(fx: GitFixture, oid: string): CommitSummary {
  const commit = commitOf(fx, oid);
  const [summary = "", ...rest] = commit.message.split("\n");
  return {
    oid: commit.oid,
    summary,
    hasBody: rest.some((line) => line.trim() !== ""),
    author: commit.author,
    committer: commit.committer,
    authorUser: personOf(commit.author.email),
    coAuthors: coAuthorsOf(commit.message, commit.author.email).map((person) => ({
      ...person,
      user: personOf(person.email),
    })),
    parents: commit.parents,
    status: statusOf(fx, commit.oid),
  };
}

export function fullCommit(fx: GitFixture, oid: string): Commit {
  const commit = commitOf(fx, oid);
  return {
    ...summarize(fx, oid),
    treeOid: commit.tree,
    message: commit.message,
    committerUser: personOf(commit.committer.email),
    signed: false,
  };
}

/** Every commit reachable from `oid`, itself included. */
export function ancestors(fx: GitFixture, oid: string): Set<string> {
  const seen = new Set<string>();
  const queue = [oid];
  while (queue.length > 0) {
    const next = queue.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    queue.push(...(fx.commits[next]?.parents ?? []));
  }
  return seen;
}

/** Whether a commit changed `path` (a file or a directory) against every parent. */
function touches(fx: GitFixture, oid: string, path: string): boolean {
  const mine = entryAt(fx, oid, path)?.[1] ?? null;
  const parents = commitOf(fx, oid).parents;
  if (parents.length === 0) return mine !== null;
  return parents.every((parent) => (entryAt(fx, parent, path)?.[1] ?? null) !== mine);
}

/** History from a commit, newest first, optionally only what changed `path`. */
export function log(fx: GitFixture, from: string, path?: string): string[] {
  const reachable = ancestors(fx, from);
  const commits = fx.order.filter((oid) => reachable.has(oid));
  return path === undefined || path === ""
    ? commits
    : commits.filter((oid) => touches(fx, oid, path));
}

/**
 * The newest commit that changed `path`, as Git's history simplification
 * finds it: follow any parent that has the same content, stop where none does.
 */
export function lastCommitFor(fx: GitFixture, from: string, path: string): string {
  let cursor = from;
  for (;;) {
    const mine = entryAt(fx, cursor, path)?.[1] ?? null;
    const same = commitOf(fx, cursor).parents.find(
      (parent) => (entryAt(fx, parent, path)?.[1] ?? null) === mine,
    );
    if (same === undefined) return cursor;
    cursor = same;
  }
}

const TYPE_OF_MODE: Record<Mode, TreeEntry["type"]> = {
  "040000": "tree",
  "100644": "blob",
  "100755": "blob",
  "120000": "symlink",
  "160000": "submodule",
};

export function listTree(
  fx: GitFixture,
  commitOid: string,
  path: string,
  withLastCommits: boolean,
): { oid: string; entries: TreeEntry[] } {
  const tree = entryAt(fx, commitOid, path);
  if (!tree) throw mockError(404, "Nothing at that path", "path_not_found");
  if (tree[0] !== "040000") throw mockError(422, "That path is a file", "not_a_directory");
  const entries = (fx.trees[tree[1]] ?? []).map(([mode, oid, name]): TreeEntry => {
    const entryPath = path === "" ? name : `${path}/${name}`;
    const type = TYPE_OF_MODE[mode as Mode];
    return {
      name,
      path: entryPath,
      type,
      mode: mode as Mode,
      oid,
      size: type === "blob" || type === "symlink" ? (fx.blobs[oid]?.size ?? 0) : null,
      lastCommit: withLastCommits ? summarize(fx, lastCommitFor(fx, commitOid, entryPath)) : null,
    };
  });
  entries.sort(
    (a, b) => Number(b.type === "tree") - Number(a.type === "tree") || a.name.localeCompare(b.name),
  );
  return { oid: tree[1], entries };
}

export function blobAt(
  fx: GitFixture,
  commitOid: string,
  path: string,
): { mode: Mode; oid: string; blob: FixtureBlob } {
  const entry = entryAt(fx, commitOid, path);
  if (!entry) throw mockError(404, "Nothing at that path", "path_not_found");
  if (entry[0] === "040000" || entry[0] === "160000") {
    throw mockError(422, "That path is not a file", "not_a_file");
  }
  const blob = fx.blobs[entry[1]];
  if (!blob) throw notFound("No file at that path");
  return { mode: entry[0], oid: entry[1], blob };
}

const README_NAMES = /^readme(\.(md|markdown|txt|rst))?$/i;

export function readmeIn(fx: GitFixture, commitOid: string, path: string): string | null {
  const tree = entryAt(fx, commitOid, path);
  if (!tree || tree[0] !== "040000") return null;
  const entry = (fx.trees[tree[1]] ?? []).find(
    ([mode, , name]) => mode !== "040000" && README_NAMES.test(name),
  );
  if (!entry) return null;
  return path === "" ? entry[2] : `${path}/${entry[2]}`;
}

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  pdf: "application/pdf",
};

/** A `data:` URL of a blob, standing in for the raw file route the worker serves. */
export function rawDataUrl(blob: FixtureBlob, path: string): string {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (blob.binary) {
    return `data:${MIME[extension] ?? "application/octet-stream"};base64,${blob.base64}`;
  }
  const mime = extension === "svg" ? "image/svg+xml" : "text/plain;charset=utf-8";
  return `data:${mime},${encodeURIComponent(blob.text)}`;
}

const STATUS_OF_LETTER: Record<string, DiffFileSummary["status"]> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "type_changed",
};

const textOf = (fx: GitFixture, oid: string | null): string | null => {
  if (oid === null) return "";
  const blob = fx.blobs[oid];
  if (!blob) return "";
  return blob.binary ? null : blob.text;
};

function fileDiff(
  fx: GitFixture,
  change: FixtureChange,
  context: number,
  withHunks: boolean,
): DiffFile {
  const oldText = textOf(fx, change.oldMode === "160000" ? null : change.oldOid);
  const newText = textOf(fx, change.newMode === "160000" ? null : change.newOid);
  const binary = oldText === null || newText === null;
  const lines = binary || change.oldOid === change.newOid ? [] : diffLines(oldText, newText);
  const { additions, deletions } = countChanges(lines);
  return {
    path: change.path,
    oldPath: change.oldPath,
    status: STATUS_OF_LETTER[change.status] ?? "modified",
    oldMode: change.oldMode as Mode | null,
    newMode: change.newMode as Mode | null,
    oldOid: change.oldOid,
    newOid: change.newOid,
    binary,
    additions,
    deletions,
    similarity: change.similarity,
    hunks: withHunks ? buildHunks(lines, context) : [],
    tooLarge: false,
  };
}

/** What changed between two commits, renames found by identical content. */
function changesBetween(fx: GitFixture, baseOid: string | null, headOid: string): FixtureChange[] {
  const head = commitOf(fx, headOid);
  if (baseOid === (head.parents[0] ?? null)) return head.changes;
  const before = baseOid === null ? new Map<string, [Mode, string]>() : flatten(fx, baseOid);
  const after = flatten(fx, headOid);
  const changes: FixtureChange[] = [];
  const deleted = new Map<string, string>();
  for (const [path, [mode, oid]] of before) {
    const now = after.get(path);
    if (!now) deleted.set(oid, path);
    else if (now[1] !== oid || now[0] !== mode) {
      changes.push({
        status: "M",
        path,
        oldPath: null,
        similarity: null,
        oldMode: mode,
        newMode: now[0],
        oldOid: oid,
        newOid: now[1],
      });
    }
  }
  for (const [path, [mode, oid]] of after) {
    if (before.has(path)) continue;
    const from = deleted.get(oid);
    if (from !== undefined) {
      deleted.delete(oid);
      changes.push({
        status: "R",
        path,
        oldPath: from,
        similarity: 100,
        oldMode: before.get(from)![0],
        newMode: mode,
        oldOid: oid,
        newOid: oid,
      });
    } else {
      changes.push({
        status: "A",
        path,
        oldPath: null,
        similarity: null,
        oldMode: null,
        newMode: mode,
        oldOid: null,
        newOid: oid,
      });
    }
  }
  for (const [oid, path] of deleted) {
    changes.push({
      status: "D",
      path,
      oldPath: null,
      similarity: null,
      oldMode: before.get(path)![0],
      newMode: null,
      oldOid: oid,
      newOid: null,
    });
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

export interface DiffOptions {
  readonly context?: number | undefined;
  readonly path?: string | undefined;
  readonly hunks?: boolean;
}

/** The files changed from `baseOid` (null: from nothing) to `headOid`. */
export function diffCommits(
  fx: GitFixture,
  baseOid: string | null,
  headOid: string,
  options: DiffOptions = {},
): DiffFile[] {
  return changesBetween(fx, baseOid, headOid)
    .filter((change) => options.path === undefined || change.path === options.path)
    .map((change) => fileDiff(fx, change, options.context ?? 3, options.hunks ?? true));
}

export function statsOf(files: ReadonlyArray<DiffFileSummary>) {
  return {
    filesChanged: files.length,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
  };
}

export function summaryOf(file: DiffFile): DiffFileSummary {
  const { hunks: _hunks, tooLarge: _tooLarge, ...summary } = file;
  return summary;
}

/** The best common ancestor of two commits: the newest commit both reach. */
export function mergeBase(fx: GitFixture, a: string, b: string): string | null {
  const fromA = ancestors(fx, a);
  const fromB = ancestors(fx, b);
  return fx.order.find((oid) => fromA.has(oid) && fromB.has(oid)) ?? null;
}

/** Commits `head` reaches that `base` does not, and the reverse. */
export function aheadBehind(fx: GitFixture, base: string, head: string) {
  const fromBase = ancestors(fx, base);
  const fromHead = ancestors(fx, head);
  const ahead = fx.order.filter((oid) => fromHead.has(oid) && !fromBase.has(oid));
  const behind = fx.order.filter((oid) => fromBase.has(oid) && !fromHead.has(oid));
  return { ahead, behind };
}

export function blameOf(
  fx: GitFixture,
  commitOid: string,
  path: string,
): { ranges: BlameRange[]; commits: Record<string, CommitSummary> } {
  const origin = lastCommitFor(fx, commitOid, path);
  const raw = fx.blame[`${origin}:${path}`] ?? [];
  const ranges = raw.map(
    ([startLine, lineCount, oid, originalStartLine, originalPath, previous]): BlameRange => ({
      startLine,
      lineCount,
      commitOid: oid,
      originalStartLine,
      originalPath,
      previousCommitOid: previous,
    }),
  );
  const commits: Record<string, CommitSummary> = {};
  for (const range of ranges) commits[range.commitOid] ??= summarize(fx, range.commitOid);
  return { ranges, commits };
}
