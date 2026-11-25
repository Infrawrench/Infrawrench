/**
 * `/api/repos/:owner/:repo`: what is in the repository. Refs, branches and
 * tags, trees and files, history, single commits, comparisons, diffs and
 * blame.
 *
 * Refs and paths travel in the query string (`?ref=feature/x&path=src/a.ts`),
 * never in the path: both contain slashes. Every answer says what its `ref`
 * resolved to, and anything derived from it is keyed by the commit id, so a
 * page can be cached and a branch moving under a reader is visible.
 *
 * Raw file bytes and archives are plain URLs, not endpoints here: `urls.ts`.
 */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { RequiredAccess, SuccessDescription } from "../http/annotations";
import { Authentication, RepositoryAccess } from "../http/auth";
import { BadRequest, Conflict, UnprocessableEntity } from "../http/errors";
import {
  CommitSha,
  IsoDateTime,
  Ok,
  Page,
  PageQuery,
  PathQuery,
  QueryFlag,
  RefQuery,
  RepoParams,
} from "../schemas/common";
import {
  Blame,
  FileBlob,
  Branch,
  CommitDetail,
  CommitSummary,
  Comparison,
  Diff,
  DiffQuery,
  Refs,
  GitTag,
  TreeListing,
  TreeLastCommits,
} from "../schemas/git";

const CommitParams = { ...RepoParams, sha: CommitSha } as const;

const compareQuery = {
  base: Schema.String.annotate({
    description: "A branch, tag or commit of this repository.",
  }),
  head: Schema.String.annotate({
    description: "A branch, tag or commit: of this repository, or of `headRepository`.",
  }),
  headRepository: Schema.optionalKey(
    Schema.String.annotate({
      description: "`owner/name` of a fork (or the parent) that `head` is in.",
    }),
  ),
} as const;

export class ContentsGroup extends HttpApiGroup.make("contents")
  .add(
    HttpApiEndpoint.get("listRefs", "/refs", {
      params: RepoParams,
      query: {
        q: Schema.optionalKey(
          Schema.String.annotate({ description: "Only names containing this." }),
        ),
        limit: PageQuery.limit,
      },
      success: Refs,
    })
      .annotate(RequiredAccess, "read")
      .annotate(OpenApi.Summary, "Branch and tag names, for a ref picker")
      .annotate(
        OpenApi.Description,
        "The default branch first, then by most recent commit. Up to `limit` of each; search with `q` for the rest.",
      )
      .annotate(SuccessDescription, "Refs"),
    HttpApiEndpoint.get("listBranches", "/branches", {
      params: RepoParams,
      query: {
        ...PageQuery,
        q: Schema.optionalKey(Schema.String),
        view: Schema.optionalKey(
          Schema.Literals(["all", "active", "stale", "mine"]).annotate({
            description:
              "`active`: committed to in the last three months. `stale`: not. `mine`: whose head the caller authored. Default `all`.",
          }),
        ),
      },
      success: Page(Branch),
    })
      .annotate(RequiredAccess, "read")
      .annotate(OpenApi.Summary, "Branches, with how far each is from the default branch")
      .annotate(SuccessDescription, "Branches, the default branch first, then newest commit first"),
    HttpApiEndpoint.post("createBranch", "/branches", {
      params: RepoParams,
      payload: Schema.Struct({
        name: Schema.String,
        from: Schema.String.annotate({
          description: "A branch, tag or commit to start it at.",
        }),
      }),
      success: Branch,
      error: [BadRequest, Conflict, UnprocessableEntity],
    })
      .annotate(RequiredAccess, "write")
      .annotate(OpenApi.Summary, "Create a branch")
      .annotate(
        OpenApi.Description,
        "409 `ref_exists`; 422 `ref_not_found` when `from` does not resolve, `protected_branch` when a rule refuses the name.",
      )
      .annotate(SuccessDescription, "The branch"),
    HttpApiEndpoint.delete("deleteBranch", "/branches", {
      params: RepoParams,
      query: {
        name: Schema.String,
        expectedOid: Schema.optionalKey(
          Schema.String.annotate({
            description: "Refuse (409 `head_moved`) unless the branch still points here.",
          }),
        ),
      },
      success: Ok,
      error: [BadRequest, Conflict, UnprocessableEntity],
    })
      .annotate(RequiredAccess, "write")
      .annotate(OpenApi.Summary, "Delete a branch")
      .annotate(
        OpenApi.Description,
        "The default branch and a protected branch that does not allow deletion are refused (422).",
      )
      .annotate(SuccessDescription, "Deleted"),
    HttpApiEndpoint.get("listTags", "/tags", {
      params: RepoParams,
      query: { ...PageQuery, q: Schema.optionalKey(Schema.String) },
      success: Page(GitTag),
    })
      .annotate(RequiredAccess, "read")
      .annotate(OpenApi.Summary, "Tags")
      .annotate(SuccessDescription, "Tags, newest first"),
    HttpApiEndpoint.get("tree", "/tree", {
      params: RepoParams,
      query: {
        ref: RefQuery,
        path: PathQuery,
        lastCommits: Schema.optionalKey(
          QueryFlag.annotate({
            description:
              "`false` skips the per-entry history walk, for callers that only need names. Default `true`.",
          }),
        ),
      },
      success: TreeListing,
      error: UnprocessableEntity,
    })
      .annotate(RequiredAccess, "read")
      .annotate(OpenApi.Summary, "A directory at a ref")
      .annotate(
        OpenApi.Description,
        "404 `ref_not_found` or `path_not_found`; 422 `not_a_directory` when the path is a file (ask `blob`), `repository_empty` when nothing has been pushed.",
      )
      .annotate(SuccessDescription, "The directory's entries"),
    HttpApiEndpoint.get("treeLastCommits", "/tree/last-commits", {
      params: RepoParams,
      query: { ref: RefQuery, path: PathQuery },
      success: TreeLastCommits,
      error: UnprocessableEntity,
    })
      .annotate(RequiredAccess, "read")
      .annotate(OpenApi.Summary, "The last commit of each entry of a directory")
      .annotate(
        OpenApi.Description,
        "What `tree` left out when its history walk ran out of budget. Pass the commit id `tree` resolved as `ref`.",
      )
      .annotate(SuccessDescription, "Commits by entry name"),
    HttpApiEndpoint.get("blob", "/blob", {
      params: RepoParams,
      query: { ref: RefQuery, path: Schema.String },
      success: FileBlob,
      error: UnprocessableEntity,
    })
      .annotate(RequiredAccess, "read")
      .annotate(OpenApi.Summary, "A file at a ref")
      .annotate(
        OpenApi.Description,
        "Text up to 1 MiB inline; larger and binary files answer their metadata and `rawUrl`. 422 `not_a_file` when the path is a directory.",
      )
      .annotate(SuccessDescription, "The file"),
    HttpApiEndpoint.get("readme", "/readme", {
      params: RepoParams,
      query: { ref: RefQuery, path: PathQuery },
      success: Schema.Struct({
        readme: Schema.NullOr(FileBlob).annotate({
          description: "Null when the directory has none.",
        }),
      }),
    })
      .annotate(RequiredAccess, "read")
      .annotate(OpenApi.Summary, "A directory's README")
      .annotate(
        OpenApi.Description,
        "`README.md` first, then `README`, `README.txt`, `README.rst`, any case; at the root also `.infrawrench/README.md` and `docs/README.md`.",
      )
      .annotate(SuccessDescription, "The README, or null"),
    HttpApiEndpoint.get("listCommits", "/commits", {
      params: RepoParams,
      query: {
        ...PageQuery,
        ref: RefQuery,
        path: Schema.optionalKey(
          Schema.String.annotate({
            description: "Only commits that changed this file or directory.",
          }),
        ),
        author: Schema.optionalKey(
          Schema.String.annotate({ description: "A username, or an author email." }),
        ),
        since: Schema.optionalKey(IsoDateTime),
        until: Schema.optionalKey(IsoDateTime),
        follow: Schema.optionalKey(
          QueryFlag.annotate({
            description: "With a file `path`: keep going through renames. Default `false`.",
          }),
        ),
      },
      success: Page(CommitSummary),
      error: UnprocessableEntity,
    })
      .annotate(RequiredAccess, "read")
      .annotate(OpenApi.Summary, "History from a ref")
      .annotate(SuccessDescription, "Commits, newest first, each with its combined status"),
    HttpApiEndpoint.get("commit", "/commits/:sha", {
      params: CommitParams,
      success: CommitDetail,
    })
      .annotate(RequiredAccess, "read")
      .annotate(OpenApi.Summary, "One commit and what it changed")
      .annotate(
        OpenApi.Description,
        "The changed files with their counts, against the first parent. The hunks are `commitDiff`.",
      )
      .annotate(SuccessDescription, "The commit"),
    HttpApiEndpoint.get("commitDiff", "/commits/:sha/diff", {
      params: CommitParams,
      query: { ...PageQuery, ...DiffQuery },
      success: Diff,
    })
      .annotate(RequiredAccess, "read")
      .annotate(OpenApi.Summary, "A commit's diff, with hunks")
      .annotate(SuccessDescription, "The diff against its first parent"),
    HttpApiEndpoint.get("compare", "/compare", {
      params: RepoParams,
      query: compareQuery,
      success: Comparison,
      error: UnprocessableEntity,
    })
      .annotate(RequiredAccess, "read")
      .annotate(OpenApi.Summary, "Compare two refs: `base...head`")
      .annotate(
        OpenApi.Description,
        "What `head` has that `base` does not, from their merge base: the commits and the changed files. The page a pull request is opened from.",
      )
      .annotate(SuccessDescription, "The comparison"),
    HttpApiEndpoint.get("compareDiff", "/compare/diff", {
      params: RepoParams,
      query: { ...compareQuery, ...PageQuery, ...DiffQuery },
      success: Diff,
      error: UnprocessableEntity,
    })
      .annotate(RequiredAccess, "read")
      .annotate(OpenApi.Summary, "A comparison's diff, with hunks")
      .annotate(SuccessDescription, "The diff from the merge base to `head`"),
    HttpApiEndpoint.get("blame", "/blame", {
      params: RepoParams,
      query: { ref: RefQuery, path: Schema.String },
      success: Blame,
      error: UnprocessableEntity,
    })
      .annotate(RequiredAccess, "read")
      .annotate(OpenApi.Summary, "Who last changed each line of a file")
      .annotate(
        OpenApi.Description,
        "422 `too_large` for a file over the blob text limit, `not_a_file` for a directory or a binary file.",
      )
      .annotate(SuccessDescription, "The blame"),
  )
  .prefix("/api/repos/:owner/:repo")
  .middleware(RepositoryAccess)
  .middleware(Authentication)
  .annotate(OpenApi.Title, "Contents") {}
