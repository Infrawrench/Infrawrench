/**
 * What every reader method starts from: the repository's storage, the state
 * kept between requests, and for one call an `ObjectCache` over a single
 * list of packs. Also the conversions from Git's objects to the contract's
 * shapes, which every method shares.
 *
 * Only types are imported from `@infrawrench/git-contract`: this code is
 * loaded with the Durable Object, at the Worker's start-up, and the
 * contract's entry evaluates every schema of the API.
 */
import type {
  Commit,
  CommitSummary,
  DiffFileSummary,
  DiffHunk,
  ResolvedRef,
  Signature,
} from "@infrawrench/git-contract";
import {
  type Commit as GitCommit,
  GitError,
  type ObjectId,
  type Ref,
  type Signature as GitSignature,
  commitHeader,
  isObjectId,
  messageSubject,
} from "@infrawrench/git-core";
import {
  type FileChange,
  type DiffHunk as OpsHunk,
  type Limits,
  ObjectCache,
  type RawFileDiff,
} from "@infrawrench/git-ops";
import type { Repository, RepositoryObjects } from "../do/repository";
import { type RefInput, type RepoLocator, RepoReaderError } from "../reader";
import type { ReaderState } from "./state";

/** The reader's own bounds, on top of `@infrawrench/git-ops`' (`Limits`). */
export interface ReaderLimits {
  /** Most entries of one directory listed. */
  readonly maxTreeEntries: number;
  /** Text a blob answers inline. The contract's `BLOB_TEXT_LIMIT_BYTES`; a test holds the two equal. */
  readonly blobTextBytes: number;
  /** A file up to this size is read to tell text from binary; a larger one is not read at all. */
  readonly blobSniffBytes: number;
  /** History walked for the file table in the call that lists a directory. */
  readonly treeWalkMillis: number;
  readonly treeWalkCommits: number;
  /** And in each `treeLastCommits` call that carries on. */
  readonly lastCommitsMillis: number;
  readonly lastCommitsCommits: number;
  /** Commits visited looking for the last change to one path. */
  readonly lastChangeCommits: number;
  /** Commits a filtered or path-limited history page may visit. */
  readonly logScanCommits: number;
  readonly logScanMillis: number;
  /** Commits listed by a comparison. */
  readonly compareCommits: number;
  /** Files of a diff whose lines are counted (and listed with counts). */
  readonly diffFiles: number;
  /** Time spent counting them; files not reached are left out like those past `diffFiles`. */
  readonly diffCountMillis: number;
  /** Hunk lines rendered in one page of a diff. */
  readonly diffPageLines: number;
  readonly blameCommits: number;
  readonly blameMillis: number;
  /** Refs whose commits are read to sort a list by date; past it, lists are by name. */
  readonly sortRefs: number;
  /** Commits counted for a root listing's `commitCount`; null past it. */
  readonly countCommits: number;
  /** Time one listing spends on a count it does not have yet. */
  readonly countMillis: number;
  /** Commits a rebase replays. */
  readonly rebaseCommits: number;
}

export const DEFAULT_READER_LIMITS: ReaderLimits = {
  maxTreeEntries: 1000,
  blobTextBytes: 1024 * 1024,
  blobSniffBytes: 8 * 1024 * 1024,
  treeWalkMillis: 150,
  treeWalkCommits: 2000,
  lastCommitsMillis: 400,
  lastCommitsCommits: 10_000,
  lastChangeCommits: 5000,
  logScanCommits: 20_000,
  logScanMillis: 500,
  compareCommits: 250,
  diffFiles: 300,
  diffCountMillis: 2500,
  diffPageLines: 20_000,
  blameCommits: 10_000,
  blameMillis: 2000,
  sortRefs: 1000,
  countCommits: 1_000_000,
  countMillis: 200,
  rebaseCommits: 250,
};

export interface ReaderContext {
  readonly repo: Repository;
  readonly state: ReaderState;
  readonly locator: RepoLocator;
  readonly limits: ReaderLimits;
  readonly now: () => number;
}

/** One call's view of the repository. */
export interface Session {
  readonly cx: ReaderContext;
  readonly objects: RepositoryObjects;
  readonly cache: ObjectCache;
  readonly refs: readonly Ref[];
  /** `HEAD`'s branch, as a full ref name. */
  readonly head: string;
}

export const BRANCH = "refs/heads/";
export const TAG = "refs/tags/";

export const unavailable = (): RepoReaderError =>
  new RepoReaderError("unavailable", "This repository's storage is not there");

/** A cache over the same packs and graph with other bounds (a walk with its own budget). */
export const boundedCache = (session: Session, limits: Partial<Limits>): ObjectCache =>
  new ObjectCache(session.objects, limits, { graph: session.cx.state.graph });

export async function openSession(cx: ReaderContext): Promise<Session> {
  if (!cx.repo.isReady()) throw unavailable();
  const objects = await cx.repo.objects();
  return {
    cx,
    objects,
    cache: new ObjectCache(objects, undefined, { graph: cx.state.graph }),
    refs: cx.repo.listRefs(),
    head: cx.repo.head(),
  };
}

export const branchTip = (session: Session, name: string): ObjectId | null =>
  session.refs.find((ref) => ref.name === BRANCH + name)?.oid ?? null;

export const hasBranches = (session: Session): boolean =>
  session.refs.some((ref) => ref.name.startsWith(BRANCH));

/** The commit a ref leads to (a tag peeled), or null when it leads to a tree or a blob. */
export async function commitOf(session: Session, oid: ObjectId): Promise<ObjectId | null> {
  let current = oid;
  for (let depth = 0; depth < 32; depth++) {
    const known = session.cx.state.graph.get(current);
    if (known) return current;
    const object = await session.cache.read(current);
    if (!object) return null;
    if (object.type === "commit") return current;
    if (object.type !== "tag") return null;
    const match = /^object ([0-9a-f]{40})\n/.exec(
      new TextDecoder().decode(object.data.subarray(0, 48)),
    );
    if (!match) return null;
    current = match[1]!;
  }
  return null;
}

/**
 * A ref the way a person names one: a full ref name, else a branch, else a
 * tag, else a commit id (whole, or an unambiguous start of one). Undefined
 * is the default branch.
 */
export async function resolve(session: Session, input: RefInput): Promise<ResolvedRef> {
  const { refs, head } = session;
  const named = async (ref: Ref): Promise<ResolvedRef | null> => {
    const commitOid = await commitOf(session, ref.peeled ?? ref.oid);
    if (!commitOid) return null;
    if (ref.name.startsWith(BRANCH)) {
      return {
        name: ref.name.slice(BRANCH.length),
        kind: "branch",
        fullName: ref.name,
        commitOid,
      };
    }
    if (ref.name.startsWith(TAG)) {
      return { name: ref.name.slice(TAG.length), kind: "tag", fullName: ref.name, commitOid };
    }
    // `refs/pull/7/head` and the like: a commit, named by what it is.
    return { name: commitOid, kind: "commit", fullName: null, commitOid };
  };
  const find = (name: string): Ref | undefined => refs.find((ref) => ref.name === name);

  if (input === undefined || input === "" || input === "HEAD") {
    const ref = find(head);
    if (!ref) {
      if (!hasBranches(session)) {
        throw new RepoReaderError("repository_empty", "Nothing has been pushed yet");
      }
      throw new RepoReaderError("ref_not_found", "The default branch does not exist");
    }
    const found = await named(ref);
    if (found) return found;
    throw new RepoReaderError("ref_not_found", "The default branch does not point at a commit");
  }
  for (const name of input.startsWith("refs/") ? [input] : [BRANCH + input, TAG + input]) {
    const ref = find(name);
    if (ref) {
      const found = await named(ref);
      if (found) return found;
    }
  }
  const commitOid = await resolveCommitId(session, input);
  if (commitOid) return { name: commitOid, kind: "commit", fullName: null, commitOid };
  throw new RepoReaderError("ref_not_found", `Nothing here is called ${JSON.stringify(input)}`);
}

/** A whole commit id, or four or more hex digits that start exactly one commit's. */
export async function resolveCommitId(session: Session, text: string): Promise<ObjectId | null> {
  const id = text.toLowerCase();
  if (isObjectId(id)) return commitOf(session, id);
  if (!/^[0-9a-f]{4,39}$/.test(id)) return null;
  // Objects of every kind share the id space; a tree that starts the same way is not in the running.
  const candidates = await session.cx.repo.resolvePrefix(id, 8);
  const commits: ObjectId[] = [];
  for (const oid of candidates) {
    const object = await session.cache.read(oid);
    if (object?.type === "commit") commits.push(oid);
  }
  return commits.length === 1 && candidates.length < 8 ? commits[0]! : null;
}

/** The path as the contract spells one: no leading, trailing or doubled slashes. */
export const cleanPath = (path: string): string =>
  path
    .split("/")
    .filter((part) => part !== "")
    .join("/");

// Shapes

const signatureOf = (signature: GitSignature): Signature => {
  // A date git itself would refuse to print still has to be an instant here.
  const millis = signature.timestamp * 1000;
  const when = new Date(Number.isFinite(millis) && Math.abs(millis) < 8.64e15 ? millis : 0);
  return {
    name: signature.name,
    email: signature.email,
    when: when.toISOString(),
    timezoneOffset: Object.is(signature.timezoneOffset, -0) ? 0 : signature.timezoneOffset,
  };
};

export const summaryOf = (oid: ObjectId, commit: GitCommit): CommitSummary => {
  const summary = messageSubject(commit.message);
  return {
    oid,
    summary,
    hasBody: commit.message.slice(summary.length).trim() !== "",
    author: signatureOf(commit.author),
    committer: signatureOf(commit.committer),
    authorUser: null,
    parents: [...commit.parents],
    status: null,
  };
};

export const commitShape = (oid: ObjectId, commit: GitCommit): Commit => ({
  ...summaryOf(oid, commit),
  treeOid: commit.tree,
  message: commit.message,
  committerUser: null,
  signed: commitHeader(commit, "gpgsig") !== null || commitHeader(commit, "gpgsig-sha256") !== null,
});

export { signatureOf };

/** Summaries of several commits, each read once. Ids that are not commits here are left out. */
export async function summaries(
  session: Session,
  oids: Iterable<ObjectId>,
): Promise<Map<ObjectId, CommitSummary>> {
  const out = new Map<ObjectId, CommitSummary>();
  for (const oid of oids) {
    if (out.has(oid)) continue;
    try {
      out.set(oid, summaryOf(oid, await session.cache.commit(oid)));
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
    }
  }
  return out;
}

const STATUS = {
  added: "added",
  deleted: "deleted",
  modified: "modified",
  renamed: "renamed",
  copied: "copied",
  "type-changed": "type_changed",
} as const;

export const fileSummary = (
  change: FileChange,
  counts: Pick<RawFileDiff, "binary" | "additions" | "deletions"> | null,
): DiffFileSummary => ({
  path: change.newPath ?? change.oldPath ?? "",
  oldPath: change.status === "renamed" || change.status === "copied" ? change.oldPath : null,
  status: STATUS[change.status],
  oldMode: change.old?.mode ?? null,
  newMode: change.new?.mode ?? null,
  oldOid: change.old?.oid ?? null,
  newOid: change.new?.oid ?? null,
  binary: counts?.binary ?? false,
  additions: counts?.additions ?? 0,
  deletions: counts?.deletions ?? 0,
  similarity: change.similarity ?? null,
});

export const hunkShape = (hunk: OpsHunk, section: string): DiffHunk => ({
  oldStart: hunk.oldStart,
  oldLines: hunk.oldLines,
  newStart: hunk.newStart,
  newLines: hunk.newLines,
  section,
  lines: hunk.lines.map((line) => ({
    type: line.kind,
    content: line.text,
    oldLine: line.oldNumber,
    newLine: line.newNumber,
    ...(line.noNewline ? { noNewlineAtEnd: true as const } : {}),
  })),
});

/** `/owner/repo/raw/<commit>/<path>`: the contract's `rawPath`, restated (see the note at the top). */
export const rawUrl = (locator: RepoLocator, commitOid: ObjectId, path: string): string => {
  const segments = (value: string): string => value.split("/").map(encodeURIComponent).join("/");
  return `/${encodeURIComponent(locator.owner)}/${encodeURIComponent(locator.name)}/raw/${commitOid}/${segments(path)}`;
};

/** A cursor that is a position in a list. */
export const offsetOf = (cursor: string | undefined): number => {
  if (cursor === undefined) return 0;
  const value = Number(cursor);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
};
