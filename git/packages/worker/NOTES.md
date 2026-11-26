# @infrawrench/git-worker

Notes per area. Settled decisions move up into `git/README.md` and KNOWLEDGE.md.

## Bindings and configuration (`src/env.ts`, `wrangler.jsonc`)

- `Env` is the one type for bindings and secrets: `HYPERDRIVE`, `OBJECTS` (R2), `REPO` and `TERRAFORM_STATE` (Durable Object namespaces), `EVENTS` (queue producer, typed `Queue<GitEvent>`), and the secrets `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `WORKOS_COOKIE_PASSWORD`, `SSH_HOST_KEY`, `GIT_JOB_TOKEN_KEY`, `ENCRYPTION_MASTER_KEY`. Variables: `SITE_ORIGIN`, `APP_ORIGIN`, `WORKOS_API_HOSTNAME`.
- **The Durable Object bindings are commented out in `wrangler.jsonc`.** Wrangler refuses a binding whose class the entry does not export. Whoever exports `RepoDO` and `TerraformStateDO` from `src/index.ts` uncomments `durable_objects` and `migrations`. The names are fixed by `Env`: bindings `REPO` and `TERRAFORM_STATE`, classes `RepoDO` and `TerraformStateDO`, both SQLite classes. The queue consumer is on: `src/index.ts` has the `queue` handler.
- **`ASSETS`** is the built UI (`../web/dist`), with `run_worker_first` so every request reaches the Worker and `not_found_handling: "single-page-application"` so a path with no file is the SPA's shell.
- **`define` and `alias`** are the app's own edge Workers': `__INFRAWRENCH_EDGE_PLUGINS__` swaps the provider plugins for their metadata and every library in server-core's `edge/gateway-only-modules.json` resolves to the stub. The Worker needs them because it calls the app's CI (`server-core/src/ci/`), which reaches the plugin loader. `src/http/__tests__/router.test.ts` fails when the alias map drifts. `wrangler deploy --dry-run` bundles (8.7 MB, 1.7 MB gzipped, November 2026).
- **CI needs the app's `CI_PROXY_URL`, `CI_PROXY_KEY` and `APP_URL`** as this Worker's secrets too (server-core reads them from `process.env`). Without them a push records its run and the dispatch waits for the app's poller, and a run's output and live log are not served here.

- **`REPO` is bound; `TERRAFORM_STATE` and the queue consumer are not yet.** Wrangler refuses a binding whose class the entry does not export. `RepoDO` is exported from `src/index.ts`, bound in `durable_objects` and created by migration `v1`. Whoever exports `TerraformStateDO` adds its binding and a new migration tag (`v2`, `new_sqlite_classes`); whoever adds the `queue` handler uncomments `consumers`.
- **`webcrypto_modern_algorithms`** is in `compatibility_flags` for the SSH server's post-quantum key exchange (ML-KEM), which current OpenSSH clients warn without.
- `GitPushEvent` in `env.ts` is the queue's message, as the README describes it, plus `forced` per update. `principalActor(principal)` builds its `actor`.
- **`tsconfig.json` lists the `DOM` lib** next to `ES2022`: the SSH package's sources name WebCrypto's types (`CryptoKey`), and they are typechecked from here. It also includes `test/`.
- **`cloudflare:workers` is declared in `src/cloudflare-workers.d.ts`**: the importable flavour of the types has the module's contents (`CloudflareWorkersModule`) but not the module.
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
- **Private repositories follow the owner's plan** (402 `plan_required`), on create, on a change of visibility, on transfer and on fork. The numbers and the wording are server-core's (`git/quota.ts`, `gitPrivateRepositoryRefusal`): how many an organisation's plan includes, and a fixed allowance for a person's own namespace, which has no plan to ask. A push to a private repository whose owner is over its storage quota is refused the same way: `pushPolicy()` reads `gitPushRefusal` and the Durable Object's `refusal()` answers every non-delete update with it (`PushPolicy.quotaRefusal`).
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

## Storage and transports

`RepoDO` (`src/repo/do/`), smart HTTP (`src/transport/http/`) and the SSH host (`src/transport/ssh/`). The protocol itself is `@infrawrench/git-protocol`; its notes say what is and is not implemented on the wire.

### Layout

| File                           | Job                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------- |
| `repo/do/repo-do.ts`           | The Durable Object: RPC methods, the internal `fetch` a git conversation arrives on, alarm. |
| `repo/do/repository.ts`        | Everything it does, written against `platform.ts` so the tests run it in Node.              |
| `repo/do/platform.ts`          | The parts of R2 and Durable Object storage used, as interfaces.                             |
| `repo/do/schema.ts`            | The SQLite tables and their migrations.                                                     |
| `repo/do/pack-store.ts`        | Packs in R2, their indexes in memory, reading an object by byte range.                      |
| `repo/do/ingest.ts`            | Receiving a pack: R2 multipart while the indexer reads it.                                  |
| `repo/do/pack-stream.ts`       | Writing a pack for a fetch out of stored bytes.                                             |
| `repo/do/policy.ts`            | Protected-branch rules applied to a push. Pure.                                             |
| `repo/do/archive.ts`           | A commit as a tar stream.                                                                   |
| `repo/do/client.ts`, `call.ts` | `repoClient(env, repoId)`, and what travels on the internal `fetch`.                        |
| `transport/directory.ts`       | `GitDirectory`: what a transport asks about people and repositories.                        |
| `transport/directory-db.ts`    | The same, answered from Postgres through `src/auth` and `src/db`.                           |
| `transport/http/routes.ts`     | `gitHttp`: smart HTTP, raw file, archive.                                                   |
| `transport/ssh/host.ts`        | `sshConnect`: the `connect()` handler.                                                      |
| `transport/ssh/command.ts`     | Parsing `git-upload-pack '<path>'`. Nothing is ever run.                                    |
| `transport/ssh/rate-limit.ts`  | Failed authentication per address.                                                          |
| `transport/mount.ts`           | `gitFetch` and `gitConnect`, which is all `src/index.ts` imports.                           |

### Where things run

The front Worker authenticates, resolves the repository and its access, and loads the push policy. The Durable Object runs the protocol against its own storage. Between them is one internal `fetch` (`repoClient(...).serve`): a JSON header (`GitCall`: the `ServeRequest`, the actor, the policy), the client's bytes as the request body, the server's as the response body.

- **The Durable Object never opens Postgres.** Protected-branch rules travel with the push (`PushPolicy`) and are applied in the object (`policy.ts`), because only it knows whether an update is a fast-forward.
- **SSH needs both bodies open at once**, and gets it from the same `fetch`: the response starts (the ref advertisement) while the request body is still open, and the negotiation goes back and forth on the pair. Cloudflare's documentation does not promise full-duplex for a `fetch` to a Durable Object stub, nor for a stream passed to and returned from one RPC call. It works in workerd (`test/e2e` fetches with haves over SSH in protocol v0, which cannot work otherwise) and has to be confirmed in production before SSH is opened. If it does not hold there, the stub's `connect()` (a raw socket to the object, public beta) is the documented duplex, and `sshConnect` would hand `channel.stdin`/`stdout` to that instead; nothing else changes. Smart HTTP never needs duplex: each request is read, then answered.
- **Backpressure is the streams' own** in both directions: a slow client slows the pack writer, a slow R2 upload slows the client's push.

### `RepoDO` storage

SQLite holds three small tables: `refs` (name, id, and what a tag peels to), `packs` (the catalogue) and `meta` (`repo_id`, `head`). Packs are `repos/<repoId>/packs/pack-<id>.pack` with `pack-<id>.idx` beside each. The id is time-ordered and random, not the pack's checksum (the README said checksum): the key has to exist before the first byte is uploaded, and R2's binding cannot rename or copy.

**No row per object.** An object is found through each pack's `.idx`, held in memory while the object is awake. The numbers that decided it:

|                       | A row per object in SQLite                               | `.idx` in R2, in memory                     |
| --------------------- | -------------------------------------------------------- | ------------------------------------------- |
| A push of 93 000 objs | 93 000 billed row writes (about $0.09), again per repack | 13 row writes, one extra R2 put             |
| A million objects     | about 70 MB of the object's 10 GB, $1 a write pass       | 28 MB in R2, 28 MB of memory while awake    |
| Lookup                | One indexed read                                         | A binary search per pack, in memory         |
| Waking up             | Nothing to load                                          | One R2 get per pack (2.5 MiB for this repo) |

The price is memory: every live pack's index is loaded (28 bytes an object, plus 12 once a fetch needs entry lengths), so a repository of a few million objects no longer fits. Paging indexes by range (the fan-out table makes a lookup one range read) is the way past that, and is not built.

**An object in several packs is read from the oldest** (`PackStore.locate`). A delta's base was in its own pack or already in the repository when the pack arrived, so with that rule every chain of deltas across packs leads to older packs and cannot loop. It is also why a repack merges a run of adjacent packs and gives the result the first one's place.

**No push lock.** A push writes its pack under its own key and touches nothing shared until `updateRefs`, which publishes the pack and moves the refs in one synchronous SQLite transaction (`transactionSync`). Each ref is compared with what the client saw, so of two pushes racing for a branch one wins and the other gets `stale info`. A pack is `incoming` until then: readable only by the push that brought it, deleted if no ref moves, and swept by the alarm after a day if the push never finished.

**Receiving** (`ingest.ts`): bytes go to an R2 multipart upload in 5 MiB parts (R2's minimum, and every part but the last must be the same size) while `PackIndexer` reads them. A pack smaller than one part is a plain `put`, and stays in memory for the checks that follow. After the upload completes the indexer's second pass reads back what it must by range. Then every object's references are checked against the pack and the repository (`ConnectivityCheck`; the protocol's notes say why every object and not only the new tips), the `.idx` is written, and the pack waits for `updateRefs`. Any failure aborts the upload and removes the files and the row.

**Sending** (`pack-stream.ts`):

- A full clone of a repository that is one self-contained pack is that pack, R2 to the client.
- A full clone of several packs is every entry of every pack, once, in file order, copied as stored. Nothing is inflated and no history is walked.
- Anything else (a fetch with haves, a shallow clone, a single branch) walks history in the protocol and sends the chosen objects' stored entries. Only an `ofs-delta` header is rewritten. A delta whose base is not going out and that the client is not known to have is the one case read whole and compressed again.
- "Everything" includes objects no branch or tag reaches (what a forced push left, pull request heads). See the protocol's notes; `Repository.backend().packEverything` is where to turn it off.

**Repacking** runs from the alarm when there are more than 12 live packs: the newest run of packs under 256 MiB (at most 1 GiB, at most 500 000 objects) is streamed into one new pack through the same ingest path, so the result is indexed and verified like a push. The catalogue switches in one transaction; the old files are deleted after 24 hours, for a clone still streaming them. It merges and does not prune: unreachable objects stay.

**Forks copy** (`importFork`): the parent's live packs and indexes are copied R2 to R2 under the fork's prefix, with its branches and tags (not `refs/pull/*`). Sharing the parent's packs instead would make every repack and delete of the parent depend on its forks (reference counts across Durable Objects, with no transaction to keep them right), and bill a parent's storage to whoever was forked from. The copy runs through the object (the binding has no server-side copy), which is a pass of R2 traffic and no egress.

**Deleting** (`destroy`): every key under `repos/<repoId>/`, then `deleteAll`. The object is empty and can be reused.

**Size** (`stats().sizeBytes`): bytes of live packs and indexes plus what is waiting to be deleted or still arriving. That is what R2 holds and what `git_repositories.size_bytes` should be set from.

### RPC surface

Call through `repoClient(env, repoId)` (`repo/do/client.ts`), which binds the id; the object refuses a different one than it was first given.

| Method                                                   | What it does                                                                                         |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `init({ defaultBranch, readme })`                        | Sets HEAD; with `readme`, makes the first commit. Safe to call again.                                |
| `listRefs()`                                             | `{ refs, head }`; tags carry `peeled`.                                                               |
| `head()` / `setHead(ref)`                                | HEAD's branch (and its commit, when it exists) / point HEAD at another branch.                       |
| `updateRefs(updates, { atomic, actor, notify, policy })` | Compare-and-swap ref changes by the forge. Sends the push event unless `notify: false`.              |
| `readObject(oid)` / `readObjects(oids)`                  | One object, or a batch (at most 256 objects or 16 MiB a call; the rest come back `undefined`).       |
| `hasObjects(oids)` / `resolvePrefix(prefix)`             | Existence; full ids for an abbreviated one.                                                          |
| `readPath(commit, path)`                                 | The blob or tree at a path, in one round trip.                                                       |
| `writeObjects(objects)`                                  | Stores objects made on the server as a small pack; returns their ids. Unreachable until a ref moves. |
| `stats()`                                                | Counts and bytes, as above.                                                                          |
| `maintain({ force })`                                    | What the alarm does; `force` repacks regardless of the threshold.                                    |
| `forkFrom(sourceRepoId)` / `forkManifest()`              | Become a copy of another repository / what a fork copies.                                            |
| `destroy()`                                              | Delete everything.                                                                                   |
| `serve(call, input, signal)`                             | A git conversation (the internal `fetch`).                                                           |
| `archive(commit, prefix)`                                | The commit as a gzipped tar under one directory.                                                     |

`RepoReader` (the API's content interface) can be implemented over `readObjects`, `readPath`, `listRefs` and `resolvePrefix`. A walk that reads many objects one RPC at a time will be slow; batch with `readObjects`, or add a method here that does the walk next to the data, as `readPath` does.

### Events

After refs move, the object sends `{ type: "push", repoId, actor, updates: [{ name, oldOid, newOid, forced }], at }` to `EVENTS`: from a push through the protocol's `ReceiveHooks.after`, and from `updateRefs` (merges, web edits) unless told not to. `forced` is an update whose new commit does not descend from the old one, decided by an ancestry walk. A failed send does not fail the push: the refs have already moved. Nothing retries it; the consumer should be able to resynchronise from `listRefs`.

### Smart HTTP

`gitHttp(request, env, directory)` answers null for a request that is not one of its routes, so the router tries it first.

- **Who gets what** is at the top of `routes.ts`: 401 with the Basic challenge for anyone without credentials who may not proceed (a missing repository included, so names are not probed), 404 for someone signed in who cannot read, 403 with a `text/plain` reason for someone who can read but not push (`git` prints it after `remote:`), and 403 for an archived repository's push.
- `Git-Protocol` selects v1 or v2 for fetch; a push that asked for v2 is answered in v0.
- `Content-Encoding: gzip` request bodies are inflated. Responses carry the three no-cache headers.
- **CI's routes**: `GET /<owner>/<repo>/raw/<sha>/<path>` (any credential that can read; `Bearer` for a job token) and `GET /<owner>/<repo>/archive/<sha>.tar.gz` (a credential, or `?token=` with the commit-bound job token, which is refused everywhere else). Both answer `Cache-Control: private, no-store`. `<sha>` is a full id. The raw route is served as `application/octet-stream` with `nosniff` and a sandboxing CSP: it is somebody's file on our origin.
- A personal access token never administers (`repoAccess` caps it at `write`), so a token is bound by protected-branch rules even when it is the owner's. An SSH key is the person.
- The 100 MB request body limit of the zone's plan applies to a push over HTTPS. Over SSH there is none.

### SSH

- The username must be `git`. A key is looked up by fingerprint (`authenticateSshKey`); `markUsed` only once the signature has verified.
- Commands: `git-upload-pack` and `git-receive-pack` (also spelled `git upload-pack`), with the path quoted as git quotes it, with or without a leading slash and `.git`. `~` paths, anything with more or fewer than two segments, and every other command are refused with a line on stderr and exit status 1. The command string is parsed, never executed.
- `GIT_PROTOCOL` from the client's `env` selects the version.
- `ssh git@host` without a command gets "Hi <username>! You've authenticated, but git.infrawrench.com does not provide shell access."
- The idle timeout is raised to 30 minutes, because the protocol sends no keepalive while a push is indexed.
- **Failed authentication is limited per address** in the Cache API: 20 connections that end unauthenticated within 10 minutes and the address is refused until the window passes. Per data centre and best effort, on purpose (`rate-limit.ts` says why it is not a Durable Object).
- `SSH_HOST_KEY` is loaded once per isolate.

### Limits

| Limit                       | Value                                                 | Where                  |
| --------------------------- | ----------------------------------------------------- | ---------------------- |
| Pack in one push            | 4 GiB (HTTPS: the plan's 100 MB body)                 | `RepositoryLimits`     |
| Objects in one pack         | 500 000                                               | `RepositoryLimits`     |
| Object held whole           | 64 MiB to read; 32 MiB as a delta or base when pushed | `pack-store.ts`, core  |
| Objects in a repository     | a few million (indexes in memory)                     | above                  |
| `readObjects` batch         | 256 objects or 16 MiB                                 | `repo-do.ts`           |
| Wants, haves, ref updates   | 10 000, 50 000, 10 000 a request                      | protocol `ServeLimits` |
| Packs before a repack       | 12                                                    | `RepositoryLimits`     |
| Deleted files' grace period | 24 hours                                              | `RepositoryLimits`     |

### Memory

A Durable Object has 128 MB. workerd does not report an isolate's heap and does not enforce the limit locally, so the storage code is measured on Node (`test/memory.test.ts`: live heap plus array buffers after a forced collection every 100 ms, less what the stand-in bucket holds). This repository's history, 93 303 objects in a 75 MiB pack:

| Operation                                              | Time   | Peak above baseline |
| ------------------------------------------------------ | ------ | ------------------- |
| Push (ingest, verify, publish)                         | 8.3 s  | 85 to 88 MiB        |
| Clone, the stored pack                                 | 0.03 s | under 1 MiB         |
| Fetch of the last 50 commits (1 142 objects, 11.6 MiB) | 0.2 s  | 34 MiB              |
| Clone assembled from two packs                         | 0.3 s  | under 1 MiB         |
| Repack of two packs into one                           | 8.5 s  | 92 MiB              |

The push made 13 SQL writes, uploaded 15 parts and read 875 ranges back. The push's steady state is about 55 MiB (the indexer's 16 MiB cache, its table, held deltas, the hash queue, two part buffers); the peak is the indexer's second pass rebuilding objects of several megabytes, base and result together. **That peak is too close to 128 MB to be comfortable**: the table grows by 55 bytes an object, and a pack whose deltas are of objects near core's 32 MiB limit would hold twice that at once. The object limit is set at 500 000 for that reason, and a real measurement under the production limit is still owed.

### Throughput in workerd

`test/e2e/monorepo.test.ts`: `wrangler dev`, local R2 and Durable Objects, loopback, Apple M4, a busy machine. The same history.

| Operation                                    | HTTPS                          | SSH                           |
| -------------------------------------------- | ------------------------------ | ----------------------------- |
| Push of the whole history (75 MiB)           | 18 to 33 s (2.4 to 4.4 MiB/s)  | 23 to 25 s (3.1 to 3.4 MiB/s) |
| `git clone`, start to finish                 | 6.6 to 7.3 s                   | 6.6 to 8.2 s                  |
| The clone's pack, server only (over HTTP)    | 0.7 to 0.9 s (90 to 108 MiB/s) | not measured                  |
| Fetch of the last 50 commits (1 142 objects) | 1.6 to 1.9 s                   | 2.1 to 2.2 s                  |
| `git clone --depth 1`                        | 2.1 to 3.2 s                   | 2.8 to 5.2 s                  |

Two or three runs each, with the machine's load average around 6, which is where the ranges come from. The push is two to three times slower than the same code on Node (8 to 9 s). The likeliest cause is the indexer's second pass, about 900 range reads, each a round trip to the local R2 simulator; it was not profiled.

A clone's wall time is mostly the client's own `index-pack`; "server only" is the same pack downloaded and thrown away. workerd's resident memory grew by over a gigabyte during a push and came back: locally nothing limits an isolate, so garbage is collected late, and the figure says nothing about the 128 MB limit.

### Tests

- `src/repo/do/__tests__/policy.test.ts`, `src/transport/__tests__/transport.test.ts`: protected-branch rules, SSH command parsing, the failure limiter, route matching, and who gets a 401, a 404 or a 403. No database, no workerd.
- `test/repository.test.ts`: the storage code with the real `git` on the other end, on Node stand-ins for R2 (which enforce R2's multipart rules) and SQLite (`node:sqlite`): a push as one request and as a multipart upload, clones and fetches out of several thin packs, a client without `ofs-delta`, repacking and the grace period, refused pushes leaving nothing behind, server-side objects and ref changes, forks, deletion, the tar archive, init with a README.
- `test/e2e/git.test.ts` (opt-in, `GIT_WORKER_E2E=1`): the worker under `wrangler dev` with a fixture in place of Postgres (`test/e2e/entry.ts`; access is still decided by `decideRepoAccess`). The real `git` over HTTPS in v0, v1 and v2 and over SSH (the real `ssh`, to the `connect` listener) in v0 and v2: clone, shallow clone, fetch with haves, push, protected branches, the events queue, job tokens on smart HTTP and on the raw and archive routes, deploy keys, the greeting, the failure limit, and init, repack, fork and destroy through RPC.
- `test/e2e/monorepo.test.ts` and `test/memory.test.ts` (opt-in, `GIT_WORKER_BENCH=1`): the measurements above.

The workerd suites are opt-in because they start `wrangler dev`; nothing in them needs an account or the network. `directory-db.ts` (the Postgres half of the transports) is covered by neither: it is a few calls into `src/auth` and `src/db`, which have their own tests, and it needs a database to run.

### Left to do

- **Confirm full-duplex `fetch` to a Durable Object in production** before SSH opens (above).
- **Measure under the real 128 MB limit**, and decide the object and delta-size limits from it.
- **Prune**: repack merges but never drops unreachable objects, so a full clone can carry them.
- **Index paging** for repositories past a few million objects.
- **Keepalives** during long indexing, instead of a long SSH idle timeout.
- **`TERRAFORM_STATE`** is not bound in `wrangler.jsonc`: its class is not exported yet, and wrangler refuses a binding without one. It joins `durable_objects` and a new migration tag with its class.
- **Deleting a repository's row does not call `destroy()`**, and neither does anything sweep objects whose row is gone. The API's delete handler should call it.
- **`git_repositories.size_bytes`, `pushed_at` and the counts** are the queue consumer's to set, from the event and `stats()`.
- **SSH rate limiting is per data centre.** A connection cap per principal is not there.
- `refs/pull/<n>/head` is written by whoever owns pull requests, through `updateRefs`; pushes may not touch `refs/pull/*`.

## Tests (auth and data access)

`pnpm --filter @infrawrench/git-worker test` needs nothing. `DATABASE_URL=postgres://... pnpm --filter @infrawrench/git-worker test:db` runs `src/__tests__/db/` against a migrated scratch Postgres (they skip without it): the API end to end with a header in place of a session and `src/__tests__/helpers/fake-reader.ts` in place of the storage. They cover visibility (a private repository in no list and a 404 every way it is asked for), numbering under concurrency, the filters and paging of the thread lists, merging under protected branches with statuses written by server-core's writer, and the consumer's idempotency. `src/api/__tests__/handlers.test.ts` runs the content handlers through `HttpApiTest`'s in-memory client and the fetch handler with the two gates replaced, without a database.

The unit suites: `src/auth/__tests__/access.test.ts` is the access matrix (public and private, organisation roles, collaborators, token scopes, API keys, deploy keys, job tokens, archived). The rest cover credentials, tokens, job tokens, the cookie, JWT verification, the session refresh, the three sign-in routes, SSH keys, protected-branch rules and the permission rule. None needs a database or the network.
