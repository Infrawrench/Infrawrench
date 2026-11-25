# @infrawrench/git-worker

Notes per area. Settled decisions move up into `git/README.md` and KNOWLEDGE.md.

## Bindings and configuration (`src/env.ts`, `wrangler.jsonc`)

- `Env` is the one type for bindings and secrets: `HYPERDRIVE`, `OBJECTS` (R2), `REPO` and `TERRAFORM_STATE` (Durable Object namespaces), `EVENTS` (queue producer, typed `Queue<GitEvent>`), and the secrets `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `WORKOS_COOKIE_PASSWORD`, `SSH_HOST_KEY`, `GIT_JOB_TOKEN_KEY`, `ENCRYPTION_MASTER_KEY`. Variables: `SITE_ORIGIN`, `APP_ORIGIN`, `WORKOS_API_HOSTNAME`.
- **The Durable Object bindings are commented out in `wrangler.jsonc`.** Wrangler refuses a binding whose class the entry does not export. Whoever exports `RepoDO` and `TerraformStateDO` from `src/index.ts` uncomments `durable_objects` and `migrations`. The names are fixed by `Env`: bindings `REPO` and `TERRAFORM_STATE`, classes `RepoDO` and `TerraformStateDO`, both SQLite classes. The queue consumer is on: `src/index.ts` has the `queue` handler.
- **`ASSETS`** is the built UI (`../web/dist`), with `run_worker_first` so every request reaches the Worker and `not_found_handling: "single-page-application"` so a path with no file is the SPA's shell.
- **`define` and `alias`** are the app's own edge Workers': `__INFRAWRENCH_EDGE_PLUGINS__` swaps the provider plugins for their metadata and every library in server-core's `edge/gateway-only-modules.json` resolves to the stub. The Worker needs them because it calls the app's CI (`server-core/src/ci/`), which reaches the plugin loader. `src/http/__tests__/router.test.ts` fails when the alias map drifts. `wrangler deploy --dry-run` bundles (8.7 MB, 1.7 MB gzipped, November 2026).
- **CI needs the app's `CI_PROXY_URL`, `CI_PROXY_KEY` and `APP_URL`** as this Worker's secrets too (server-core reads them from `process.env`). Without them a push records its run and the dispatch waits for the app's poller, and a run's output and live log are not served here.
- `GitPushEvent` in `env.ts` is the queue's message, as the README describes it, plus `forced` per update. `principalActor(principal)` builds its `actor`.
- **`tsconfig.json` no longer sets `types`.** The scaffold listed `@cloudflare/workers-types/index` there, which is the global flavour, and with it server-core's sources do not typecheck (its `Buffer` loses Node's methods). Like the other Workers, this package gets Node's globals from the base config and imports Cloudflare's types by name from `@cloudflare/workers-types/index`. `src/index.ts` lost its `satisfies ExportedHandler` for the same reason (Node's `Response` is not Cloudflare's); type the handler's parameters from the import instead.
- **`drizzle-orm` is a dependency of this package** (the query modules need its operators). pnpm does not hoist it from server-core.
- `ENCRYPTION_MASTER_KEY` is the app's own master key and is only needed to check `iwk_` API keys (their stored hash is an HMAC under a key derived from it). Server-core reads it from `process.env`, which `nodejs_compat` fills from the Worker's bindings. If sharing that key with this Worker is not wanted, drop `iwk_` support here (`db/organizations.ts` `verifyApiKey`) rather than work around it.
- These are a separate Worker's secrets (`wrangler secret put`), not part of `infra/terraform`'s `app_env`.

## Auth (`src/auth/`)

### Principals

`Principal` (`principal.ts`) is who a request, an SSH session or a job acts as:

| Kind         | Proven by                               | Reach                                                            |
| ------------ | --------------------------------------- | ---------------------------------------------------------------- |
| `anonymous`  | nothing                                 | Public repositories, read.                                       |
| `user`       | `session` cookie, `token`, or `ssh-key` | What the person may do; a token is capped by its scopes.         |
| `api-key`    | `iwk_` key                              | Its organisation's repositories, with the key's own permissions. |
| `deploy-key` | an SSH key in `git_deploy_keys`         | One repository, read or write.                                   |
| `job`        | `iwj_` token                            | One repository, read or write, until it expires.                 |

`toCaller` projects a principal onto the contract's `Caller`. Only a `user` has a `userId` there: an API key's owner is kept for audit (`principalActor`) and never widens what the key may do.

### `repoAccess`

`repoAccess(principal, repo)` (`repo-access.ts`) answers `none | read | triage | write | admin` and is the only place access is decided. `access.ts` holds the rules as a pure function (`decideRepoAccess`) over two facts from Postgres: the person's permissions in the owning organisation and their collaborator role. The rules, in order:

1. In its own right: a person is `admin` on their own namespace's repositories; `git:admin`, `git:write` and `git:read` in the owning organisation give `admin`, `write` and `read`; a collaborator role gives its level; the highest wins. An API key gets what its permissions give, in its own organisation only. A deploy key and a job token get `read` or `write` on their one repository.
2. A personal access token is capped by its scopes: `repo:write` at `write`, `repo:read` at `read`, neither at `none`. A token never reaches `admin`.
3. A public repository is readable by every principal: at least `read`.
4. An archived repository is read-only for every principal: at most `read`.

`repoAccess.detail(principal, repo)` also answers `unarchived`, the level before step 4. The API middleware uses it for endpoints the contract annotates `AllowedWhenArchived` (settings reads, unarchive, delete). Nothing else should read it.

Other things to know:

- **Break-glass grants reach a session and nothing else.** `loadRepoAccessFacts` asks for permissions with `withElevation: true` only when `via` is `session`. A token or an SSH key gets the role alone, as API keys do in the app.
- **A request that presents a credential we refuse is a 401, not anonymous.** `authenticateRequest` answers `refused: true`. For Git over HTTPS, send `WWW-Authenticate: ${BASIC_CHALLENGE}` with it, and also with the 401 an anonymous caller gets for a private repository, so `git` asks for credentials. For the API, a private repository the caller cannot read is a 404.
- **Private repositories and the plan.** `repoAccess` does not look at the organisation's plan (`planAccess`). Creating a private repository is where that is checked.
- `accessFromPermissions` uses the app's own `hasPermission` (`@infrawrench/server-core/permissions/catalog`), so wildcards mean what they mean there.

### Sign-in (WorkOS AuthKit)

The same WorkOS client and the same `users` rows as the app; this host's own redirect URI, cookie and cookie password.

1. `GET /auth/sign-in?returnTo=` (`handleSignIn`): sets a ten-minute nonce cookie and redirects to `user_management/authorize` with `provider=authkit` and a sealed `state` holding the nonce and `returnTo`. `returnTo` must be a path on this site (`safeReturnTo`).
2. `GET /auth/callback` (`handleCallback`): the state must unseal and its nonce must match the cookie; then `POST user_management/authenticate` (`grant_type=authorization_code`, `client_secret` is the API key); then `provision`; then the session cookie; then a redirect to `returnTo`. Failures land on `/?auth_error=denied|state|exchange`.
3. Each request (`authenticateRequest` > `authenticateSession`): unseal the cookie, verify the access token (RS256 against `/sso/jwks/<clientId>`, cached per isolate). When it has expired, exchange the refresh token (`grant_type=refresh_token`), provision again, and return a `Set-Cookie` in `setCookies`. **The caller must put `setCookies` on the response**: WorkOS rotates the refresh token, and the old one is dead.
4. `POST /auth/sign-out` (`handleSignOut`), and `signOut` for the API's `session.signOut`: clears the cookie and redirects to WorkOS's `sessions/logout`, which returns to the site.

Decisions:

- **REST, not the SDK.** `@workos-inc/node` does run on Workers (it ships an `index.worker` build and the web edge Worker loads it). This worker makes the same four calls with `fetch` (`workos.ts`) and verifies JWTs with WebCrypto (`jwt.ts`), so the bundle carries no SDK, no `jose` and no iron-sealed session. The request shapes were read from `@workos-inc/node` 8.13.
- **The cookie is our own format** (`session-cookie.ts`): `v1.<salt>.<iv>.<ciphertext>`, AES-256-GCM under an HKDF-SHA256 key from `WORKOS_COOKIE_PASSWORD` and a per-cookie salt, with the header bound as additional data. It is not interchangeable with the app's `wos-session`, on purpose.
- **Host-only.** No `Domain` attribute, and the name is `__Host-iwg-session` over HTTPS (browsers then refuse it with a `Domain` or without `Secure`). Over plain HTTP in development it is `iwg-session`. `SameSite=Lax`, `HttpOnly`, 400 days like the app's.
- **No `aud` or `iss` check on the access token**, for the reasons KNOWLEDGE.md gives for the app. The key set is per client, which is the isolation.
- **A refused refresh does not clear the cookie** (`stale`). Refresh tokens are single use, so of two requests racing to refresh, the loser is refused; clearing the cookie on its response could delete the session the winner just set. The loser's request is anonymous and the next one carries the new cookie. A cookie that does not unseal (`garbage`) is cleared.
- **WorkOS being down is an error, not a sign-out.** A 5xx or a network failure on refresh throws; only a 4xx ends the session.
- **Writes that ride on the cookie must come from this origin** (`isSameOrigin`): a non-GET request with an `Origin` that is not ours is treated as refused. `SameSite=Lax` already keeps the cookie off cross-site POSTs; this is the second lock.
- **Provisioning is the app's statement** (`db/users.ts` `provisionUser`): insert `id`, `email` and a display name from first and last name, do nothing on conflict. It runs at sign-in and at each refresh, not on every request (the app runs it on every request; a row cannot vanish in between). `provisionSignedInUser` also upserts `git_users`, whose null `onboardedAt` is the "needs a username" state.
- **WorkOS bearer tokens are not accepted** on this site. The API takes the cookie, `iwg_`, `iwk_` and `iwj_`. If a CLI ever signs in with PKCE, `jwt.ts` already verifies its token; `authenticate.ts` needs a branch.

### Tokens

- **Personal access tokens** (`tokens.ts`, `db/tokens.ts`): `iwg_` and 32 random bytes in base64url. Only the SHA-256 is stored. A presented token is hashed, looked up by the hash, and the stored hash compared again in constant time. Unknown, revoked and expired are one answer. `mintAccessToken()` returns the secret to show once.
- **CI job tokens** (`job-token.ts`): `iwj_<claims>.<HMAC-SHA256>` under `GIT_JOB_TOKEN_KEY`, stateless. Claims: repository id, write or not, run id, expiry. Default lifetime one hour, at most six (client-core `git-job-token.ts` owns the format; `job-token.ts` here only maps its claims). They cannot be revoked one at a time; rotating the key revokes all. The MAC is checked before the claims are parsed. `server-core/src/ci/` will mint these when it dispatches a run from a repository here with the same key.
- **Basic auth** (`credentials.ts`): the username is ignored. The password is the credential; when the password is not one of ours the username is tried (`https://<token>@host/`). The prefix decides the kind.
- **API keys** (`db/organizations.ts` `verifyApiKey`): the app's own check, restated: keyed hash, not revoked, not expired, owner still a member, permissions are the scopes intersected with the owner's role. A key on the legacy SHA-256 hash is accepted until its sunset but not rehashed here.

### SSH

- `authenticateSshKey(key, { markUsed })` resolves an offered key to a `user` (via `ssh-key`) or `deploy-key` principal by fingerprint, and checks the stored blob equals the offered one. The SSH server calls its `authenticate` callback before and after the signature check: pass `markUsed: true` only the second time.
- `ssh-keys.ts` parses a pasted `.pub` line and computes `SHA256:` fingerprints. Accepted: `ssh-ed25519`, `ecdsa-sha2-nistp256/384/521`, `ssh-rsa` of 2048 bits or more. The algorithm the line names must be the one inside the blob.
- A key names one principal. `git_user_keys` and `git_deploy_keys` each have a unique fingerprint index; `db/keys.ts` checks the other table in the inserting transaction.

## Data access (`src/db/`)

- **`withDb(env, ctx, fn)`** (`client.ts`) wraps one invocation's work. It is server-core's `withEdgeInvocation`: a postgres.js client over Hyperdrive made with `createDb`, closed after everything handed to `keepAlive` settles. Inside it, the `db` that server-core exports is this invocation's handle, so the modules here import `db` and use it, and nothing holds a connection between requests. Calling a query module outside `withDb` throws (there is no pool to fall back to). A Durable Object needs its own `withDb` per request or alarm.
- **Fire-and-forget writes are `void keepAlive(...)`** (`touchKey`, `touchAccessToken`, `touchApiKey`).
- **Only light server-core modules are imported**: `db/client`, `db/schema`, `runtime/*`, `encryption`, `permissions/catalog`, `permissions/system-roles`. `@infrawrench/server-core/permissions` (the resolver) is deliberately not: it reaches break-glass's notification code and through it `ssh2` and its native addons, which does not bundle for a Worker. `db/org-permissions.ts` restates the resolver's rule (role permissions, legacy role fallback, live grants) as a pure function, and `db/organizations.ts` reads its rows. If the app changes what a role or a grant means, change that file too. The better fix is a server-core resolver module with no notification imports; then this one goes away.
- Modules, one per table group: `users`, `namespaces`, `repositories` (and stars), `collaborators`, `keys`, `tokens`, `organizations`, `threads` (issues, comments, labels, assignees, milestones, timeline events), `pulls` (pull requests, reviews, review comments), `policy` (protected branches, commit statuses), `repository-lists` (the list and search query), `automation` (CI runs as read here, Terraform workspaces, runs, state versions and managed resources). `policy-rules.ts` and `org-permissions.ts` are the parts with no database.
- **Conflicts come from the unique indexes**, never check-then-insert: claim, create and rename functions catch Postgres `23505` (`isUniqueViolation`) and answer null or a reason.
- **Counters move with their rows**: `next_number`, the open counts, `comments_count`, a milestone's counts, `stars_count` and `forks_count` each change in the transaction that changes what they count. `setThreadState` and `markMerged` answer null or false when the row was already in that state, so a race produces one change.
- **Lists are `(timestamp, id)` keyset pages** (`cursor.ts`), fetching `limit + 1`, with the timestamp compared to the millisecond (see "The JSON API"). `listThreads` also sorts by comment count and searches title and body; `repository-lists.ts` `searchRepositories` serves every repository list, with its own cursor per sort.
- `visibleTo(viewer)` is the SQL twin of `repoAccess >= read` for a whole page: public, own namespace, collaborator, or an organisation in `readableOrganizationIds`, which the caller resolves (the organisations where the viewer holds `git:read`).
- **Deleting a repository's row does not delete its objects.** R2 packs and the Durable Object are keyed by the id `deleteRepository` was given; the caller removes them. Deleting an account or an organisation in the app cascades to namespaces and repositories here, leaving objects only a sweep by id can find.

## Routing (`src/index.ts`, `src/http/`)

- `src/index.ts` is the composition root and nothing else: it wires `Routes` and loads the server code on first use (the API's layers and server-core's schema are not start-up work).
- `http/router.ts` `routeOf(pathname)` is the whole split, as a pure function: `/api` is the JSON API, the three `/auth` paths are sign-in, `/<owner>/<repo>.git/...`, `/<owner>/<repo>/raw/...`, `/<owner>/<repo>/archive/...` and `/<owner>/<repo>/terraform/<workspace>/state...` are the storage's, and everything else is the UI. `/<owner>/<repo>/terraform` and `/terraform/<workspace>` are the UI's Infrastructure pages, not the state backend.
- **The storage's routes are optional members of `Routes`** (`smartHttp`, `raw`, `archive`, `terraformState`), each documented where it is declared and listed as a comment in `src/index.ts`. Until one is wired `serve` answers it 503 with `Retry-After`, never the UI's shell, so `git clone` and `terraform init` fail saying why. `connect()` for SSH and the Durable Object exports have their own marked places in `src/index.ts`.
- **`serve` puts the security headers and `X-Request-Id` on every response**, whatever produced it (`http/security-headers.ts`): `nosniff`, `X-Frame-Options: DENY`, a referrer policy, HSTS over HTTPS, and a CSP: the page's policy for HTML (scripts, fonts and requests from this origin only, images also over HTTPS since a README shows the images it links, `form-action` allowing WorkOS for sign-out, `frame-ancestors 'none'`) and `default-src 'none'` for everything that is data. A response that set its own CSP keeps it, which is what the raw route's `sandbox` needs. The request id is Cloudflare's ray id when there is one.
- A route that throws is logged with the path only (a query string can carry the archive route's token) and answered with a bare 500.

## The JSON API (`src/api/`)

The contract's `GitApi` served by Effect `HttpApi`, the way the app's web server serves its domains.

- **`api/server.ts` `makeGitApi(options)`** builds one `fetch`-shaped handler: `HttpApiBuilder.layer(GitApi)` with every group's handlers (`HandlersLive`, which does not typecheck while a group lacks one) and the three middlewares, plus a JSON 404 for an `/api` path nothing routes. HEAD is the GET without its body, and the request is detached from the client's abort signal so a handler that has started a write finishes it. `options` replaces the authenticator, the reader factory and the middlewares, which is how tests run it.
- **Handlers are promise code** (`api/handlers/*.ts`, one file per subject): an `async` function per endpoint that calls the query modules and the `RepoReader`, returns the endpoint's success type and **refuses by throwing one of the contract's error classes**. `op` and `repoOp` (`api/context.ts`) wrap one as an Effect: they build its `Cx` (the caller, the repository in the path, `cx.git`, `cx.reader(other)`, `cx.viewer()`, `cx.background(promise)`) and run the whole handler as **one call inside the invocation's request scope**. That is the app's rule for AsyncLocalStorage and Effect (KNOWLEDGE.md): `db` resolves through an AsyncLocalStorage scope, Effect does not carry it, so Effect code here never touches `db` and everything that does goes through `inScope`.
- **The gates are the middlewares** (`api/middleware.ts`), enforced before a payload is decoded:
  - `Authentication`: a refused credential is a 401 whatever the endpoint; `RequiresUser` means a person (a session or a personal token); the `account` group is session only; `RequiredOrgPermission` is checked with the person's effective permissions (a session) or an API key's own; and **a signed-in person without a username can read and cannot write** (403 `username_required` on every non-GET outside the `session` group).
  - `RepositoryAccess`: missing and unreadable are the same 404; `RequiredAccess` is judged against the un-archived level where the endpoint is `AllowedWhenArchived`; and **an archived repository refuses every write that is not `AllowedWhenArchived`** (403 `repository_archived`), which is what stops the writes that only need `read` (a comment, a new issue). Starring and forking are the exceptions (`ARCHIVE_SAFE`).
  - They leave what handlers read on the fiber as `Context.Reference`s (`AuthRef`, `RepoRef`), so a handler needs no service the server would have to provide.
- **`RequestErrors`** (`api/errors.ts`) renders everything that refuses: the contract's classes as `{ error, code? }` with their status, declared on the endpoint or not; a schema failure as the 400 with its issues; a `RepoReaderError` by the table there (`unavailable` 503, `ref_not_found` and `path_not_found` 404, `not_a_file`, `not_a_directory`, `too_large` and `repository_empty` 422, `ref_exists` and `head_moved` 409, `invalid_ref` 400); anything else as a 500 with a correlation id and nothing of the error. A handler that wants another answer for a reader refusal catches it (`ref_not_found` for a ref named in a payload is a 422).
- **A refreshed session's cookie** is collected on the invocation and appended to the web `Response` by `handle`, one `Set-Cookie` header per line, so it is on refusals too.
- **Views** (`api/views/`) turn rows into the contract's shapes a page at a time: one lookup for the people, one for labels and assignees, one for milestones. `commitDecorator` adds what Postgres knows to a reader's commits (the user an author's email belongs to, the combined status).
- **Lists** go through `visibleTo` (`db/repositories.ts`) or the stricter "has a tie to" of `/user/repos`, with the caller's organisations resolved once per request (`api/viewer.ts`). `db/repository-lists.ts` `searchRepositories` is the one query behind every repository list (filters, the four sorts, search). A personal token with no repository scope sees what a signed-out visitor sees.
- **Cursors compare timestamps to the millisecond** (`db/cursor.ts` `cursorTime`). Postgres keeps microseconds and a cursor made in JavaScript does not, so comparing the raw column skipped rows that shared the last row's millisecond (issues opened together). A list paged with `afterCursor` is ordered by `cursorTime(column)` and then id.
- **Mergeability is one function** (`api/views/pulls.ts` `mergeabilityDetail`), read by `pulls.get`, `pulls.mergeability` and `pulls.merge`. It asks the reader for the trial merge on every view of an open pull request and keeps the answer on the row; while the storage does not answer the state is `unknown` and merging waits (`checking`). Blockers, in order: `merged` or `closed`, else `archived`, `no_permission`, `draft`, `head_missing`, `conflicts`, `checking`, `checks_failed` or `checks_pending` (the rule's required contexts, from `git_commit_statuses` on the head), `approvals_required`, `changes_requested` (only where approvals are required), `push_restricted`. `pulls.merge` refuses with the first; `bypass: true` skips the review and check blockers for an administrator on a rule without `enforceAdmins`, and is a 403 for anyone else.
- **An approval counts until it is dismissed**, whichever head it was given on. `dismissStaleApprovals` on the rule is what makes a push dismiss it (the consumer does that).
- **A merge is recorded after the refs move**: `RepoReader.merge` is the authority, then `markMerged`, the `merged` timeline entry, and the head branch's deletion when asked. A merge that the reader made is never undone because a later step failed.
- **Every change to a thread writes its timeline entry** (`api/thread-edits.ts`): labels, assignees, milestone, title, state, lock, base, draft, review dismissal, a mention from another thread (once per pair).
- **Creating a repository** inserts the row, then calls `RepoReader.init`; a failure deletes the row again (a record without storage is a repository nobody can push to). Forking is the same with `forkFrom`. Deleting removes the row, then destroys the storage from `waitUntil`.
- **Private repositories follow the organisation's plan** (`planAccess`, 402 `plan_required`), on create, on a change of visibility, on transfer and on fork. A person's own namespace has no plan to ask and may hold private repositories.
- **Terraform**: workspaces, runs, state versions and managed resources are served from the tables; the rows' own vocabulary is mapped at the edge of `handlers/automation.ts` (`running` is `planning` or `applying` by kind, `failed` is `errored`, `superseded` is `discarded`, a plan with no changes is `no_changes`). Costs are only sent to a session that holds `costs:read` in the owning organisation, and a workspace's `monthlyCost` and `driftedCount` are null until the app's numbers are read here. `approveRun` and `discardRun` move the row; nothing dispatches a run yet.
- **CI is read from the app's tables** (`db/automation.ts`), never written. A run's job output and live log come from server-core's `ci/runs` (`getRun`, `openRunLogs`), imported on first use.
- Not done: `searchUsers` ignores `repository` (no ranking); a renamed repository's old name does not redirect (the contract says so); the cost visibility rules of the app (a caller restricted to part of the organisation's costs) are not applied to a run's cost change, only `costs:read`.

## Storage (`src/repo/`)

- **`repo/reader.ts` is the storage's spec**: the `RepoReader` interface every handler and the consumer call, its input and answer types in the contract's shapes, the refusal codes, and the rules an implementation keeps. Nothing outside `src/repo/` reads a Git object.
- **`repo/select.ts` `repoReaderFor`** is the one place the implementation is chosen. It answers `unavailableRepoReader`, whose every method refuses `unavailable` (503), until the Durable Object backed one exists.

## Events (`src/events/`)

- `events/consumer.ts` is the `infrawrench-git-events` consumer: one database client per batch, each message acked or retried on its own. For a push it records `pushed_at` (never backwards) and the storage's sizes, synchronises pull requests whose head moved (new head, `committed` or `head_force_pushed` entry, mergeability back to unknown, stale approvals dismissed where the rule says, `refs/pull/<n>/head`) or whose base moved, marks a deleted head branch, closes the issues a commit on the default branch fixes and notes the threads it names, tells CI of every ref and every synchronised pull request (`events/ci.ts`, NOTES-ci.md section 1), and queues Terraform runs (`events/terraform.ts`).
- **Every step is safe to repeat.** Each write is an upsert, a compare against what is stored, or deduplicated by key; `src/__tests__/db/events.test.ts` delivers every push twice. A delivery for a branch that has since moved on is skipped when the storage can say where the branch is.
- **A step that needs the storage does less without it** (no sizes, a `committed` entry naming only the new head, no `Fixes #n`), and never fails the message. Only the database being away retries.
- `events/terraform.ts` only inserts the queued `git_terraform_runs` row: a plan per workspace for a pull request's new head (older heads' unapplied plans become `superseded`), an apply for a move of a workspace's branch. Nothing looks at which files changed yet, so every workspace on the branch gets a run.

## Tests

`pnpm --filter @infrawrench/git-worker test` needs nothing. `DATABASE_URL=postgres://... pnpm --filter @infrawrench/git-worker test:db` runs `src/__tests__/db/` against a migrated scratch Postgres (they skip without it): the API end to end with a header in place of a session and `src/__tests__/helpers/fake-reader.ts` in place of the storage. They cover visibility (a private repository in no list and a 404 every way it is asked for), numbering under concurrency, the filters and paging of the thread lists, merging under protected branches with statuses written by server-core's writer, and the consumer's idempotency. `src/api/__tests__/handlers.test.ts` runs the content handlers through `HttpApiTest`'s in-memory client and the fetch handler with the two gates replaced, without a database.

The unit suites: `src/auth/__tests__/access.test.ts` is the access matrix (public and private, organisation roles, collaborators, token scopes, API keys, deploy keys, job tokens, archived). The rest cover credentials, tokens, job tokens, the cookie, JWT verification, the session refresh, the three sign-in routes, SSH keys, protected-branch rules and the permission rule. None needs a database or the network.
