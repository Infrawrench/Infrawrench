/**
 * A `RepoReader` over nothing but maps, for tests: branches that point at
 * made-up commit ids, files by path, and switches for the answers a test
 * wants to force (conflicts, a head that is behind). It knows no Git; it
 * knows what the handlers ask and answers in the contract's shapes.
 */
import type { Commit, CommitSummary, FileBlob, ResolvedRef } from "@infrawrench/git-contract";
import {
  type MergeInput,
  type ReaderBranch,
  type RepoLocator,
  type RepoReader,
  RepoReaderError,
  unavailableRepoReader,
} from "../../repo/reader";
import type { RepoReaderFactory } from "../../repo/select";

const hex = (n: number): string => n.toString(16).padStart(40, "0");

export interface FakeRepository {
  readonly branches: Map<string, string>;
  /** `refs/pull/<n>/head`. */
  readonly pullRefs: Map<number, string>;
  /** `path` to text, at every ref. */
  readonly files: Map<string, string>;
  defaultBranch: string;
  destroyed: boolean;
}

export interface FakeStorage {
  readonly readers: RepoReaderFactory;
  readonly repositories: Map<string, FakeRepository>;
  /** Commits by id: their messages and authors. Unknown ids get a plain one. */
  readonly commits: Map<string, { message: string; email: string }>;
  /** Head commits whose merge into anything conflicts. */
  readonly conflicting: Set<string>;
  /** What `commitRange` answers for a head commit. */
  readonly ranges: Map<string, string[]>;
  readonly merges: MergeInput[];
  /** A new commit id, different every time. */
  nextOid(): string;
  /** The repository's state, created on first use. */
  repository(id: string): FakeRepository;
}

export const fakeStorage = (): FakeStorage => {
  let counter = 0x1000;
  const repositories = new Map<string, FakeRepository>();
  const commits = new Map<string, { message: string; email: string }>();
  const conflicting = new Set<string>();
  const ranges = new Map<string, string[]>();
  const merges: MergeInput[] = [];
  const nextOid = () => hex(++counter);

  const repository = (id: string): FakeRepository => {
    let found = repositories.get(id);
    if (!found) {
      found = {
        branches: new Map(),
        pullRefs: new Map(),
        files: new Map(),
        defaultBranch: "main",
        destroyed: false,
      };
      repositories.set(id, found);
    }
    return found;
  };

  const summary = (oid: string): CommitSummary => {
    const known = commits.get(oid);
    const message = known?.message ?? `Commit ${oid.slice(-6)}`;
    const signature = {
      name: "Test Author",
      email: known?.email ?? "author@example.test",
      when: "2026-11-01T00:00:00.000Z",
      timezoneOffset: 0,
    };
    return {
      oid,
      summary: message.split("\n")[0] ?? "",
      hasBody: message.includes("\n"),
      author: signature,
      committer: signature,
      authorUser: null,
      parents: [],
      status: null,
    };
  };

  const full = (oid: string): Commit => ({
    ...summary(oid),
    treeOid: hex(0xeeee),
    message: commits.get(oid)?.message ?? `Commit ${oid.slice(-6)}`,
    committerUser: null,
    signed: false,
  });

  const readers: RepoReaderFactory = (_env, locator: RepoLocator): RepoReader => {
    const repo = () => repository(locator.id);

    const resolve = (ref: string | undefined): ResolvedRef => {
      const state = repo();
      if (state.branches.size === 0) throw new RepoReaderError("repository_empty");
      const name = ref ?? state.defaultBranch;
      const oid = state.branches.get(name);
      if (oid) return { name, kind: "branch", fullName: `refs/heads/${name}`, commitOid: oid };
      if (/^[0-9a-f]{40}$/.test(name)) {
        return { name, kind: "commit", fullName: null, commitOid: name };
      }
      throw new RepoReaderError("ref_not_found");
    };

    /** Anywhere a head may be: a branch here, a branch of the head repository, or a commit id. */
    const resolveIn = (ref: string, repositoryId: string | undefined): ResolvedRef => {
      if (repositoryId === undefined || repositoryId === locator.id) return resolve(ref);
      const oid = repository(repositoryId).branches.get(ref);
      if (oid) return { name: ref, kind: "branch", fullName: `refs/heads/${ref}`, commitOid: oid };
      return resolve(ref);
    };

    const branch = (name: string): ReaderBranch | null => {
      const oid = repo().branches.get(name);
      if (!oid) return null;
      const isDefault = name === repo().defaultBranch;
      return {
        name,
        commit: summary(oid),
        ahead: isDefault ? null : 1,
        behind: isDefault ? null : 0,
      };
    };

    const blob = (ref: string | undefined, path: string): FileBlob => {
      const resolved = resolve(ref);
      const text = repo().files.get(path);
      if (text === undefined) {
        // A path that is a prefix of a file is a directory.
        const isDirectory = [...repo().files.keys()].some((file) => file.startsWith(`${path}/`));
        throw new RepoReaderError(isDirectory ? "not_a_file" : "path_not_found");
      }
      return {
        ref: resolved,
        path,
        name: path.split("/").pop() ?? path,
        oid: hex(0xb10b),
        mode: "100644",
        size: text.length,
        binary: false,
        truncated: false,
        text,
        lineCount: text.split("\n").length,
        lfs: null,
        rawUrl: `/${locator.owner}/${locator.name}/raw/${resolved.commitOid}/${path}`,
        lastCommit: null,
      };
    };

    return {
      ...unavailableRepoReader,
      init: async (input) => {
        const state = repo();
        state.defaultBranch = input.defaultBranch;
        if (!input.initialize) return { headOid: null };
        const oid = nextOid();
        state.branches.set(input.defaultBranch, oid);
        if (input.initialize.readme) state.files.set("README.md", `# ${input.initialize.title}\n`);
        return { headOid: oid };
      },
      destroy: async () => {
        repo().destroyed = true;
      },
      forkFrom: async (sourceRepositoryId) => {
        const source = repository(sourceRepositoryId);
        const state = repo();
        for (const [name, oid] of source.branches) state.branches.set(name, oid);
        for (const [path, text] of source.files) state.files.set(path, text);
        state.defaultBranch = source.defaultBranch;
        return {
          sizeBytes: 1024,
          branchCount: state.branches.size,
          tagCount: 0,
          isEmpty: state.branches.size === 0,
        };
      },
      stats: async () => ({
        sizeBytes: 2048,
        branchCount: repo().branches.size,
        tagCount: 0,
        isEmpty: repo().branches.size === 0,
      }),
      setDefaultBranch: async (name) => {
        if (!repo().branches.has(name)) throw new RepoReaderError("ref_not_found");
        repo().defaultBranch = name;
      },
      resolveRef: async (ref) => resolve(ref),
      listRefs: async () => ({
        branches: [...repo().branches].map(([name, oid]) => ({ name, oid })),
        tags: [],
        branchesTruncated: false,
        tagsTruncated: false,
      }),
      getBranch: async (name) => branch(name),
      createBranch: async ({ name, from }) => {
        const state = repo();
        if (state.branches.has(name)) throw new RepoReaderError("ref_exists");
        state.branches.set(name, resolve(from).commitOid);
        return branch(name)!;
      },
      deleteBranch: async ({ name, expectedOid }) => {
        const state = repo();
        const oid = state.branches.get(name);
        if (!oid) throw new RepoReaderError("ref_not_found");
        if (expectedOid !== undefined && expectedOid !== oid)
          throw new RepoReaderError("head_moved");
        state.branches.delete(name);
        return { oid };
      },
      setPullRef: async ({ number, oid }) => {
        if (oid === null) repo().pullRefs.delete(number);
        else repo().pullRefs.set(number, oid);
      },
      blob: async ({ ref, path }) => blob(ref, path),
      readme: async ({ ref }) => (repo().files.has("README.md") ? blob(ref, "README.md") : null),
      commits: async (oids) =>
        oids
          .filter(
            (oid) =>
              commits.has(oid) ||
              [...repositories.values()].some((state) =>
                [...state.branches.values()].includes(oid),
              ),
          )
          .map(summary),
      commitRange: async ({ head }) => (ranges.get(head) ?? [head]).map(full),
      commitsBetween: async ({ head }) => ({ items: [summary(head)], nextCursor: null }),
      compare: async ({ base, head, headRepositoryId }) => {
        const resolvedBase = resolve(base);
        const resolvedHead = resolveIn(head, headRepositoryId);
        const same = resolvedBase.commitOid === resolvedHead.commitOid;
        return {
          base: resolvedBase,
          head: resolvedHead,
          mergeBaseOid: resolvedBase.commitOid,
          ahead: same ? 0 : 1,
          behind: 0,
          commits: same ? [] : [summary(resolvedHead.commitOid)],
          commitsTruncated: false,
          stats: same
            ? { filesChanged: 0, additions: 0, deletions: 0 }
            : { filesChanged: 1, additions: 3, deletions: 1 },
          files: [],
          filesTruncated: false,
          mergeable: same ? null : !conflicting.has(resolvedHead.commitOid),
        };
      },
      compareDiff: async ({ base, head, headRepositoryId }) => ({
        baseOid: resolve(base).commitOid,
        headOid: resolveIn(head, headRepositoryId).commitOid,
        stats: { filesChanged: 0, additions: 0, deletions: 0 },
        files: [],
        nextCursor: null,
      }),
      diffAnchor: async ({ line }) =>
        line > 100
          ? null
          : { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, section: "", lines: [] },
      mergeability: async ({ baseRef, headOid }) => {
        const baseOid = repo().branches.get(baseRef);
        if (!baseOid) throw new RepoReaderError("ref_not_found");
        return {
          state: conflicting.has(headOid) ? "conflicting" : "clean",
          conflictFiles: conflicting.has(headOid) ? ["README.md"] : [],
          baseOid,
          headOid,
          mergeBaseOid: baseOid,
          aheadBy: 1,
          behindBy: 0,
        };
      },
      merge: async (input) => {
        merges.push(input);
        if (conflicting.has(input.headOid)) {
          return { merged: false, reason: "conflicts", conflictFiles: ["README.md"] };
        }
        const commitOid = nextOid();
        repo().branches.set(input.baseRef, commitOid);
        return { merged: true, commitOid };
      },
    };
  };

  return { readers, repositories, commits, conflicting, ranges, merges, nextOid, repository };
};
