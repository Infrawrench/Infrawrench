import { isValidRefName, type Branch, type FileBlob, type GitTag } from "@infrawrench/git-contract";
import { badRequest, conflict, defineMockHandlers, mockError, ok, paginate } from "../define";
import {
  currentUser,
  findRepository,
  gitOf,
  headRepositoryOf,
  requireUser,
  toRepository,
  type RepositoryRecord,
} from "../db";
import { copyObjects } from "../git-write";
import { findPage, openPageOf, toBranchPageSummary } from "../threads-data";
import {
  aheadBehind,
  blameOf,
  blobAt,
  diffCommits,
  fullCommit,
  lastCommitFor,
  listTree,
  log,
  mergeBase,
  rawDataUrl,
  readmeIn,
  resolveRef,
  statsOf,
  summarize,
  summaryOf,
  type GitFixture,
} from "../git";
import { splitLines } from "../diff";

const LFS_POINTER =
  /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:([0-9a-f]{64})\nsize (\d+)\n$/;

function fileBlob(fx: GitFixture, ref: string | undefined, path: string): FileBlob {
  const resolved = resolveRef(fx, ref);
  const { mode, oid, blob } = blobAt(fx, resolved.commitOid, path);
  const text = blob.binary ? null : blob.text;
  const lfs = text === null ? null : LFS_POINTER.exec(text);
  return {
    ref: resolved,
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    oid,
    mode,
    size: blob.size,
    binary: blob.binary,
    truncated: false,
    text,
    lineCount: text === null ? null : splitLines(text).lines.length,
    lfs: lfs ? { oid: lfs[1]!, size: Number(lfs[2]) } : null,
    rawUrl: rawDataUrl(blob, path),
    lastCommit: summarize(fx, lastCommitFor(fx, resolved.commitOid, path)),
  };
}

function toBranch(
  repo: RepositoryRecord,
  fx: GitFixture,
  name: string,
  canDelete: boolean,
): Branch {
  const oid = fx.branches[name]!;
  const isDefault = name === fx.defaultBranch;
  const distance = isDefault ? null : aheadBehind(fx, fx.branches[fx.defaultBranch]!, oid);
  return {
    name,
    commit: summarize(fx, oid),
    isDefault,
    protected: isDefault || name.startsWith("release/"),
    ahead: distance ? distance.ahead.length : null,
    behind: distance ? distance.behind.length : null,
    page: isDefault ? null : pageBadge(repo, name),
    viewerCanDelete: canDelete && !isDefault && !name.startsWith("release/"),
  };
}

/** A branch's page as a badge: the open one, or the newest. Null for a branch with none yet. */
function pageBadge(repo: RepositoryRecord, name: string) {
  let thread;
  try {
    thread = findPage(repo, name);
  } catch {
    return null;
  }
  const page = toBranchPageSummary(repo, thread);
  return { key: page.key, title: page.title, state: page.state, draft: page.draft };
}

/**
 * `base...head`, the head read in its own repository: a fork's branch is
 * resolved there and its objects copied here, where the diff is worked out.
 */
function comparison(fx: GitFixture, base: string, head: string, headFx: GitFixture = fx) {
  const baseRef = resolveRef(fx, base);
  const headRef = resolveRef(headFx, head);
  if (headFx !== fx) copyObjects(headFx, fx, headRef.commitOid);
  const mergeBaseOid = mergeBase(fx, baseRef.commitOid, headRef.commitOid);
  const distance = aheadBehind(fx, baseRef.commitOid, headRef.commitOid);
  return { baseRef, headRef, mergeBaseOid, distance };
}

export default defineMockHandlers({
  contents: {
    listRefs: ({ params, query }) => {
      const repo = findRepository(params.owner, params.repo);
      if (repo.fixture === null) {
        return {
          defaultBranch: repo.defaultBranch,
          branches: [],
          tags: [],
          branchesTruncated: false,
          tagsTruncated: false,
        };
      }
      const fx = gitOf(repo);
      const q = query?.q?.toLowerCase() ?? "";
      const matches = (name: string) => name.toLowerCase().includes(q);
      return {
        defaultBranch: fx.defaultBranch,
        branches: Object.entries(fx.branches)
          .filter(([name]) => matches(name))
          .map(([name, oid]) => ({ name, oid }))
          .sort(
            (a, b) =>
              Number(b.name === fx.defaultBranch) - Number(a.name === fx.defaultBranch) ||
              a.name.localeCompare(b.name),
          ),
        tags: Object.entries(fx.tags)
          .filter(([name]) => matches(name))
          .map(([name, tag]) => ({ name, oid: tag.commit }))
          .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true })),
        branchesTruncated: false,
        tagsTruncated: false,
      };
    },
    listBranches: ({ params, query }) => {
      const repo = findRepository(params.owner, params.repo);
      if (repo.fixture === null) return { items: [], nextCursor: null };
      const fx = gitOf(repo);
      const canDelete = toRepository(repo).viewer.canPush;
      const me = currentUser();
      const staleBefore = Date.now() - 14 * 86_400_000;
      const branches = Object.keys(fx.branches)
        .filter((name) => name.toLowerCase().includes(query?.q?.toLowerCase() ?? ""))
        .map((name) => toBranch(repo, fx, name, canDelete))
        .filter((branch) => {
          const when = Date.parse(branch.commit.committer.when);
          switch (query?.view ?? "all") {
            case "active":
              return !branch.isDefault && when >= staleBefore;
            case "stale":
              return !branch.isDefault && when < staleBefore;
            case "mine":
              return me !== null && branch.commit.authorUser?.id === me.id;
            default:
              return true;
          }
        })
        .sort(
          (a, b) =>
            Number(b.isDefault) - Number(a.isDefault) ||
            b.commit.committer.when.localeCompare(a.commit.committer.when),
        );
      return paginate(branches, query);
    },
    createBranch: ({ params, payload }) => {
      requireUser();
      const repo = findRepository(params.owner, params.repo);
      const fx = gitOf(repo);
      if (!isValidRefName(payload.name)) throw badRequest("That is not a valid branch name");
      if (fx.branches[payload.name] !== undefined) {
        throw conflict("A branch with that name already exists", "ref_exists");
      }
      fx.branches[payload.name] = resolveRef(fx, payload.from).commitOid;
      return toBranch(repo, fx, payload.name, true);
    },
    deleteBranch: ({ params, query }) => {
      requireUser();
      const repo = findRepository(params.owner, params.repo);
      const fx = gitOf(repo);
      if (fx.branches[query.name] === undefined) {
        throw mockError(404, "No branch by that name", "ref_not_found");
      }
      if (query.name === fx.defaultBranch) {
        throw mockError(422, "The default branch cannot be deleted", "protected_branch");
      }
      if (query.expectedOid !== undefined && fx.branches[query.name] !== query.expectedOid) {
        throw conflict("The branch moved since the page loaded", "head_moved");
      }
      delete fx.branches[query.name];
      return ok;
    },
    listTags: ({ params, query }) => {
      const repo = findRepository(params.owner, params.repo);
      if (repo.fixture === null) return { items: [], nextCursor: null };
      const fx = gitOf(repo);
      const tags = Object.entries(fx.tags)
        .filter(([name]) => name.toLowerCase().includes(query?.q?.toLowerCase() ?? ""))
        .map(([name, tag]): GitTag => ({
          name,
          oid: tag.oid,
          annotated: tag.annotated,
          tagger: tag.tagger,
          message: tag.message,
          commit: summarize(fx, tag.commit),
        }))
        .sort((a, b) =>
          (b.commit?.committer.when ?? "").localeCompare(a.commit?.committer.when ?? ""),
        );
      return paginate(tags, query);
    },
    tree: ({ params, query }) => {
      const fx = gitOf(findRepository(params.owner, params.repo));
      const ref = resolveRef(fx, query?.ref);
      const path = query?.path ?? "";
      const withLastCommits = query?.lastCommits !== "false";
      const { oid, entries } = listTree(fx, ref.commitOid, path, withLastCommits);
      return {
        ref,
        path,
        oid,
        entries,
        truncated: false,
        lastCommit: summarize(fx, lastCommitFor(fx, ref.commitOid, path)),
        lastCommitsComplete: withLastCommits,
        commitCount: path === "" ? log(fx, ref.commitOid).length : null,
        readmePath: readmeIn(fx, ref.commitOid, path),
      };
    },
    treeLastCommits: ({ params, query }) => {
      const fx = gitOf(findRepository(params.owner, params.repo));
      const ref = resolveRef(fx, query?.ref);
      const path = query?.path ?? "";
      const { entries } = listTree(fx, ref.commitOid, path, true);
      return {
        commitOid: ref.commitOid,
        path,
        commits: Object.fromEntries(entries.map((entry) => [entry.name, entry.lastCommit!])),
        complete: true,
      };
    },
    blob: ({ params, query }) => {
      const file = fileBlob(
        gitOf(findRepository(params.owner, params.repo)),
        query.ref,
        query.path,
      );
      return query.lastCommit === "false" ? { ...file, lastCommit: null } : file;
    },
    latestCommit: ({ params, query }) => {
      const fx = gitOf(findRepository(params.owner, params.repo));
      const ref = resolveRef(fx, query?.ref);
      const path = query?.path ?? "";
      return {
        commit: summarize(fx, lastCommitFor(fx, ref.commitOid, path)),
        count: path === "" ? log(fx, ref.commitOid).length : null,
      };
    },
    readme: ({ params, query }) => {
      const fx = gitOf(findRepository(params.owner, params.repo));
      const ref = resolveRef(fx, query?.ref);
      const path = readmeIn(fx, ref.commitOid, query?.path ?? "");
      return { readme: path === null ? null : fileBlob(fx, ref.commitOid, path) };
    },
    listCommits: ({ params, query }) => {
      const fx = gitOf(findRepository(params.owner, params.repo));
      const ref = resolveRef(fx, query?.ref);
      const author = query?.author?.toLowerCase();
      const commits = log(fx, ref.commitOid, query?.path)
        .map((oid) => summarize(fx, oid))
        .filter(
          (commit) =>
            (author === undefined ||
              commit.author.email.toLowerCase().includes(author) ||
              commit.author.name.toLowerCase().includes(author) ||
              commit.authorUser?.username?.toLowerCase() === author) &&
            (query?.since === undefined || commit.committer.when >= query.since) &&
            (query?.until === undefined || commit.committer.when <= query.until),
        );
      return paginate(commits, query);
    },
    commit: ({ params }) => {
      const fx = gitOf(findRepository(params.owner, params.repo));
      const commit = fullCommit(fx, params.sha);
      const files = diffCommits(fx, commit.parents[0] ?? null, commit.oid, { hunks: false });
      return {
        commit,
        stats: statsOf(files),
        files: files.map(summaryOf),
        filesTruncated: false,
        branches: Object.entries(fx.branches)
          .filter(([, oid]) => oid === commit.oid)
          .map(([name]) => name),
        tags: Object.entries(fx.tags)
          .filter(([, tag]) => tag.commit === commit.oid)
          .map(([name]) => name),
        branchPages: commit.summary.startsWith("Merge pull request #7")
          ? [{ key: "feature/flow-logs", title: "network: optional VPC flow logs" }]
          : [],
      };
    },
    commitDiff: ({ params, query }) => {
      const fx = gitOf(findRepository(params.owner, params.repo));
      const commit = fullCommit(fx, params.sha);
      const base = commit.parents[0] ?? null;
      const all = diffCommits(fx, base, commit.oid, { hunks: false });
      const files = diffCommits(fx, base, commit.oid, {
        context: query?.context,
        path: query?.path,
      });
      const page = paginate(files, { cursor: query?.cursor, limit: query?.limit ?? 20 });
      return {
        baseOid: base,
        headOid: commit.oid,
        stats: statsOf(all),
        files: page.items,
        nextCursor: page.nextCursor,
      };
    },
    compare: ({ params, query }) => {
      const repo = findRepository(params.owner, params.repo);
      const fx = gitOf(repo);
      const headRepo = headRepositoryOf(repo, query.headRepository);
      const { baseRef, headRef, mergeBaseOid, distance } = comparison(
        fx,
        query.base,
        query.head,
        gitOf(headRepo),
      );
      const files =
        mergeBaseOid === null
          ? []
          : diffCommits(fx, mergeBaseOid, headRef.commitOid, { hunks: false });
      return {
        base: baseRef,
        head: headRef,
        headRepository: { owner: headRepo.owner.slug, name: headRepo.name },
        mergeBaseOid,
        ahead: distance.ahead.length,
        behind: distance.behind.length,
        commits: distance.ahead.map((oid) => summarize(fx, oid)).reverse(),
        commitsTruncated: false,
        stats: statsOf(files),
        files: files.map(summaryOf),
        filesTruncated: false,
        mergeable: distance.ahead.length === 0 ? null : true,
        page: (() => {
          if (headRef.kind !== "branch") return null;
          const open = openPageOf(
            repo,
            headRef.name,
            headRepo === repo ? undefined : `${headRepo.owner.slug}/${headRepo.name}`,
          );
          if (open === undefined) return null;
          const page = toBranchPageSummary(repo, open);
          return { key: page.key, title: page.title, state: page.state, draft: page.draft };
        })(),
      };
    },
    compareDiff: ({ params, query }) => {
      const repo = findRepository(params.owner, params.repo);
      const headRepo = headRepositoryOf(repo, query.headRepository);
      const fx = gitOf(repo);
      const { headRef, mergeBaseOid } = comparison(fx, query.base, query.head, gitOf(headRepo));
      const all =
        mergeBaseOid === null
          ? []
          : diffCommits(fx, mergeBaseOid, headRef.commitOid, { hunks: false });
      const files =
        mergeBaseOid === null
          ? []
          : diffCommits(fx, mergeBaseOid, headRef.commitOid, {
              context: query.context,
              path: query.path,
            });
      const page = paginate(files, { cursor: query.cursor, limit: query.limit ?? 20 });
      return {
        baseOid: mergeBaseOid,
        headOid: headRef.commitOid,
        stats: statsOf(all),
        files: page.items,
        nextCursor: page.nextCursor,
      };
    },
    blame: ({ params, query }) => {
      const fx = gitOf(findRepository(params.owner, params.repo));
      const blob = fileBlob(fx, query.ref, query.path);
      if (blob.text === null) throw mockError(422, "Binary files have no blame", "not_a_file");
      const { ranges, commits } = blameOf(fx, blob.ref.commitOid, query.path);
      return { ref: blob.ref, path: query.path, ranges, commits, blob };
    },
  },
});
