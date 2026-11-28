/**
 * `RepoReader` over a repository's own storage: every method of the
 * interface, written against `Repository` (`../do/repository.ts`) and
 * `@infrawrench/git-ops`. It runs wherever a `Repository` does: inside the
 * Durable Object in production (`RepoDO.reader`), on the Node stand-ins in
 * the tests. `../reader-do.ts` is the Worker's side of the same interface.
 */
import { GitError } from "@infrawrench/git-core";
import {
  type InitInput,
  type RepoLocator,
  type RepoReader,
  RepoReaderError,
  type RepositoryStats,
} from "../reader";
import type { Repository } from "../do/repository";
import {
  blob,
  languages,
  latestCommit,
  readme,
  terraformFiles,
  tree,
  treeLastCommits,
} from "./content";
import { commit, commitDiff, compare, compareDiff, diffAnchor } from "./diffs";
import { blame, commitRange, commits, commitsBetween, listCommits } from "./history";
import { landed, merge, mergeability, updateBranch } from "./merges";
import {
  createBranch,
  deleteBranch,
  getBranch,
  listBranches,
  listRefs,
  listTags,
  setDefaultBranch,
  setPullRef,
} from "./refs";
import {
  DEFAULT_READER_LIMITS,
  type ReaderContext,
  type ReaderLimits,
  openSession,
  resolve,
  unavailable,
} from "./session";
import type { ReaderState } from "./state";
import { gitignoreFor, licenseFor, readmeFor } from "./templates";
import { listVersions, mapLines, pruneVersions, versionDiff } from "./versions";

export { ReaderState } from "./state";
export { DEFAULT_READER_LIMITS, type ReaderLimits } from "./session";

export interface LocalReaderOptions {
  readonly limits?: Partial<ReaderLimits>;
  readonly now?: () => number;
}

const statsOf = (repo: Repository): RepositoryStats => {
  const stats = repo.stats();
  return {
    sizeBytes: stats.sizeBytes,
    branchCount: stats.branches,
    tagCount: stats.tags,
    isEmpty: stats.branches === 0,
  };
};

async function init(
  cx: ReaderContext,
  input: InitInput,
): Promise<{ readonly headOid: string | null }> {
  const start = input.initialize;
  if (!start) {
    await cx.repo.init({ defaultBranch: input.defaultBranch });
    return { headOid: null };
  }
  const files: Array<{ name: string; content: string }> = [];
  if (start.readme) {
    files.push({ name: "README.md", content: readmeFor(start.title, start.description) });
  }
  const gitignore = start.gitignore === undefined ? null : gitignoreFor(start.gitignore);
  if (gitignore !== null) files.push({ name: ".gitignore", content: gitignore });
  const license =
    start.license === undefined
      ? null
      : licenseFor(start.license, new Date(cx.now()).getUTCFullYear(), start.author.name);
  if (license !== null) files.push({ name: "LICENSE", content: license });
  const made = await cx.repo.init({
    defaultBranch: input.defaultBranch,
    initial: {
      files,
      authorName: start.author.name.trim() !== "" ? start.author.name : "user",
      authorEmail: start.author.email,
    },
  });
  return { headOid: made.commit };
}

/** The reader of the repository `repo` holds, which must be open. */
export function localRepoReader(
  repo: Repository,
  state: ReaderState,
  locator: RepoLocator,
  options: LocalReaderOptions = {},
): RepoReader {
  const cx: ReaderContext = {
    repo,
    state,
    locator,
    limits: { ...DEFAULT_READER_LIMITS, ...options.limits },
    now: options.now ?? Date.now,
  };
  return {
    init: (input) => init(cx, input),
    destroy: async () => {
      await repo.destroy();
      state.clear();
    },
    forkFrom: async (sourceRepositoryId, { defaultBranchOnly }) => {
      const manifest = await repo.peer(sourceRepositoryId).forkManifest();
      await repo.importFork(
        defaultBranchOnly
          ? { ...manifest, refs: manifest.refs.filter((ref) => ref.name === manifest.head) }
          : manifest,
      );
      return statsOf(repo);
    },
    stats: async () => {
      if (!repo.isReady()) throw unavailable();
      return statsOf(repo);
    },
    setDefaultBranch: (name) => setDefaultBranch(cx, name),
    resolveRef: async (ref) => resolve(await openSession(cx), ref),
    listRefs: (input) => listRefs(cx, input),
    listBranches: (input) => listBranches(cx, input),
    getBranch: (name) => getBranch(cx, name),
    listTags: (input) => listTags(cx, input),
    createBranch: (input) => createBranch(cx, input),
    deleteBranch: (input) => deleteBranch(cx, input),
    setPullRef: (input) => setPullRef(cx, input),
    tree: (input) => tree(cx, input),
    treeLastCommits: (input) => treeLastCommits(cx, input),
    blob: (input) => blob(cx, input),
    latestCommit: (input) => latestCommit(cx, input),
    languages: (input) => languages(cx, input),
    terraformFiles: (input) => terraformFiles(cx, input),
    readme: (input) => readme(cx, input),
    listCommits: (input) => listCommits(cx, input),
    commits: (oids) => commits(cx, oids),
    commit: (sha) => commit(cx, sha),
    commitDiff: (sha, diffOptions) => commitDiff(cx, sha, diffOptions),
    compare: (input) => compare(cx, input),
    compareDiff: (input, diffOptions) => compareDiff(cx, input, diffOptions),
    commitsBetween: (input, page) => commitsBetween(cx, input, page),
    commitRange: (input) => commitRange(cx, input),
    blame: (input) => blame(cx, input),
    diffAnchor: (input) => diffAnchor(cx, input),
    mergeability: (input) => mergeability(cx, input),
    landed: (input) => landed(cx, input),
    merge: (input) => merge(cx, input),
    updateBranch: (input) => updateBranch(cx, input),
    listVersions: (input) => listVersions(cx, input),
    pruneVersions: (input) => pruneVersions(cx, input),
    versionDiff: (input, diffOptions) => versionDiff(cx, input, diffOptions),
    mapLines: (input) => mapLines(cx, input),
  };
}

/** The names of `RepoReader`'s methods: what travels as the method of a call to the Durable Object. */
export const READER_METHODS = [
  "init",
  "destroy",
  "forkFrom",
  "stats",
  "setDefaultBranch",
  "resolveRef",
  "listRefs",
  "listBranches",
  "getBranch",
  "listTags",
  "createBranch",
  "deleteBranch",
  "setPullRef",
  "tree",
  "treeLastCommits",
  "blob",
  "latestCommit",
  "languages",
  "terraformFiles",
  "readme",
  "listCommits",
  "commits",
  "commit",
  "commitDiff",
  "compare",
  "compareDiff",
  "commitsBetween",
  "commitRange",
  "blame",
  "diffAnchor",
  "mergeability",
  "merge",
  "updateBranch",
  "listVersions",
  "pruneVersions",
  "versionDiff",
  "mapLines",
] as const satisfies ReadonlyArray<keyof RepoReader>;
export type ReaderMethod = (typeof READER_METHODS)[number];

/** What a reader call answers across the object's boundary, where an error keeps only its message. */
export type ReaderReply =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly code: RepoReaderError["code"]; readonly message: string };

/** Runs one method by name and folds a refusal into the reply. Anything else thrown stays thrown. */
export async function callReader(
  reader: RepoReader,
  method: string,
  args: readonly unknown[],
): Promise<ReaderReply> {
  if (!(READER_METHODS as readonly string[]).includes(method)) {
    throw new Error(`no reader method ${JSON.stringify(method)}`);
  }
  try {
    const run = reader[method as ReaderMethod] as (...each: unknown[]) => Promise<unknown>;
    return { ok: true, value: await run(...args) };
  } catch (error) {
    if (error instanceof RepoReaderError) {
      return { ok: false, code: error.code, message: error.message };
    }
    // A bound of git-ops reached anywhere (a tree too large to list, a commit with too many
    // parents, a walk too long to be right) is the request being too large, not a failure.
    if (error instanceof GitError && error.code === "limit") {
      return { ok: false, code: "too_large", message: error.message };
    }
    throw error;
  }
}
