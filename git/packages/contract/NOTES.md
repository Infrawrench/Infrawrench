# @infrawrench/git-contract

The JSON API of git.infrawrench.com as Effect `HttpApi` definitions. The worker serves them; the UI derives its client from them (`HttpApiClient.make(GitApi)` or one of the per-group APIs). It imports only `effect`, and `@infrawrench/client-core` for the name rules (`src/names.ts` re-exports them: the app claims an organisation's namespace by the same list).

## Layout

- `src/http/`: `errors.ts` (one `Schema.Error` class per status, `{ error, code? }` on the wire), `annotations.ts` (the gates), `auth.ts` (the middleware tags and the services they provide, `withApiDefaults`).
- `src/schemas/`: every request and response shape, by subject. `git.ts` is the content the UI draws directly.
- `src/groups/`: the endpoints. `src/api.ts` assembles `GitApi` (everything) and the per-group APIs.
- `src/names.ts`, `src/urls.ts`: pure functions both sides use (name rules and the reserved list; clone, raw, archive and sign-in paths).

## Conventions

- **Paths.** Everything is under `/api`. Repository endpoints are under `/api/repos/:owner/:repo`. Refs and tree paths are query parameters (`?ref=&path=`), never path segments, because both contain slashes. A commit in a path is a full or abbreviated id (`:sha`).
- **Pagination is a cursor.** `?cursor=&limit=` in, `{ items, nextCursor }` out (`Page(item)`, `PageQuery`). `nextCursor` is opaque and null on the last page. `limit` is 1 to 100, default 30. Issue and pull request lists add `counts: { open, closed }` for their tabs. Lists that are short by nature (labels, milestones, reviews, review threads, keys, tokens, workspaces) answer a named array without a cursor.
- **Errors.** `{ error: string, code?: string }`. `error` is a sentence for a person; `code` is one of `ERROR_CODES` when the UI should branch on it. A private repository the caller cannot read is a 404, never a 403. The 401 and 403 of `Authentication` and the 404 of `RepositoryAccess` are declared on the middleware, so an endpoint's `error` lists only what it adds (400, 409, 422, 402).
- **Gates are annotations**, enforced by the worker's middleware before the payload is decoded:
  - `RequiredAccess` (`read` | `triage` | `write` | `admin`): the least `repoAccess` on the repository in the path. Every repository endpoint has one.
  - `RequiresUser`: a signed-in person. Every write that only needs `read` also has it, so an anonymous reader of a public repository cannot comment.
  - `RequiredOrgPermission` (`git:admin`): on the organisation named by `:orgId`.
  - `AllowedWhenArchived`: see "Archived repositories" below.
  - `HandlerGate`: documents a rule only the handler can check (the comment's author, the pull request's author, `write` on the head repository). It never stands alone: `RequiresUser` is beside it.
  - `src/__tests__/api.test.ts` holds all of the above across every endpoint, plus unique method and path pairs. An endpoint that is open to anyone with no gate must be added to that test's `OPEN` set on purpose.
- **Middleware order.** Repository groups are `.middleware(RepositoryAccess).middleware(Authentication)`: the later one is the outer one, so `Authentication` runs first and provides `Caller`, which `RepositoryAccess` requires.
- **Archived repositories.** `repoAccess` is at most `read` on one, for everybody. An endpoint annotated `AllowedWhenArchived` is judged against the level the caller would have without that cap: `repositories.update` (which unarchives), `repositories.delete` and every `admin` read (the settings pages). `RepositoryViewer.canAdminister` is the same un-capped answer for the UI.
- **Names that shadow globals are avoided**: `FileBlob`, `GitTag`, `TreeListing`, `ThreadComment` rather than `Blob`, `Tag`, `Tree`, `Comment`.
- **Every exported schema has a type of the same name** (`export type Branch = typeof Branch.Type`), so the worker and the UI name a shape without `typeof X.Type`.
- **Numbers are `Schema.Finite`** (tsc-rs's `schemaNumber` diagnostic), integers `Schema.Int`.

## Decisions

- **Issues and pull requests share a thread.** One number sequence, and the comments, timeline, labels, assignees, milestone and lock of a pull request are served by the `issues` group with its number. `issues.get` answers 404 for a pull request's number and the reverse; the UI tries the other.
- **Diffs are paged by file** (`Diff.nextCursor`), with whole-diff `stats` on every page. A file over the size budget comes back with `tooLarge: true` and no hunks; `?path=` asks for that one file whatever its size. `commit` and `compare` answer the file list without hunks; `commitDiff`, `compareDiff` and `pulls.files` answer hunks.
- **Diff lines carry both line numbers** and no prefix character. `noNewlineAtEnd` is only present (as `true`) on the line it applies to.
- **Tree listings carry `lastCommit` per entry when the walk fits its budget.** `lastCommitsComplete: false` means some are null; `treeLastCommits` fills them in. The UI should render the listing first and call it only then.
- **Review comments are served as threads** (`pulls.listThreads`), anchored by `path`, `side` and `line` in the current diff, with `outdated` and the original position kept. A pending review's comments are only sent to their author (`ReviewComment.pending`).
- **Mergeability is one block** (`Mergeability`), on `pulls.get` and alone on `pulls.mergeability` for polling while `state` is `checking`. `blockers` is the whole list of reasons, each with a code; `pulls.merge` refuses with the first as its `code`.
- **Raw files and archives are not endpoints**: they stream bytes, so they are plain URLs (`rawPath`, `archivePath`). A ref in those paths is resolved greedily; the UI links by commit id where it has one.
- **Sign-in is not an endpoint** either (`AUTH_PATHS`). `session.me` never answers 401; it answers `user: null`.
- **CI is read-only here.** Retrying, cancelling and approving a run happen in the app (`CiRun.appUrl`), where `ci:approve` lives. The CI status lists repeat client-core's `ci.ts`; a status added there is added to `schemas/ci.ts`.
- **Terraform shapes follow the tables.** State documents are never served by this API (they hold secrets), only their metadata (`sha256`, not an MD5). Costs are null for callers who may not see costs in the app, and a run's cost change carries the monthly delta alone (`monthlyBefore` and `monthlyAfter` are null) until the totals are stored. A workspace's name is a URL segment and part of an R2 key: lowercase letters, digits, `-` and `_`. `forget` is an action beside `delete`: removed from state, not destroyed.
- **Token scopes are `repo:read` and `repo:write` only.** A token never reaches settings or credentials: `AccountGroup` is session only.

## Not here yet

- Webhooks, notifications, releases, repository redirects after a rename, editing files in the browser, requested reviewers, reactions.
- An OpenAPI document is not published; `OpenApi.fromApi(GitApi)` builds one (the test checks that it does).
