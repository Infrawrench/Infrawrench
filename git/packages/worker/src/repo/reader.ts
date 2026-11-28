/**
 * `RepoReader`: everything the JSON API asks of a repository's Git storage.
 *
 * The API handlers (`src/api/`) and the queue consumer (`src/events/`) never
 * read a Git object themselves. They call this interface, and whoever owns
 * the storage (the per-repository Durable Object `RepoDO` over R2, with
 * `@infrawrench/git-core` and `@infrawrench/git-ops`) implements it. This file
 * is that implementer's spec; `./select.ts` is the one place the
 * implementation is chosen. It is `./queries/`, run inside the repository's
 * Durable Object and reached through `./reader-do.ts`.
 * {@link unavailableRepoReader}, whose every method refuses with
 * `unavailable` (a 503 on the API), is what a test without storage passes.
 *
 * ## Rules for an implementation
 *
 * - **One reader is one repository**, named by {@link RepoLocator}. Its `id`
 *   is `git_repositories.id`, which is also the Durable Object's name
 *   (`env.REPO.idFromName(id)`) and the R2 prefix (`repos/<id>/`). `owner` and
 *   `name` are only for building URLs (`FileBlob.rawUrl`); never key storage
 *   by them, since renames and transfers move nothing.
 * - **Answers are in the contract's shapes** (`@infrawrench/git-contract`),
 *   with what only Postgres knows left neutral: `CommitSummary.authorUser`
 *   and `Commit.committerUser` are null and `CommitSummary.status` is null.
 *   The handlers fill those in. Shapes with more Postgres in them than Git
 *   (`Branch`, `Comparison`, `CommitDetail`) have a `Reader*` twin here
 *   without those fields.
 * - **Refusals are {@link RepoReaderError}s** with a `code` from
 *   {@link REPO_READER_CODES}. The handlers turn each into the API's own
 *   error (the table is `src/api/reader-errors.ts`). Anything else thrown is a
 *   500. A missing repository (never initialised, or destroyed) is
 *   `unavailable`.
 * - **Refs are resolved the contract's way** ({@link RefInput}): a full ref
 *   name, else a branch, else a tag, else a commit id (full, or an
 *   unambiguous abbreviation of 4 or more hex digits). A name that is both a
 *   branch and a tag is the branch. Undefined means the default branch (the
 *   Durable Object's `HEAD`); an empty repository refuses `repository_empty`.
 * - **Every ref change is serialised by the Durable Object** and is a
 *   compare-and-swap: `createBranch` only if the name is free, `deleteBranch`
 *   and `merge` only if the ref still points where the caller says. A change
 *   that goes through sends the same `GitPushEvent` to the `EVENTS` queue as a
 *   push does (`env.ts`), with the `actor` given, so pull requests are
 *   synchronised and CI starts whichever way a ref moved.
 * - **Protected branches are not this interface's business** for the write
 *   methods here: the handler has already checked the rules
 *   (`db/policy-rules.ts`). The push path (`ReceiveHooks`) checks them
 *   itself.
 * - **Pages are cursors**: `{ items, nextCursor }`, `nextCursor` opaque and
 *   null on the last page. `limit` has been clamped to 1..100 by the caller.
 * - **Budgets**: a method that walks history (`tree` with `lastCommits`,
 *   `listCommits` with a path, `blame`) must bound its work and say so in
 *   its answer (`lastCommitsComplete: false`, `truncated`), never run until
 *   the Worker's CPU limit.
 */
import type {
  Blame,
  Commit,
  CommitSummary,
  Diff,
  DiffFileSummary,
  DiffHunk,
  FileBlob,
  GitTag,
  LatestCommit,
  MergeMethod,
  ResolvedRef,
  TreeLastCommits,
  TreeListing,
} from "@infrawrench/git-contract";
import type { TerraformSnapshot } from "@infrawrench/git-terraform";
import type { GitEventActor } from "../env";

/** What `languages` answers. */
export interface RepositoryLanguages {
  readonly commitOid: string;
  readonly languages: ReadonlyArray<{ readonly name: string; readonly bytes: number }>;
  /** The walk stopped at `LANGUAGE_LIMITS` before seeing every file. */
  readonly truncated: boolean;
}

/** What `terraformFiles` answers: a commit's Terraform files, read in one walk. */
export interface TerraformFiles {
  readonly commitOid: string;
  /** The commit's root tree: what a scan is cached by. */
  readonly treeOid: string;
  readonly snapshot: TerraformSnapshot;
}

/** Which repository a reader is for. */
export interface RepoLocator {
  /** `git_repositories.id`: the Durable Object's name and the R2 prefix. */
  readonly id: string;
  /** The namespace's slug, as spelled. For URLs only. */
  readonly owner: string;
  /** The repository's name, as spelled. For URLs only. */
  readonly name: string;
}

/** A ref as a person names it; undefined is the default branch. */
export type RefInput = string | undefined;

export const REPO_READER_CODES = [
  /** The storage did not answer, or there is no implementation yet. API: 503. */
  "unavailable",
  /** A ref, or a commit id, that resolves to nothing. API: 404 (422 where the contract says so). */
  "ref_not_found",
  /** The tree at the commit has no such path. API: 404. */
  "path_not_found",
  /** A file was asked for and the path is a directory (or, for blame, binary). API: 422. */
  "not_a_file",
  /** A directory was asked for and the path is a file. API: 422. */
  "not_a_directory",
  /** Over the text limit for what was asked (blame). API: 422. */
  "too_large",
  /** No branch yet: nothing has been pushed. API: 422. */
  "repository_empty",
  /** `createBranch`: the name is taken. API: 409. */
  "ref_exists",
  /** A compare-and-swap lost: the ref is not where the caller expected. API: 409. */
  "head_moved",
  /** Not a name Git accepts for a ref. API: 400. */
  "invalid_ref",
] as const;
export type RepoReaderCode = (typeof REPO_READER_CODES)[number];

/** A refusal from the storage. `message` is a sentence a person can read. */
export class RepoReaderError extends Error {
  readonly code: RepoReaderCode;
  constructor(code: RepoReaderCode, message?: string) {
    super(message ?? code);
    this.name = "RepoReaderError";
    this.code = code;
  }
}

export interface ReaderPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export interface PageInput {
  readonly cursor?: string | undefined;
  /** Already clamped to 1..100. */
  readonly limit: number;
}

/** Who a commit made by the forge (a merge, an initial commit) is by. */
export interface CommitIdentity {
  readonly name: string;
  readonly email: string;
}

/** `Branch` without what Postgres adds (`isDefault`, `protected`, `pullRequest`, `viewerCanDelete`). */
export interface ReaderBranch {
  readonly name: string;
  readonly commit: CommitSummary;
  /** Commits it has that the default branch does not. Null on the default branch. */
  readonly ahead: number | null;
  /** Commits the default branch has that it does not. Null on the default branch. */
  readonly behind: number | null;
}

/** `Refs` without `defaultBranch`, which is the repository row's. */
export interface ReaderRefs {
  readonly branches: ReadonlyArray<{ readonly name: string; readonly oid: string }>;
  readonly tags: ReadonlyArray<{ readonly name: string; readonly oid: string }>;
  readonly branchesTruncated: boolean;
  readonly tagsTruncated: boolean;
}

/** `CommitDetail` without `pullRequests`, which is a Postgres lookup by commit id. */
export interface ReaderCommitDetail {
  readonly commit: Commit;
  readonly stats: Diff["stats"];
  /** Against the first parent; every file for a root commit. Capped: see `filesTruncated`. */
  readonly files: readonly DiffFileSummary[];
  readonly filesTruncated: boolean;
  /** Branches whose head is this commit. */
  readonly branches: readonly string[];
  /** Tags that point at this commit. */
  readonly tags: readonly string[];
}

/** `Comparison` without `headRepository` and `pullRequest`. */
export interface ReaderComparison {
  readonly base: ResolvedRef;
  readonly head: ResolvedRef;
  /** Null when the two share no history. */
  readonly mergeBaseOid: string | null;
  readonly ahead: number;
  readonly behind: number;
  /** What `head` has that `base` does not, oldest first, capped. */
  readonly commits: readonly CommitSummary[];
  readonly commitsTruncated: boolean;
  readonly stats: Diff["stats"];
  readonly files: readonly DiffFileSummary[];
  readonly filesTruncated: boolean;
  /** Whether `head` merges into `base` without conflicts. Null when not checked. */
  readonly mergeable: boolean | null;
}

/**
 * The two sides of a comparison. `base` is always in this reader's
 * repository. `head` is in `headRepositoryId` when that is set and is not
 * this repository (a fork, or the parent): the implementation reads the
 * head's objects from that repository's storage.
 */
export interface CompareInput {
  readonly base: string;
  readonly head: string;
  readonly headRepositoryId?: string | undefined;
}

export interface DiffOptions extends PageInput {
  /** Only this file, with its hunks however large it is. */
  readonly path?: string | undefined;
  /** Lines of context around each change. Default 3. */
  readonly context?: number | undefined;
  /** `ignore` hides changes that only alter whitespace. */
  readonly whitespace?: "show" | "ignore" | undefined;
}

export interface ListBranchesInput extends PageInput {
  /** Only names containing this. */
  readonly q?: string | undefined;
  /**
   * `active`: head committed in the last three months. `stale`: not.
   * `mine`: head authored by one of `authorEmails`. Default `all`.
   */
  readonly view?: "all" | "active" | "stale" | "mine" | undefined;
  /** The caller's email addresses, for `view: "mine"`. */
  readonly authorEmails?: readonly string[] | undefined;
}

export interface ListCommitsInput extends PageInput {
  readonly ref: RefInput;
  /** Only commits that changed this file or directory. */
  readonly path?: string | undefined;
  /** Only commits whose author email is one of these (compared lowercased). */
  readonly authorEmails?: readonly string[] | undefined;
  /** ISO-8601 instants, by committer date. */
  readonly since?: string | undefined;
  readonly until?: string | undefined;
  /** With a file `path`: keep going through renames. */
  readonly follow?: boolean | undefined;
}

/** What a trial merge of a pull request says, without moving anything. */
export interface ReaderMergeability {
  readonly state: "clean" | "conflicting";
  /** Paths that conflict, when `conflicting`. */
  readonly conflictFiles: readonly string[];
  /** The two heads the trial read, so the caller can tell a stale answer. */
  readonly baseOid: string;
  readonly headOid: string;
  readonly mergeBaseOid: string | null;
  /** Commits the head has that the base does not, and the reverse. */
  readonly aheadBy: number;
  readonly behindBy: number;
}

/** The most heads one `landed` call measures. */
export const MAX_LANDED_HEADS = 100;
/**
 * How far back along the base's first-parent line `landed` looks for the
 * commit a head landed in. It doubles its way back, so a branch merged long
 * ago costs a few more trial merges, not one per commit.
 */
export const LANDED_SEARCH = 10_000;

/**
 * Which heads a base branch already has the changes of (`landedIn` in
 * git-ops), measured against `baseOid`, its tip when it was read. One
 * answer per head asked about, in order: null when it is not in, conflicts,
 * or could not be told (a head commit that is not here, a merge over the
 * limits); else how it landed, `contained` when the head commit is in the
 * base's history and `applied` when merging it would leave the base's tree as
 * it is (a squash, a cherry-pick), and `commitOid`, the commit on the base's
 * first-parent line that brought it in: the oldest there that has it, within
 * {@link LANDED_SEARCH} commits of the tip.
 */
export interface ReaderLanded {
  readonly baseOid: string;
  readonly heads: ReadonlyArray<{
    readonly landing: "contained" | "applied";
    readonly commitOid: string;
  } | null>;
}

export interface MergeInput {
  /** The branch to move, in this repository (short name). */
  readonly baseRef: string;
  /** The repository the head commit is in: this one, or a fork. */
  readonly headRepositoryId: string;
  /** The commit to merge. The caller has checked it is the pull request's current head. */
  readonly headOid: string;
  readonly method: MergeMethod;
  /** The merge or squash commit's first line. Ignored by `rebase`. */
  readonly title: string;
  /** The rest of its message; may be empty. Ignored by `rebase`. */
  readonly message: string;
  /** The merging person: committer of what is written, and author of a merge commit. */
  readonly committer: CommitIdentity;
  /** Who the resulting push event names. */
  readonly actor: GitEventActor | null;
}

/**
 * - `merged`: the base branch now points at `commitOid` (the merge commit,
 *   the squash commit, or the last replayed commit; the head itself when a
 *   `merge` or `rebase` was a fast-forward that needed no new commit is NOT
 *   taken for `merge`, which always writes a merge commit).
 * - `conflicts`: nothing moved.
 * - `base_moved`: the base branch moved while the merge was being computed
 *   and the retry budget ran out; nothing moved. The caller answers 409.
 */
export type MergeOutcome =
  | { readonly merged: true; readonly commitOid: string }
  | { readonly merged: false; readonly reason: "conflicts"; readonly conflictFiles: string[] }
  | { readonly merged: false; readonly reason: "base_moved" };

export interface UpdateBranchInput {
  /** The branch to bring up to date, in this repository (the pull request's head repository). */
  readonly headRef: string;
  /** Refuse with `head_moved` unless the branch still points here. */
  readonly expectedHeadOid?: string | undefined;
  /** The repository and branch to take changes from (the pull request's base). */
  readonly baseRepositoryId: string;
  readonly baseRef: string;
  /** `merge`: merge the base into the head. `rebase`: replay the head onto the base (a forced update). */
  readonly method: "merge" | "rebase";
  readonly committer: CommitIdentity;
  readonly actor: GitEventActor | null;
}

export type UpdateBranchOutcome =
  | { readonly updated: true; readonly headOid: string }
  | { readonly updated: false; readonly reason: "conflicts"; readonly conflictFiles: string[] }
  | { readonly updated: false; readonly reason: "up_to_date"; readonly headOid: string };

export interface InitInput {
  readonly defaultBranch: string;
  /**
   * Start the repository with one commit. Omitted: empty, ready for a first
   * push. `gitignore` is a template name (`Terraform`, `Node`) and `license`
   * an SPDX id; an unknown one is left out rather than refused.
   */
  readonly initialize?:
    | {
        readonly readme: boolean;
        readonly gitignore?: string | undefined;
        readonly license?: string | undefined;
        readonly author: CommitIdentity;
        /** For the README's heading and first paragraph. */
        readonly title: string;
        readonly description: string | null;
      }
    | undefined;
}

/** What the repository row keeps of the storage, sampled after a push and on demand. */
export interface RepositoryStats {
  /** Bytes of packs in R2. */
  readonly sizeBytes: number;
  readonly branchCount: number;
  readonly tagCount: number;
  /** No branch yet. */
  readonly isEmpty: boolean;
}

/** The anchor of a new review thread: lines of one side of a pull request's diff. */
export interface DiffAnchorInput {
  /** The pull request's merge base and head, both commit ids. */
  readonly baseOid: string;
  readonly headOid: string;
  /** Where the head commit is, when it is not this repository. */
  readonly headRepositoryId?: string | undefined;
  readonly path: string;
  readonly side: "LEFT" | "RIGHT";
  /** The (last) line, numbered in its side's file. */
  readonly line: number;
  readonly startLine?: number | undefined;
}

/** A version of a branch as the storage recorded it (`do/versions.ts`). */
export interface ReaderVersion {
  /** Short (`feature/x`). */
  readonly branch: string;
  readonly lineage: number;
  readonly number: number;
  readonly tipOid: string;
  /** The branch's commit before the push; null for a lineage's first version. */
  readonly previousOid: string | null;
  readonly forced: boolean;
  /** Milliseconds since the epoch. */
  readonly at: number;
}

/** A version's two ends: its commit, and the merge base it was recorded with. */
export interface VersionSide {
  readonly tipOid: string;
  readonly baseOid: string | null;
}

export interface VersionDiffInput {
  /** The older version, for what `to` changed since it. Null: the whole change of `to`, base to tip. */
  readonly from: VersionSide | null;
  readonly to: VersionSide;
  /**
   * One of the versions is pruned: its ref is gone, so its commit is read
   * only while a branch, a tag or another ref still reaches it. Otherwise
   * `ref_not_found`, whether or not the objects are still stored.
   */
  readonly reachableOnly?: boolean;
}

export interface ReaderVersionDiff {
  readonly diff: Diff;
  /** The two versions have different bases. */
  readonly rebased: boolean;
  /** False when the older version could not be carried to the newer base: the diff is tip to tip. */
  readonly exact: boolean;
}

/** Lines of a file, by whatever `key` the caller knows them. */
export interface LineAnchor {
  readonly key: string;
  readonly path: string;
  /** The (last) line, 1-based. */
  readonly line: number;
  readonly startLine: number | null;
}

export type MappedLine =
  | { readonly key: string; readonly line: number; readonly startLine: number | null }
  | { readonly key: string; readonly changed: true };

export interface RepoReader {
  // -------------------------------------------------------------------------
  // The repository itself
  // -------------------------------------------------------------------------

  /**
   * Create the storage for a new repository: the Durable Object's tables, a
   * `HEAD` naming `defaultBranch`, and the initial commit when asked. Called
   * once, right after the row is inserted; calling it again on a repository
   * that has refs must change nothing. Answers the initial commit's id, or
   * null for an empty repository.
   */
  init(input: InitInput): Promise<{ readonly headOid: string | null }>;

  /**
   * Delete everything: the Durable Object's state (`deleteAll`) and every
   * object under `repos/<id>/` in R2. Called after the row is gone, from
   * `ctx.waitUntil`, so it must be safe to retry and must not need the row.
   */
  destroy(): Promise<void>;

  /**
   * Make this (new, empty) repository a copy of `sourceRepositoryId`: its
   * objects (shared or copied, the implementation's choice, but deleting
   * either repository must not break the other), its branches (only the
   * source's default branch when `defaultBranchOnly`) and its `HEAD`. Tags
   * are copied with the branches unless `defaultBranchOnly`.
   */
  forkFrom(
    sourceRepositoryId: string,
    options: { readonly defaultBranchOnly: boolean },
  ): Promise<RepositoryStats>;

  /** Pack bytes and ref counts, for the repository row. Cheap: read from the Durable Object's catalogue. */
  stats(): Promise<RepositoryStats>;

  /** Point `HEAD` at an existing branch. `ref_not_found` when there is no such branch. */
  setDefaultBranch(name: string): Promise<void>;

  // -------------------------------------------------------------------------
  // Refs
  // -------------------------------------------------------------------------

  /** What a ref a person typed names. `ref_not_found`, `repository_empty`. */
  resolveRef(ref: RefInput): Promise<ResolvedRef>;

  /** Branch and tag names for a ref picker: the default branch first, then by most recent commit. */
  listRefs(input: { readonly q?: string | undefined; readonly limit: number }): Promise<ReaderRefs>;

  /** Branches, the default branch first, then newest commit first. */
  listBranches(input: ListBranchesInput): Promise<ReaderPage<ReaderBranch>>;

  /** One branch by its short name, or null. */
  getBranch(name: string): Promise<ReaderBranch | null>;

  /** Tags, newest first (by tagger date for an annotated tag, else the commit's). */
  listTags(input: PageInput & { readonly q?: string | undefined }): Promise<ReaderPage<GitTag>>;

  /**
   * Create `refs/heads/<name>` at what `from` resolves to. `ref_exists` when
   * the name is taken, `ref_not_found` when `from` resolves to nothing,
   * `invalid_ref` for a name Git refuses. `from` may also be a full commit id
   * that is no longer reachable from any ref (restoring a deleted pull
   * request branch): objects are kept until a repack prunes them.
   */
  createBranch(input: {
    readonly name: string;
    readonly from: string;
    readonly actor: GitEventActor | null;
  }): Promise<ReaderBranch>;

  /**
   * Delete `refs/heads/<name>`. `ref_not_found` when there is none,
   * `head_moved` when `expectedOid` is given and the branch is elsewhere.
   * Answers the commit it pointed at.
   */
  deleteBranch(input: {
    readonly name: string;
    readonly expectedOid?: string | undefined;
    readonly actor: GitEventActor | null;
  }): Promise<{ readonly oid: string }>;

  /**
   * Keep `refs/pull/<number>/head` in this (the base) repository pointing at
   * a pull request's head, copying the head's objects in from
   * `headRepositoryId` when that is a fork. CI fetches a fork's commits
   * through this ref (NOTES-ci.md section 2). `oid: null` removes the ref (a
   * closed pull request keeps its ref; only a deleted repository loses it).
   * Never sends a push event.
   */
  setPullRef(input: {
    readonly number: number;
    readonly headRepositoryId: string;
    readonly oid: string | null;
  }): Promise<void>;

  // -------------------------------------------------------------------------
  // Content
  // -------------------------------------------------------------------------

  /**
   * A directory at a ref. `not_a_directory` when the path is a file. With
   * `lastCommits: false` every entry's `lastCommit` is null and no history is
   * walked; otherwise as many as the budget allows, and
   * `lastCommitsComplete` says whether that was all.
   */
  tree(input: {
    readonly ref: RefInput;
    readonly path: string;
    readonly lastCommits: boolean;
  }): Promise<TreeListing>;

  /** The last commit of each entry of a directory, continuing where `tree` stopped. */
  treeLastCommits(input: {
    readonly ref: RefInput;
    readonly path: string;
  }): Promise<TreeLastCommits>;

  /**
   * A file at a ref: text up to `BLOB_TEXT_LIMIT_BYTES` inline, larger and
   * binary files as metadata. `rawUrl` is `rawPath(locator, commitOid,
   * path)` from the contract. `not_a_file` when the path is a directory.
   */
  blob(input: {
    readonly ref: RefInput;
    readonly path: string;
    /** `false`: no history walk, `lastCommit` null (ask `latestCommit`). Default true. */
    readonly lastCommit?: boolean;
  }): Promise<FileBlob>;

  /** Bytes of each language at a ref, most first (`queries/content.ts` `languages`). */
  languages(input: { readonly ref: RefInput }): Promise<RepositoryLanguages>;

  /**
   * Every Terraform file at a ref (`isTerraformScanFile`), with its text, in
   * one walk bounded by `SNAPSHOT_LIMITS` (`truncated` past them). What a
   * Terraform scan reads instead of a call per directory.
   */
  terraformFiles(input: { readonly ref: RefInput }): Promise<TerraformFiles>;

  /** A path's newest commit, and at the root how many commits the ref has. */
  latestCommit(input: { readonly ref: RefInput; readonly path: string }): Promise<LatestCommit>;

  /**
   * A directory's README, or null: `README.md` first, then `README`,
   * `README.txt`, `README.rst`, any case; at the root also
   * `.infrawrench/README.md` and `docs/README.md`.
   */
  readme(input: { readonly ref: RefInput; readonly path: string }): Promise<FileBlob | null>;

  // -------------------------------------------------------------------------
  // History
  // -------------------------------------------------------------------------

  /** History from a ref, newest first. */
  listCommits(input: ListCommitsInput): Promise<ReaderPage<CommitSummary>>;

  /**
   * The commits with these full ids, in the order given; ids the repository
   * does not have are left out (so an empty answer means "no such commit").
   * What the timeline, CI run titles and `statuses.create` use.
   */
  commits(oids: readonly string[]): Promise<readonly CommitSummary[]>;

  /** One commit by a full or abbreviated id, with what it changed. `ref_not_found`. */
  commit(sha: string): Promise<ReaderCommitDetail>;

  /** A commit's diff against its first parent, with hunks, paged by file. */
  commitDiff(sha: string, options: DiffOptions): Promise<Diff>;

  /** `base...head`: what `head` has that `base` does not, from their merge base. */
  compare(input: CompareInput): Promise<ReaderComparison>;

  /** The same comparison's diff (merge base to head), with hunks, paged by file. */
  compareDiff(input: CompareInput, options: DiffOptions): Promise<Diff>;

  /**
   * The commits of `base..head` (both commit ids, `head` possibly in
   * `headRepositoryId`), oldest first, paged. A pull request's commits tab.
   */
  commitsBetween(input: CompareInput, page: PageInput): Promise<ReaderPage<CommitSummary>>;

  /**
   * The commits a push added, with their whole messages, oldest first and
   * capped at `limit` (the newest are kept when there are more). `base` is
   * the commit the ref moved from; null for a ref that was created, which
   * then means the commits reachable from `head` and from no other branch.
   * The queue consumer reads `Fixes #12` and a pull request's pushed commits
   * from this.
   */
  commitRange(input: {
    readonly base: string | null;
    readonly head: string;
    readonly limit: number;
  }): Promise<readonly Commit[]>;

  /** Who last changed each line. `too_large`, `not_a_file` (a directory or a binary file). */
  blame(input: { readonly ref: RefInput; readonly path: string }): Promise<Blame>;

  /**
   * The hunk a new review thread is anchored to: the lines it is on with a
   * few of context, as the diff from `baseOid` to `headOid` shows them. Null
   * when the diff does not show those lines on that side (the API then
   * answers 422).
   */
  diffAnchor(input: DiffAnchorInput): Promise<DiffHunk | null>;

  // -------------------------------------------------------------------------
  // Merging
  // -------------------------------------------------------------------------

  /**
   * A trial merge of `headOid` (in `headRepositoryId`) into `baseRef`, moving
   * nothing. `ref_not_found` when the base branch or the head commit is
   * gone. Asked on every view of an open pull request, so cache it by the
   * pair of heads; the API also keeps the answer on the pull request row.
   */
  mergeability(input: {
    readonly baseRef: string;
    readonly headRepositoryId: string;
    readonly headOid: string;
  }): Promise<ReaderMergeability>;

  /**
   * Whether `baseRef` already has what each head changes (see
   * {@link ReaderLanded}), moving nothing. The heads are commits that are
   * already here: a fork's reach the base through `refs/pull/<n>/head`, and
   * nothing is copied in to answer. At most {@link MAX_LANDED_HEADS} heads
   * (`too_large` past that); `ref_not_found` when
   * the base branch is gone.
   */
  landed(input: {
    readonly baseRef: string;
    readonly heads: readonly string[];
  }): Promise<ReaderLanded>;

  /**
   * Merge a pull request's head into its base branch and move the branch,
   * atomically in the Durable Object. See {@link MergeOutcome}.
   *
   * - `merge`: a merge commit with parents (base, head), authored and
   *   committed by `committer`, message `title` + blank line + `message`.
   * - `squash`: one commit on the base with the merged tree, authored by
   *   the head commit's author and committed by `committer`.
   * - `rebase`: each commit of `base..head` replayed onto the base, authors
   *   kept, committed by `committer`; a fast-forward when nothing needs
   *   replaying.
   */
  merge(input: MergeInput): Promise<MergeOutcome>;

  /** Bring a pull request's head branch up to date with its base. See {@link UpdateBranchInput}. */
  updateBranch(input: UpdateBranchInput): Promise<UpdateBranchOutcome>;

  // -------------------------------------------------------------------------
  // Versions of branches
  // -------------------------------------------------------------------------

  /**
   * The versions the storage recorded for a branch (short name), oldest
   * first: one per push to a branch that is not the default branch, numbered
   * in the transaction that moved it. `after` leaves out what the caller has
   * already copied. Capped; ask again from the last one.
   */
  listVersions(input: {
    readonly branch: string;
    readonly after?: { readonly lineage: number; readonly number: number } | undefined;
  }): Promise<readonly ReaderVersion[]>;

  /**
   * Forget versions: their records and the refs that kept their commits
   * readable. Safe to repeat, and on a repository that is gone.
   */
  pruneVersions(input: {
    readonly branch: string;
    readonly versions: ReadonlyArray<{ readonly lineage: number; readonly number: number }>;
  }): Promise<{ readonly dropped: number }>;

  /**
   * A version's diff, paged by file: its whole change, or what it changed
   * since an older version with each taken against its own base, so a rebase
   * alone shows nothing. The commit ids are the forge's own records and are
   * read as given.
   */
  versionDiff(input: VersionDiffInput, options: DiffOptions): Promise<ReaderVersionDiff>;

  /**
   * Where lines of files at `fromOid` are at `toOid`, for carrying review
   * comments from one version to the next: the new numbers when every line
   * an anchor covers is unchanged, `changed` otherwise.
   */
  mapLines(input: {
    readonly fromOid: string;
    readonly toOid: string;
    readonly anchors: readonly LineAnchor[];
  }): Promise<readonly MappedLine[]>;
}

const refuse = (): Promise<never> =>
  Promise.reject(new RepoReaderError("unavailable", "Repository contents are not available yet"));

/**
 * A reader with no storage behind it: every method refuses with
 * `unavailable`, which the API answers as a 503. For tests, and for
 * spreading under a fake that implements only what a test needs.
 */
export const unavailableRepoReader: RepoReader = {
  init: refuse,
  destroy: refuse,
  forkFrom: refuse,
  stats: refuse,
  setDefaultBranch: refuse,
  resolveRef: refuse,
  listRefs: refuse,
  listBranches: refuse,
  getBranch: refuse,
  listTags: refuse,
  createBranch: refuse,
  deleteBranch: refuse,
  setPullRef: refuse,
  tree: refuse,
  treeLastCommits: refuse,
  blob: refuse,
  latestCommit: refuse,
  languages: refuse,
  terraformFiles: refuse,
  readme: refuse,
  listCommits: refuse,
  commits: refuse,
  commit: refuse,
  commitDiff: refuse,
  compare: refuse,
  compareDiff: refuse,
  commitsBetween: refuse,
  commitRange: refuse,
  blame: refuse,
  diffAnchor: refuse,
  mergeability: refuse,
  landed: refuse,
  merge: refuse,
  updateBranch: refuse,
  listVersions: refuse,
  pruneVersions: refuse,
  versionDiff: refuse,
  mapLines: refuse,
};

/** Whether an error is the storage saying it is not there (yet). */
export const isUnavailable = (error: unknown): boolean =>
  error instanceof RepoReaderError && error.code === "unavailable";
