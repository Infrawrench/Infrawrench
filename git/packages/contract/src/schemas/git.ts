/**
 * Git content as the UI renders it: commits, trees, blobs, diffs and blame.
 *
 * These are precise on purpose. The UI draws them directly (a diff line is a
 * table row, a blame range is a gutter cell), so nothing here is "roughly" a
 * shape: line numbers are 1-based, counts are exact unless a `truncated` flag
 * beside them says otherwise, and text is the file's own with no diff prefix
 * and no trailing newline.
 */
import { Schema } from "effect";
import { BranchKey, IsoDateTime, Oid } from "./common";
import { UserRef } from "./people";

/** The name a commit or tag was written with. */
export const Signature = Schema.Struct({
  name: Schema.String,
  email: Schema.String,
  when: IsoDateTime.annotate({ description: "The instant, in UTC." }),
  timezoneOffset: Schema.Int.annotate({
    description: "Minutes east of UTC as written in the object (`+0100` is 60).",
  }),
}).annotate({ identifier: "Signature" });
export type Signature = typeof Signature.Type;

export const STATUS_STATES = ["pending", "success", "failure", "error"] as const;
export const StatusState = Schema.Literals(STATUS_STATES).annotate({
  identifier: "StatusState",
});
export type StatusState = typeof StatusState.Type;

/** A commit in a list: a history row, a tree entry's last change, a blame gutter. */
/** Someone a `Co-authored-by:` trailer names (`coAuthorsOf`). */
export const CoAuthor = Schema.Struct({
  name: Schema.String,
  email: Schema.String,
  user: Schema.NullOr(UserRef).annotate({
    description: "The Infrawrench user the email belongs to, when one does.",
  }),
}).annotate({ identifier: "CoAuthor" });
export type CoAuthor = typeof CoAuthor.Type;

export const CommitSummary = Schema.Struct({
  oid: Oid,
  summary: Schema.String.annotate({ description: "The message's first line." }),
  hasBody: Schema.Boolean.annotate({
    description: "The message has more than its first line.",
  }),
  author: Signature,
  committer: Signature,
  authorUser: Schema.NullOr(UserRef).annotate({
    description: "The Infrawrench user the author's email belongs to, when one does.",
  }),
  coAuthors: Schema.Array(CoAuthor).annotate({
    description:
      "The people the message's `Co-authored-by:` trailers name, besides the author. At most 20.",
  }),
  parents: Schema.Array(Oid),
  status: Schema.NullOr(StatusState).annotate({
    description:
      "The commit's combined status. Null when it has none, or when the list does not carry statuses.",
  }),
}).annotate({ identifier: "CommitSummary" });
export type CommitSummary = typeof CommitSummary.Type;

export const DIFF_FILE_STATUSES = [
  "added",
  "modified",
  "deleted",
  "renamed",
  "copied",
  "type_changed",
] as const;
export const DiffFileStatus = Schema.Literals(DIFF_FILE_STATUSES).annotate({
  identifier: "DiffFileStatus",
});
export type DiffFileStatus = typeof DiffFileStatus.Type;

export const TREE_ENTRY_MODES = ["040000", "100644", "100755", "120000", "160000"] as const;
export const TreeEntryMode = Schema.Literals(TREE_ENTRY_MODES).annotate({
  identifier: "TreeEntryMode",
  description:
    "`040000` directory, `100644` file, `100755` executable, `120000` symlink, `160000` submodule.",
});
export type TreeEntryMode = typeof TreeEntryMode.Type;

export const DiffStats = Schema.Struct({
  filesChanged: Schema.Int,
  additions: Schema.Int,
  deletions: Schema.Int,
}).annotate({ identifier: "DiffStats" });
export type DiffStats = typeof DiffStats.Type;

/** One line of a hunk. */
export const DiffLine = Schema.Struct({
  type: Schema.Literals(["context", "add", "delete"]),
  content: Schema.String.annotate({
    description: "The line's text, without the `+`/`-`/space prefix and without its newline.",
  }),
  oldLine: Schema.NullOr(Schema.Int).annotate({
    description: "1-based line number in the old file. Null for an added line.",
  }),
  newLine: Schema.NullOr(Schema.Int).annotate({
    description: "1-based line number in the new file. Null for a deleted line.",
  }),
  noNewlineAtEnd: Schema.optionalKey(
    Schema.Literal(true).annotate({
      description: "This is its side's last line and the file does not end in a newline.",
    }),
  ),
}).annotate({ identifier: "DiffLine" });
export type DiffLine = typeof DiffLine.Type;

/** `@@ -oldStart,oldLines +newStart,newLines @@ section`. */
export const DiffHunk = Schema.Struct({
  oldStart: Schema.Int,
  oldLines: Schema.Int,
  newStart: Schema.Int,
  newLines: Schema.Int,
  section: Schema.String.annotate({
    description: "The text after the second `@@` (the enclosing function), or empty.",
  }),
  lines: Schema.Array(DiffLine),
}).annotate({ identifier: "DiffHunk" });
export type DiffHunk = typeof DiffHunk.Type;

/** A changed file without its hunks: the file list of a commit or comparison. */
export const DiffFileSummary = Schema.Struct({
  path: Schema.String.annotate({ description: "The new path; the old one for a deletion." }),
  oldPath: Schema.NullOr(Schema.String).annotate({
    description: "Where it was, for a rename or copy. Null otherwise.",
  }),
  status: DiffFileStatus,
  oldMode: Schema.NullOr(TreeEntryMode),
  newMode: Schema.NullOr(TreeEntryMode),
  oldOid: Schema.NullOr(Oid),
  newOid: Schema.NullOr(Oid),
  binary: Schema.Boolean,
  additions: Schema.Int,
  deletions: Schema.Int,
  similarity: Schema.NullOr(Schema.Int).annotate({
    description: "Percent the old and new content share, for a rename or copy.",
  }),
}).annotate({ identifier: "DiffFileSummary" });
export type DiffFileSummary = typeof DiffFileSummary.Type;

/** A changed file with its hunks. */
export const DiffFile = Schema.Struct({
  ...DiffFileSummary.fields,
  hunks: Schema.Array(DiffHunk).annotate({
    description:
      "Empty for a binary file, a pure rename or mode change, and a file left out as too large.",
  }),
  tooLarge: Schema.Boolean.annotate({
    description:
      "The diff was left out for its size. `additions` and `deletions` are still exact; ask for the file alone (`path`) to get its hunks.",
  }),
}).annotate({ identifier: "DiffFile" });
export type DiffFile = typeof DiffFile.Type;

/**
 * A diff, one page of files at a time in path order. The first page of a big
 * change renders at once and the rest loads as the reader scrolls.
 */
export const Diff = Schema.Struct({
  baseOid: Schema.NullOr(Oid).annotate({
    description: "The old side's commit. Null for a root commit's diff.",
  }),
  headOid: Oid,
  stats: DiffStats.annotate({ description: "Of the whole diff, not of this page." }),
  files: Schema.Array(DiffFile),
  nextCursor: Schema.NullOr(Schema.String),
}).annotate({ identifier: "Diff" });
export type Diff = typeof Diff.Type;

/** `?path=&context=&whitespace=` on every endpoint that answers a {@link Diff}. */
export const DiffQuery = {
  path: Schema.optionalKey(
    Schema.String.annotate({
      description: "Only this file, with its hunks however large it is.",
    }),
  ),
  context: Schema.optionalKey(
    Schema.NumberFromString.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 0, maximum: 1000 }),
    ).annotate({ description: "Lines of context around each change. Default 3." }),
  ),
  whitespace: Schema.optionalKey(
    Schema.Literals(["show", "ignore"]).annotate({
      description: "`ignore` hides changes that only alter whitespace. Default `show`.",
    }),
  ),
} as const;

/** What a `ref` query resolved to. */
export const ResolvedRef = Schema.Struct({
  name: Schema.String.annotate({
    description: "The short name (`main`, `v1.2.0`), or the commit id for a commit.",
  }),
  kind: Schema.Literals(["branch", "tag", "commit"]),
  fullName: Schema.NullOr(Schema.String).annotate({
    description: "`refs/heads/main`. Null for a commit.",
  }),
  commitOid: Oid.annotate({ description: "The commit it points at (a tag peeled)." }),
}).annotate({ identifier: "ResolvedRef" });
export type ResolvedRef = typeof ResolvedRef.Type;

export const Commit = Schema.Struct({
  ...CommitSummary.fields,
  treeOid: Oid,
  message: Schema.String.annotate({ description: "The whole message." }),
  committerUser: Schema.NullOr(UserRef),
  signed: Schema.Boolean.annotate({
    description: "It carries a signature (`gpgsig`). Not a statement that the signature verifies.",
  }),
}).annotate({ identifier: "Commit" });
export type Commit = typeof Commit.Type;

/** One commit with what it changed, file by file, without hunks. */
export const CommitDetail = Schema.Struct({
  commit: Commit,
  stats: DiffStats,
  files: Schema.Array(DiffFileSummary),
  filesTruncated: Schema.Boolean.annotate({
    description: "The commit changes more files than are listed; `stats` still counts them all.",
  }),
  branches: Schema.Array(Schema.String).annotate({
    description: "Branches whose head is this commit.",
  }),
  tags: Schema.Array(Schema.String).annotate({ description: "Tags that point at this commit." }),
  branchPages: Schema.Array(Schema.Struct({ key: BranchKey, title: Schema.String })).annotate({
    description: "Branch pages this commit is the merge of, or part of.",
  }),
}).annotate({ identifier: "CommitDetail" });
export type CommitDetail = typeof CommitDetail.Type;

export const TREE_ENTRY_TYPES = ["tree", "blob", "symlink", "submodule"] as const;

export const TreeEntry = Schema.Struct({
  name: Schema.String,
  path: Schema.String.annotate({ description: "From the repository root." }),
  type: Schema.Literals(TREE_ENTRY_TYPES),
  mode: TreeEntryMode,
  oid: Oid,
  size: Schema.NullOr(Schema.Finite).annotate({
    description: "Bytes, for a file or symlink. Null for a directory or submodule.",
  }),
  lastCommit: Schema.NullOr(CommitSummary).annotate({
    description:
      "The newest commit that changed it. Null when the listing did not compute it (see `lastCommitsComplete`).",
  }),
}).annotate({ identifier: "TreeEntry" });
export type TreeEntry = typeof TreeEntry.Type;

/** A directory at a ref. Entries are sorted directories first, then by name. */
export const TreeListing = Schema.Struct({
  ref: ResolvedRef,
  path: Schema.String.annotate({ description: "Empty for the root." }),
  oid: Oid,
  entries: Schema.Array(TreeEntry),
  truncated: Schema.Boolean.annotate({
    description: "The directory has more entries than are listed.",
  }),
  lastCommit: Schema.NullOr(CommitSummary).annotate({
    description: "The newest commit that changed anything under this path.",
  }),
  lastCommitsComplete: Schema.Boolean.annotate({
    description:
      "Every entry carries its `lastCommit`. False when the history walk ran out of budget: ask `treeLastCommits` for the rest.",
  }),
  commitCount: Schema.NullOr(Schema.Int).annotate({
    description: "Commits reachable from the ref, on the root listing. Null when not counted.",
  }),
  readmePath: Schema.NullOr(Schema.String).annotate({
    description: "The README in this directory, when it has one.",
  }),
}).annotate({ identifier: "TreeListing" });
export type TreeListing = typeof TreeListing.Type;

export const TreeLastCommits = Schema.Struct({
  commitOid: Oid,
  path: Schema.String,
  commits: Schema.Record(Schema.String, CommitSummary).annotate({
    description: "By entry name.",
  }),
  complete: Schema.Boolean,
}).annotate({ identifier: "TreeLastCommits" });
export type TreeLastCommits = typeof TreeLastCommits.Type;

/**
 * A path's history line: its newest commit, and at the root how many
 * commits the ref has. Asked apart from the listing and the file, so a
 * folder or a file shows before its history is walked.
 */
export const LatestCommit = Schema.Struct({
  commit: Schema.NullOr(CommitSummary).annotate({
    description:
      "The newest commit that changed the path. Null when the bounded walk did not find it.",
  }),
  count: Schema.NullOr(Schema.Int).annotate({
    description:
      "Commits reachable from the ref, for the root. Null elsewhere or when not counted.",
  }),
}).annotate({ identifier: "LatestCommit" });
export type LatestCommit = typeof LatestCommit.Type;

/** The most text a blob answers inline. Larger files are `truncated`; fetch them raw. */
export const BLOB_TEXT_LIMIT_BYTES = 1024 * 1024;

/** A file at a ref. */
export const FileBlob = Schema.Struct({
  ref: ResolvedRef,
  path: Schema.String,
  name: Schema.String,
  oid: Oid,
  mode: TreeEntryMode,
  size: Schema.Finite.annotate({ description: "Bytes." }),
  binary: Schema.Boolean.annotate({
    description: "Not text (a NUL in its first 8000 bytes, or not valid UTF-8).",
  }),
  truncated: Schema.Boolean.annotate({
    description: `Text over ${BLOB_TEXT_LIMIT_BYTES} bytes: \`text\` is null; use \`rawUrl\`.`,
  }),
  text: Schema.NullOr(Schema.String).annotate({
    description:
      "The file as UTF-8, newlines as stored. Null when binary or truncated. A symlink's text is its target.",
  }),
  lineCount: Schema.NullOr(Schema.Int),
  lfs: Schema.NullOr(Schema.Struct({ oid: Schema.String, size: Schema.Finite })).annotate({
    description: "Set when the file is a Git LFS pointer.",
  }),
  rawUrl: Schema.String.annotate({
    description: "Its bytes, pinned to the commit (`urls.ts` `rawPath`).",
  }),
  lastCommit: Schema.NullOr(CommitSummary),
}).annotate({ identifier: "FileBlob" });
export type FileBlob = typeof FileBlob.Type;

/** Lines `startLine` to `startLine + lineCount - 1` were last changed by `commitOid`. */
export const BlameRange = Schema.Struct({
  startLine: Schema.Int.annotate({ description: "1-based, in the file as blamed." }),
  lineCount: Schema.Int,
  commitOid: Oid,
  originalStartLine: Schema.Int.annotate({
    description: "Where the lines were in `originalPath` at `commitOid`.",
  }),
  originalPath: Schema.String.annotate({
    description: "The file's path in that commit, which differs after a rename.",
  }),
  previousCommitOid: Schema.NullOr(Oid).annotate({
    description:
      "The commit to blame from to see what the lines were before. Null at the file's first commit.",
  }),
}).annotate({ identifier: "BlameRange" });
export type BlameRange = typeof BlameRange.Type;

export const Blame = Schema.Struct({
  ref: ResolvedRef,
  path: Schema.String,
  ranges: Schema.Array(BlameRange).annotate({
    description: "In line order, covering every line exactly once.",
  }),
  commits: Schema.Record(Schema.String, CommitSummary).annotate({
    description: "Every commit a range names, by id.",
  }),
  blob: FileBlob,
}).annotate({ identifier: "Blame" });
export type Blame = typeof Blame.Type;

export const BranchPageBadge = Schema.Struct({
  key: BranchKey,
  title: Schema.String,
  state: Schema.Literals(["open", "closed", "merged"]),
  draft: Schema.Boolean,
}).annotate({ identifier: "BranchPageBadge" });
export type BranchPageBadge = typeof BranchPageBadge.Type;

export const Branch = Schema.Struct({
  name: Schema.String,
  commit: CommitSummary,
  isDefault: Schema.Boolean,
  protected: Schema.Boolean,
  ahead: Schema.NullOr(Schema.Int).annotate({
    description: "Commits it has that the default branch does not. Null on the default branch.",
  }),
  behind: Schema.NullOr(Schema.Int).annotate({
    description: "Commits the default branch has that it does not.",
  }),
  page: Schema.NullOr(BranchPageBadge).annotate({
    description: "The branch's page: the open one, or the newest.",
  }),
  viewerCanDelete: Schema.Boolean,
}).annotate({ identifier: "Branch" });
export type Branch = typeof Branch.Type;

export const GitTag = Schema.Struct({
  name: Schema.String,
  oid: Oid.annotate({ description: "What the ref points at: a tag object or a commit." }),
  annotated: Schema.Boolean,
  tagger: Schema.NullOr(Signature),
  message: Schema.NullOr(Schema.String),
  commit: Schema.NullOr(CommitSummary).annotate({
    description: "The commit it leads to. Null for a tag of a tree or blob.",
  }),
}).annotate({ identifier: "GitTag" });
export type GitTag = typeof GitTag.Type;

/** Enough refs for a branch and tag picker. */
export const Refs = Schema.Struct({
  defaultBranch: Schema.String,
  branches: Schema.Array(Schema.Struct({ name: Schema.String, oid: Oid })),
  tags: Schema.Array(Schema.Struct({ name: Schema.String, oid: Oid })),
  branchesTruncated: Schema.Boolean,
  tagsTruncated: Schema.Boolean,
}).annotate({ identifier: "Refs" });
export type Refs = typeof Refs.Type;

/** `base...head`: what `head` has that `base` does not, from their merge base. */
export const Comparison = Schema.Struct({
  base: ResolvedRef,
  head: ResolvedRef,
  headRepository: Schema.Struct({ owner: Schema.String, name: Schema.String }),
  mergeBaseOid: Schema.NullOr(Oid).annotate({
    description: "Null when the two share no history.",
  }),
  ahead: Schema.Int,
  behind: Schema.Int,
  commits: Schema.Array(CommitSummary).annotate({ description: "Oldest first." }),
  commitsTruncated: Schema.Boolean,
  stats: DiffStats,
  files: Schema.Array(DiffFileSummary),
  filesTruncated: Schema.Boolean,
  mergeable: Schema.NullOr(Schema.Boolean).annotate({
    description: "Whether `head` merges into `base` without conflicts. Null when not checked.",
  }),
  page: Schema.NullOr(BranchPageBadge).annotate({
    description: "The head branch's open page, when it has one.",
  }),
}).annotate({ identifier: "Comparison" });
export type Comparison = typeof Comparison.Type;

export const CommitStatus = Schema.Struct({
  id: Schema.String,
  context: Schema.String.annotate({
    description: "What reported it (`Infrawrench CI / test`). One status per context per commit.",
  }),
  state: StatusState,
  description: Schema.NullOr(Schema.String),
  targetUrl: Schema.NullOr(Schema.String),
  creator: Schema.NullOr(UserRef),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).annotate({ identifier: "CommitStatus" });
export type CommitStatus = typeof CommitStatus.Type;

/**
 * Every status of a commit and the one state they add up to: `failure` if any
 * failed or errored, else `pending` if any is pending, else `success`.
 */
export const CombinedStatus = Schema.Struct({
  sha: Oid,
  state: Schema.NullOr(StatusState).annotate({ description: "Null when it has no statuses." }),
  statuses: Schema.Array(CommitStatus),
}).annotate({ identifier: "CombinedStatus" });
export type CombinedStatus = typeof CombinedStatus.Type;

export const CommitStatusCreate = Schema.Struct({
  context: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)),
  state: StatusState,
  description: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(1000)))),
  targetUrl: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(2000)))),
}).annotate({ identifier: "CommitStatusCreate" });
export type CommitStatusCreate = typeof CommitStatusCreate.Type;
