# @infrawrench/git-worker

Notes per area. Settled decisions move up into `git/README.md` and KNOWLEDGE.md.

## Bindings and configuration (`src/env.ts`, `wrangler.jsonc`)

- **A cron trigger** (`triggers.crons`, hourly) runs `scheduled` in `src/index.ts`: pruning versions (`review/prune.ts`).
- `Env` is the one type for bindings and secrets: `HYPERDRIVE`, `OBJECTS` (R2), `REPO` and `TERRAFORM_STATE` (Durable Object namespaces), `EVENTS` (queue producer, typed `Queue<GitEvent>`), and the secrets `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `WORKOS_COOKIE_PASSWORD`, `SSH_HOST_KEY`, `GIT_JOB_TOKEN_KEY`, `ENCRYPTION_MASTER_KEY`. Variables: `SITE_ORIGIN`, `APP_ORIGIN`, `WORKOS_API_HOSTNAME`.
- **Both Durable Objects are bound**: `REPO` (`RepoDO`, migration `v1`) and `TERRAFORM_STATE` (`TerraformStateDO`, migration `v2`), both SQLite classes exported from `src/index.ts`. A class is created by the migration tag that first names it: a deployed tag is never edited, a new class gets a new tag. The queue consumer is on: `src/index.ts` has the `queue` handler.
- **`ASSETS`** is the built UI (`../web/dist`), with `run_worker_first` so every request reaches the Worker and `not_found_handling: "single-page-application"` so a path with no file is the SPA's shell.

- **There is a `define` and no `alias` map.** `__INFRAWRENCH_EDGE_PLUGINS__` says the bundle has no plugin code. The Worker calls the app's CI (`server-core/src/ci/`), whose dispatcher could reach the plugin loader and the socket drivers through the code that lends connections; with the constant defined that code is dropped at build time (`ci/runs.ts` `lendingCode`) and a run that lends something is left to the app's gateway. So nothing that cannot run in a Worker is reached, and there is no copy of the app's alias map here to drift from `server-core/edge/gateway-only-modules.json`. `src/__tests__/import-graph.test.ts` bundles the Worker and fails when that stops being true. `wrangler deploy --dry-run` bundles 3.4 MB, 0.7 MB gzipped (November 2026; 9.0 MB and 1.8 MB with the loader). `README.md` has the bindings, variables and secrets.
- **`SSH_HOST`** is the host of SSH clone URLs (`sshHost(env)`, used by `api/views/repositories.ts`) and the name the Spectrum application is created under (`infra/git/setup.mjs` reads it from `wrangler.jsonc`). With a port (`localhost:8788`, local development) the contract's `sshCloneUrl` writes an `ssh://` URL.
- **CI needs the app's `CI_PROXY_URL`, `CI_PROXY_KEY` and `APP_URL`** as this Worker's secrets too (server-core reads them from `process.env`). Without them a push records its run and the dispatch waits for the app's poller, and a run's output and live log are not served here.

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
- **Writes that ride on the cookie must come from this origin** (`isSameOrigin`, `writeOrigin`): a write must carry our `Origin` or `Sec-Fetch-Site: same-origin`. One that carries neither is refused when it rides on the cookie (git, Terraform and CI send neither and bring a token). One that says it came from elsewhere, a sibling `*.infrawrench.com` host included (`same-site`), is a 401 whatever credential it carries. `SameSite=Lax` does not cover the sibling host; this does.
- **Provisioning is the app's statement** (`db/users.ts` `provisionUser`): insert `id`, `email` and a display name from first and last name, do nothing on conflict. It runs at sign-in and at each refresh, not on every request (the app runs it on every request; a row cannot vanish in between). `provisionSignedInUser` also upserts `git_users`, whose null `onboardedAt` is the "needs a username" state.
- **WorkOS bearer tokens are not accepted** on this site. The API takes the cookie, `iwg_` and `iwk_`, and `iwj_` on the commit status endpoints only. If a CLI ever signs in with PKCE, `jwt.ts` already verifies its token; `authenticate.ts` needs a branch.

### Tokens

- **Personal access tokens** (`tokens.ts`, `db/tokens.ts`): `iwg_` and 32 random bytes in base64url. Only the SHA-256 is stored. A presented token is hashed, looked up by the hash, and the stored hash compared again in constant time. Unknown, revoked and expired are one answer. `mintAccessToken()` returns the secret to show once.
- **CI job tokens** (`job-token.ts`): `iwj_<claims>.<HMAC-SHA256>` under `GIT_JOB_TOKEN_KEY`, stateless. Claims: repository id, write or not, run id, expiry, and optionally a commit or a Terraform workspace. Default lifetime one hour, at most six (client-core `git-job-token.ts` owns the format; `job-token.ts` here only maps its claims). They cannot be revoked one at a time; rotating the key revokes all. The MAC is checked before the claims are parsed. `server-core/src/ci/` mints these when it dispatches a run from a repository here, with the same key. A token with a commit is good for that commit's archive alone, and one with a workspace for that workspace's state and plans alone: `authenticateRequest` refuses the second everywhere unless the caller says it serves workspaces (`workspaceTokens`, which only `terraform/directory-db.ts` does), so it is a 401 on smart HTTP, the raw and archive routes and the API, and `repoAccess` gives such a principal nothing of the repository even if one were made.
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
- `http/router.ts` `routeOf(pathname)` is the whole split, as a pure function: `/api` is the JSON API, the three `/auth` paths are sign-in, `/<owner>/<repo>.git/...`, `/<owner>/<repo>/raw/...`, `/<owner>/<repo>/archive/...` are the storage's, `/<owner>/<repo>/terraform/<workspace>/state...` and `/<owner>/<repo>/terraform/<workspace>/runs/<id>/plan` are Terraform's, and everything else is the UI. `/<owner>/<repo>/terraform` and `/terraform/<workspace>` are the UI's Infrastructure pages, not the state backend.
- **The storage's and Terraform's routes are optional members of `Routes`** (`smartHttp`, `raw`, `archive`, `terraformState`, `terraformPlan`), each documented where it is declared. All are wired in `src/index.ts`; a build without one answers it 503 with `Retry-After`, never the UI's shell, so `git clone` and `terraform init` fail saying why. `connect()` for SSH and the Durable Object exports have their own marked places in `src/index.ts`.
- **`serve` puts the security headers and `X-Request-Id` on every response**, whatever produced it (`http/security-headers.ts`): `nosniff`, `X-Frame-Options: DENY`, a referrer policy, HSTS over HTTPS, and a CSP: the page's policy for HTML (scripts, fonts, images and requests from this origin only, an image from another site coming through `/-/image` (`images/proxy.ts`), `form-action` allowing WorkOS for sign-out, `frame-ancestors 'none'`) and `default-src 'none'` for everything that is data. A response that set its own CSP keeps it, which is what the raw route's `sandbox` needs. The request id is Cloudflare's ray id when there is one.
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
- **Creating a repository** inserts the row, then calls `RepoReader.init`; a failure deletes the row again (a record without storage is a repository nobody can push to). Forking is the same with `forkFrom`; a fork within the same owner also gets the parent's collaborators (`copyCollaborators`), as on GitHub. Deleting removes the row, then destroys the storage from `waitUntil`.
- **Private repositories follow the owner's plan** (402 `plan_required`), on create, on a change of visibility, on transfer and on fork. The numbers and the wording are server-core's (`git/quota.ts`, `gitPrivateRepositoryRefusal`): how many an organisation's plan includes, and a fixed allowance for a person's own namespace, which has no plan to ask. A push to a private repository whose owner is over its storage quota is refused the same way: `pushPolicy()` reads `gitPushRefusal` and the Durable Object's `refusal()` answers every non-delete update with it (`PushPolicy.quotaRefusal`).
- **Terraform**: workspaces, runs, state versions and managed resources are served from the tables; the rows' own vocabulary is mapped at the edge of `handlers/automation.ts` (`running` is `planning` or `applying` by kind, `failed` is `errored`, `superseded` is `discarded`, a plan with no changes is `no_changes`). Costs are only sent to a session that holds `costs:read` in the owning organisation, and a workspace's `monthlyCost` and `driftedCount` are null until the app's numbers are read here. `approveRun` and `discardRun` move the row; nothing dispatches a run yet.

- **Private repositories follow the organisation's plan** (`planAccess`, 402 `plan_required`), on create, on a change of visibility, on transfer and on fork. A person's own namespace has no plan to ask and gets a fixed allowance (client-core `GIT_FORGE_LIMITS`: 5 private repositories, 1 GiB).
- **Terraform**: workspaces, runs, state versions and managed resources are served from the tables; the rows' own vocabulary is mapped at the edge of `handlers/automation.ts` (`running` is `planning` or `applying` by kind, `failed` is `errored`, `superseded` is `discarded`, a plan with no changes is `no_changes`). See "Terraform" below for what the handlers do beyond reading.
- **CI is read from the app's tables** (`db/automation.ts`), never written. A run's job output and live log come from server-core's `ci/runs` (`getRun`, `openRunLogs`), imported on first use.
- Not done: `searchUsers` ignores `repository` (no ranking); a renamed repository's old name does not redirect (the contract says so); the cost visibility rules of the app (a caller restricted to part of the organisation's costs) are applied to what a workspace's resources cost (`managedResourceCosts`), but not to a run's cost change, which is an estimate from list prices and only takes `costs:read`.

## Storage (`src/repo/`)

- **`repo/reader.ts` is the storage's spec**: the `RepoReader` interface every handler and the consumer call, its input and answer types in the contract's shapes, the refusal codes, and the rules an implementation keeps. Nothing outside `src/repo/` reads a Git object.
- **`repo/select.ts` `repoReaderFor`** is the one place the implementation is chosen: `durableRepoReader` (`repo/reader-do.ts`), which runs every method inside the repository's Durable Object. "The reader", below, has the design and the measurements. `unavailableRepoReader` (every method refuses `unavailable`, a 503) is still there for a test that wants no storage.

## Events (`src/events/`)

- `events/consumer.ts` is the `infrawrench-git-events` consumer: one database client per batch, each message acked or retried on its own. For a push it records `pushed_at` (never backwards) and the storage's sizes, synchronises pull requests whose head moved (new head, `committed` or `head_force_pushed` entry, mergeability back to unknown, stale approvals dismissed where the rule says, `refs/pull/<n>/head`) or whose base moved, marks a deleted head branch, closes the issues a commit on the default branch fixes and notes the threads it names, tells CI of every ref and every synchronised pull request (`events/ci.ts`, NOTES-ci.md section 1), and queues Terraform runs (`events/terraform.ts`).
- **Every step is safe to repeat.** Each write is an upsert, a compare against what is stored, or deduplicated by key; `src/__tests__/db/events.test.ts` delivers every push twice. A delivery for a branch that has since moved on is skipped when the storage can say where the branch is.
- **A step that needs the storage does less without it** (no sizes, a `committed` entry naming only the new head, no `Fixes #n`), and never fails the message. Only the database being away retries.
- `events/terraform.ts` records the `git_terraform_runs` row and starts it through server-core (`ci/terraform.ts`): a plan per workspace a pull request's new head touches (older heads' unapplied plans become `superseded`), an apply for a move of a workspace's branch. See "Terraform" below.

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
| `repo/reader-do.ts`            | The Worker's `RepoReader`: each method one call to the object.                              |
| `repo/queries/`                | The reader itself, over `Repository` and git-ops. Runs in the object, and in Node's tests.  |
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
- **The Worker runs beside Postgres, the repositories beside R2.** `placement` pins the Worker to `aws:us-east-2` (Neon), as the app's Workers are; from London every query was its own transatlantic round trip, 650 ms to 1.5 s for a page's list. The UI's hashed files and favicons skip the Worker (`run_worker_first` patterns) and carry the Worker's headers from `web/public/_headers`, which `static-headers.test.ts` holds equal. A repository's Durable Object is created with `locationHint: "enam"` (`REPO_LOCATION`), beside the bucket: an object created near its first visitor waited ~100 ms on every R2 read. A hint only counts when an object is created, so repositories made before it stay where they were. Whether `placement` applies to the `connect` handler (SSH through Spectrum) is to be seen when SSH opens.
- **A page shows before its history is walked.** The UI asks `tree` with `lastCommits=false` and `blob` with `lastCommit=false`, then `latestCommit` (a path's newest commit, and the count at the root) and `treeLastCommits` once the page is up, and prefetches a folder or file when the pointer rests on its link (`web/src/features/code/requests.ts`).
- **Smart HTTP carries both bodies through the Worker's own code** (`carried` in `transport/http/routes.ts`). Returning the object's response untouched ends the Worker's request at once, and the upload still flowing into the object then has Cloudflare's 30 seconds after a request ends before it is cancelled: a 32 MiB push the object took 63 seconds to read failed in production with "client disconnected". A body the Worker pipes itself keeps the request open until the answer is complete. `wrangler dev` does not apply the 30 seconds.
- **A push over HTTPS is stored before it is indexed** (`IngestOptions.whole`, `ingest.ts`). Indexing (inflating, hashing with the collision-detecting SHA-1, resolving deltas) runs well below the network's pace, and a client held back by it for about a minute has its connection reset by Cloudflare's edge: an 88 MiB push failed that way (git's `HTTP/2 stream was not closed cleanly: INTERNAL_ERROR`). So the request's bytes go to R2 as fast as they come (three 5 MiB parts in flight), and the indexer then reads the stored pack back. Over SSH the stream stays open after the pack and only parsing finds its end, so SSH still indexes as it receives. Once the pack is in, receive-pack sends git's keepalive (an empty data-band packet, `receive.keepAlive`) every five seconds until it answers (`ServeLimits.keepAliveMs`).
- **Backpressure is the streams' own** in both directions: a slow client slows the pack writer, a slow R2 upload slows the client's push.

### `RepoDO` storage

SQLite holds four small tables: `refs` (name, id, and what a tag peels to), `packs` (the catalogue), `meta` (`repo_id`, `head`, `ready`) and `reader_cache` (answers the reader walked history for; "The reader"). Packs are `repos/<repoId>/packs/pack-<id>.pack` with `pack-<id>.idx` beside each. The id is time-ordered and random, not the pack's checksum (the README said checksum): the key has to exist before the first byte is uploaded, and R2's binding cannot rename or copy.

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
- **The stored packs go out only while every stored object is known to be reachable from a branch or a tag** (`meta.unreachable`, `Repository.everythingReachable`). Creating a ref and moving a branch forward keep that true when everything the pack brought hangs off the new tips. A forced update, a deletion, objects the server wrote, an import from a fork and a fork's copy do not, and the next full clone walks history once to find out; the answer is kept until refs or packs change. A repository that does hold leftovers (pull requests from forks, a forced push) is walked by every full clone, as git does. Leftovers stay stored until a pruning repack exists; they are no longer served.

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
| `reader(locator, method, args)`                          | One `RepoReader` method, run in the object. Answers a `ReaderReply`; use `durableRepoReader`.        |
| `exportPack(wants, haves)`                               | A pack of what `wants` reach and `haves` do not, as a stream, for another repository's object.       |

### The reader

`RepoReader` (`repo/reader.ts`) is implemented once, in `repo/queries/`, against `Repository` and `@infrawrench/git-ops`: `refs.ts` (branches, tags, ref changes), `content.ts` (tree, blob, README), `history.ts` (lists of commits, blame), `diffs.ts` (commits, comparisons, their diffs), `merges.ts` (mergeability, merge, update branch), `index.ts` (lifecycle and the composition), `session.ts` (one call's view, ref resolution, the contract's shapes), `state.ts` (what is kept between calls). `localRepoReader(repository, state, locator)` is that reader wherever a `Repository` is.

**Every method runs inside the Durable Object.** `RepoDO.reader(repoId, locator, method, args)` runs one method next to the data and the Worker's reader (`reader-do.ts`) is nothing but that call. The alternative, the same code in the Worker with the object as an object store, was measured in workerd on this repository (2 870 commits, 93 303 objects), timed in the Worker around each call:

| Request                                  | In the object (one call) | In the Worker (a call an object) |
| ---------------------------------------- | ------------------------ | -------------------------------- |
| History, first 30 commits                | 1 ms                     | 33 ms, 62 calls                  |
| History of `KNOWLEDGE.md`, first 30      | 3 ms                     | 110 ms, 332 calls                |
| Last commits of `/`, 300 commits of walk | under 373 ms (see below) | 330 ms, 602 calls, and not done  |

Locally a call to the object is about half a millisecond, which is the best it will ever be: in production it is a hop to wherever the object lives. So the number that decides it is calls, not milliseconds here, and every operation that walks needs tens to hundreds of them. The operations that do not walk (a blob, a ref, a tree without history) are one call either way, and gain nothing from a second code path. `readObjects` batching does not help a walk, which learns the next id from the last object. So there is one implementation and one place it runs. The costs of that choice: reads share the object's 128 MB and its one thread with pushes (a diff holds two files of at most 1 MiB and its hunks; a push peaks near 88 MiB, "Memory" below), and a refusal has to cross the boundary as a value (`ReaderReply`), because an error thrown across it keeps only its message. An error the platform raises for the object itself (`overloaded`, `retryable`) becomes `unavailable`; anything our code throws stays a 500.

**Only types come from the contract in `queries/`.** The object's module graph is loaded at the Worker's start-up, and the contract's entry evaluates every schema of the API. `rawUrl` and the 1 MiB text limit are restated there; `test/reader.test.ts` holds both equal to the contract's.

**What is kept between calls** (`ReaderState`, one per object, gone when it sleeps):

- **The commit graph**: parents, tree and commit time of every commit a walk has read (`CommitGraphSource` in git-ops), up to 200 000 commits. Each request's `ObjectCache` reads through it, so only the first walk after a wake-up reads commits. It is in memory only. Loading it is what a cold request pays: counting this repository's 2 870 commits from nothing is about 120 ms on Node. A graph written down (with generation numbers) was not built: once the two answers below are stored, no request on the code page walks from the top, and at this size the cold cost is not worth a table. At a hundred thousand commits it would be (about four seconds cold for a count), and that is where to add it.
- **Sizes** (50 000), **diff summaries** (the changed files of a pair of trees with their line counts, 8), trial merges and last-change answers (256).
- **The file table's last commits, in steps.** `tree` walks for at most 2 000 commits or 150 ms and answers what it has (`lastCommitsComplete`); `treeLastCommits` carries the same walk on from where it stopped (10 000 commits or 400 ms a call). The continuation stays in the object's memory, keyed by commit and directory; if the object slept in between, the walk starts again.
- **Written down** (`reader_cache`, at most 128 rows, oldest pruned): a finished file table per directory and commit, and the number of commits a ref reaches. A woken object reads the row instead of walking, and a new head walks only as far as a commit that has a row (`known`, git-ops), or counts only what was added. This is one billed row write per directory viewed per new head.

**Sizes come from the pack, not from reading the object** (`PackStore.size`): the entry's header for a whole object, the second number of a delta's instructions for a delta (the first bytes of its zlib stream). One range read of 128 bytes, its own and not the block cache's, so a file table's size column (a probe per file, 24 at a time) does not push the commits and trees a walk is reading out of the cache. git-ops asks through it before reading a blob for a diff, a blame or a merge.

**Time budgets see time pass only across I/O.** In workerd `Date.now()` does not advance while code runs, so a walk over objects already in memory never reaches a `maxMillis`. Every budget therefore also has a count (commits, files, lines; `ReaderLimits` in `session.ts`), and the count is the real bound.

**The code page's requests**, this repository's root (26 entries), in milliseconds. Node figures are `test/reader-bench.test.ts` with R2 as a map; workerd figures are `test/e2e/reader.test.ts`, timed in the Worker around the call, local R2:

| Request                                              | Node   | R2 reads | workerd |
| ---------------------------------------------------- | ------ | -------- | ------- |
| `tree /` with last commits, first ever (walk begins) | 195 ms | 47       | 373 ms  |
| `treeLastCommits`, the one round it then takes       | 21 ms  | 4        | 262 ms  |
| `readme /`                                           | 1 ms   | 1        | 7 ms    |
| `tree /`, object just woken, answer written down     | 25 ms  | 30       |         |
| `tree /` again, object awake                         | 0.4 ms | 0        | 1 ms    |
| `readme /` again                                     | 0.2 ms | 0        | 1 ms    |

Of the woken object's 30 reads, 22 are size probes made at once and one is the pack index. Other requests, cold on Node (workerd, first call, object awake): a subdirectory's table first ever 141 ms (168 ms), a 400 KiB blob 45 ms (51 ms), 30 commits 23 ms (1 ms), 30 commits of one file 28 ms (3 ms), a commit with its file list 24 ms (17 ms), `HEAD~50...HEAD` with 250 changed files 386 ms and 514 reads (1.3 s), blame of `CLAUDE.md` 206 ms and 98 reads (415 ms). The comparison is the slow one: each changed file is two blobs read from wherever they lie, twelve files at a time, each through a 256 KiB block. Reading exact ranges, sorted and joined, would cut both the reads and the bytes, and is not built; the count stops after 2.5 s and says so (`filesTruncated`).

**Writes** are compare-and-swap on the base, like a push. A merge (merge commit, squash, rebase) is computed by git-ops against the base as it was read, its objects are written as one small pack (`writeObjects`), and `applyUpdates` moves the branch only if it is still there, sending the push event with the merging person as its actor. If the base moved, the merge is computed once more against where it went; if it moved again the caller is told (`base_moved`). The objects of a lost attempt are unreachable, as a refused push's would be. `updateBranch` is the same with the sides swapped (a rebase is a forced update of the head branch, and its event says so). `createBranch`, `deleteBranch` and `setPullRef` are one compare-and-swap each; `setPullRef` sends no event.

**A fork's pull request is read in the base repository.** Before anything that needs a commit from another repository (`compare` with `headRepositoryId`, `mergeability`, `merge`, `setPullRef`, `diffAnchor`, and `updateBranch` taking from the base), the object asks the other repository's object for a pack of what that commit reaches and its own branch and pull request tips do not (`exportPack`, one object calling the other and streaming the answer), takes it in through the same path as a push (indexed, every reference checked), and from then on reads one repository. A head named by branch is resolved in the other repository's refs first. The copy is skipped when the commit is already here, and capped at 512 MiB (`maxImportBytes`). The objects are unreachable until `refs/pull/<n>/head` points at them, which is how GitHub keeps a fork's pull request too. Two things follow: whoever may open a comparison against a fork can make the base repository store that fork's commits (the handlers only offer repositories the caller can read), and a full clone carries them, since a clone of everything includes what no branch reaches (see "Sending").

**Lifecycle.** `init` sets `HEAD`, marks the storage `ready` and, when asked, makes the first commit from `templates.ts` (a README; a `.gitignore` for Terraform, Node, Python, Go or Rust; MIT, ISC or Apache-2.0, the last byte for byte as published); a template it does not know is left out. A repository whose storage was never made, or was destroyed, refuses `unavailable` rather than looking empty. `forkFrom` is `importFork` (with only the default branch's ref when asked; the packs are copied whole either way). `destroy` empties the bucket prefix and the tables and can be called again. The API's handlers already called all three; `repositories.create` now also reads `stats()` after a first commit, which sends no push event.

**The reader's own limits** (`ReaderLimits`, `queries/session.ts`), on top of git-ops' (`Limits`):

| Limit                                   | Value                          | What happens at it                                          |
| --------------------------------------- | ------------------------------ | ----------------------------------------------------------- |
| Entries of a directory                  | 1 000                          | `truncated`.                                                |
| Text of a blob                          | 1 MiB (the contract's)         | `truncated`, `text: null`.                                  |
| A blob read to tell text from binary    | 8 MiB                          | Larger is `truncated` without being read.                   |
| File table walk, in `tree`              | 2 000 commits, 150 ms          | `lastCommitsComplete: false`; `treeLastCommits` carries on. |
| File table walk, in `treeLastCommits`   | 10 000 commits, 400 ms a call  | `complete: false`; call again.                              |
| Last change of one path                 | 5 000 commits                  | `lastCommit: null`.                                         |
| A filtered or path-limited history page | 20 000 commits, 500 ms         | A short page with a cursor, or the end.                     |
| Commits of a comparison                 | 250                            | `commitsTruncated` (the newest are listed).                 |
| Files of a diff with line counts        | 300, 2.5 s                     | `filesTruncated`; `stats` counts lines of those files only. |
| Hunk lines in one page of a diff        | 20 000                         | Later files of the page: `tooLarge`, ask by `path`.         |
| One file asked for by `path`            | 4 MiB, 400 000 lines           | `tooLarge`.                                                 |
| Blame                                   | 10 000 commits, 2 s            | Lines still in flight name the commit they had reached.     |
| Refs sorted by date                     | 1 000 branches, 5 000 tags     | Sorted by name instead.                                     |
| Commit count                            | 1 000 000 commits, 200 ms cold | `commitCount: null` until a later call finishes it.         |
| Commits a rebase replays                | 250                            | `too_large` (422).                                          |

**Where it differs from what the contract says.** `DiffFileSummary.additions` and `deletions` are exact for the files counted, and zero for a file over the text limit (`tooLarge`) or past the 300; `stats` adds up what was counted. `BlameRange.previousCommitOid` is the first parent that had the file under the same name, so it is null across a rename. A tag of a tree or a blob resolves to nothing (`ref_not_found`), as does an abbreviated id in another repository. Cursors are positions, so a branch list that changes between pages can repeat or skip a branch.

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
| Objects copied from a fork  | 512 MiB a pull request head                           | `RepositoryLimits`     |
| The reader's bounds         | "The reader"                                          | `queries/session.ts`   |
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
- `test/reader.test.ts`: the reader on the Node stand-ins against a history `git` built and pushed, with `git` as the judge: refs, the file table against `git log -1` per entry (in one call, in steps, and read back by a woken object), blobs (text, binary, over the limit), history (whole, by path, following a rename, by author and date, paged) against `git log`, commits and diffs against `git diff --numstat` and its patch text, comparisons across a merge against `git merge-base` and `rev-list --left-right`, blame against `git blame --porcelain`, review anchors, sizes of whole and delta objects against `git cat-file`, branch changes and their events, merge commit, squash and rebase against the trees `git merge`, `git merge --squash` and `git rebase` make, conflicts, a base that moves under a merge, `updateBranch` both ways, a fork's pull request compared, given its ref, brought up to date and merged across two repositories, init with templates, destroy, and the reply that crosses the object's boundary.
- `test/reader-api.test.ts`: the API's fetch handler over that reader for the content routes that need no database (refs, blob, readme, a commit's diff, a comparison's diff) and their refusals.
- `test/e2e/reader.test.ts` (opt-in, `GIT_WORKER_E2E=1`): the same path in workerd. The Worker's reader calling the real `RepoDO`, refusals crossing with their codes, the API's content routes served from it (`test/e2e/api.ts`: the real `makeGitApi` with its two gates answered from the fixture), init with a first commit cloned back by `git`, a branch created and a squash merge landed with their events on the queue naming the actor, and a fork's pull request: forked, pushed to, compared, `refs/pull/7/head` fetched from the base by `git` the way CI does, merged, the fork destroyed. With `GIT_WORKER_BENCH=1` too it pushes this repository and records the table in "The reader".
- `test/reader-bench.test.ts` (opt-in, `GIT_WORKER_BENCH=1`): the Node half of that table, with R2 reads counted.

The workerd suites are opt-in because they start `wrangler dev`; nothing in them needs an account or the network. The test entry now bundles the API, so the harness gives wrangler the production config's `define` and the alias map built from server-core's `gateway-only-modules.json`. The API routes that also read Postgres (the people behind commits, statuses: tree, history, a commit, branches, tags, blame, and everything about pull requests) are covered at the reader, not through their handlers: there is no database in either harness, and `src/__tests__/db/` runs those handlers on a fake reader. `directory-db.ts` (the Postgres half of the transports) is covered by neither: it is a few calls into `src/auth` and `src/db`, which have their own tests, and it needs a database to run.

### Left to do

- **Confirm full-duplex `fetch` to a Durable Object in production** before SSH opens (above).
- **Measure under the real 128 MB limit**, and decide the object and delta-size limits from it.
- **Prune**: repack merges but never drops unreachable objects, so a full clone can carry them.
- **Index paging** for repositories past a few million objects.
- **Keepalives** during long indexing, instead of a long SSH idle timeout.
- **Nothing sweeps objects whose row is gone.** The API's delete handler destroys the storage from `waitUntil` (`RepoReader.destroy`); a row deleted by a cascade in the app, or a `destroy` that failed, leaves objects only a sweep by id can find.
- **`git_repositories.size_bytes`, `pushed_at` and the counts** are set by the queue consumer from the event and `RepoReader.stats()`, and by `repositories.create` and `fork` when they make the first commit or the copy. A lost event leaves them stale until the next push.
- **The reader**: a commit graph that survives a sleep (with generation numbers, for exact and cheaper ahead/behind) once repositories reach tens of thousands of commits; exact range reads for a wide diff instead of a block per blob; objects copied from a fork are never pruned; `refs/pull/<n>/merge` is not written (nothing asks for it); line counts past 300 files; the handlers that read Postgres are not run end to end against real storage.

- **Nothing sweeps the storage of a repository whose row went by cascade** (a deleted namespace). The API's delete handler does call `destroy()`.
- **`git_repositories.size_bytes`, `pushed_at` and the counts** are the queue consumer's to set, from the event and `stats()`.
- **SSH rate limiting is per data centre.** A connection cap per principal is not there, and a session over SSH is not counted against the signed-in budgets the HTTP routes are (`http/admission.ts`).
- `refs/pull/<n>/head` is written by `RepoReader.setPullRef` (the pull request handlers and the consumer call it); pushes may not touch `refs/pull/*`.

## Versions and review (`repo/do/versions.ts`, `events/versions.ts`, `db/review.ts`, `review/`, `t3/`)

A branch is reviewed as a record of versions, and the branch page is its pull request shown another way. `git/README.md` ("Agent work review") has the product; this is what the Worker does.

### Recording

- **The Durable Object records a version in the transaction that moves the branch** (`Repository.updateRefs` calls `recordVersions`). Every push to a branch other than `HEAD`'s is one, forced or not, whichever way the ref moved (a push, a merge from the UI, `updateBranch`). SQLite holds `versions` (branch, lineage, number, tip, previous, forced, at) and `version_branches` (the lineage and number given out last, which outlive pruning so neither is reused). A push that loses its compare-and-swap moves nothing and records nothing, so a client's retry cannot count twice.
- **Lineage.** A branch created where none was starts lineage `n + 1` at number 1. Created at the commit its last version had (a deleted branch restored) it carries on and records nothing. Created at a commit the default branch already has (start work, `git push origin main:topic`) it starts the lineage with no version: the first push with work in it is version 1 (`bringNothing`, an ancestry walk done before the transaction).
- **Each version's commit is kept by a ref**, `refs/infrawrench/versions/<lineage>/<number>/<branch>`, in the same `refs` table as every other ref. That is what makes it readable by id after a forced push (`Repository.isReachable`, `queries/session.ts` `reachable`), which the branch page's diffs of older versions need.
- **No client sees or writes those refs.** `Repository.backend().listRefs` leaves out `refs/infrawrench/*` (`isHiddenRef`), and the protocol lists, resolves wants and checks old values from that one listing, so `ls-remote`, a clone, a fetch by id and `want-ref` never meet them. `policy.ts` `namespaceRefusal` already refused `refs/infrawrench/` to every push. `refs/pull/*` is still advertised: CI fetches it.
- **The full-clone fast path is untouched by a version ref.** The ref points at the branch's new tip, so recording one changes nothing about what branches and tags reach, and `changed()` is told only what the push itself did. A commit only a version ref holds exists because a forced push or a deletion left it, and that update has already cleared the "everything is reachable" answer. `Repository.pruneVersions` clears it too, in the transaction that removes the refs. Version refs are not branches or tags, so `countReachable`, `exportPack` and a fork's copy never follow them.
- **The queue consumer copies versions to Postgres** (`events/versions.ts` `recordVersions`, called from `handleBranch` before the "branch has moved on" return). It asks the object for every version after the newest one it has (`RepoReader.listVersions`) and inserts each, unique on repository, branch, lineage and number. So a redelivery writes nothing, and a push whose event was lost is copied by the next push to the branch (without a pusher: the event that named them is gone). The merge base and the stats come from `compare` against the pull request's base, else the default branch, when the storage answers.
- **A push claims the trace entries waiting on its branch** (`claimTraceEntries`: those written at or before the push), and a new version in a lineage clears that lineage's `prune_after` and sets it on the lineages before.

### The branch page

- **A draft pull request is opened at a branch's first push** (`openBranchPage`) when the repository has `autoOpenBranchPages` (the default; no row in `git_review_settings` means the defaults). Not for the default branch, a fork (its branches are proposed to the parent by a person), an archived repository, one with pull requests off, a branch with nothing ahead of the default branch, a branch that has an open pull request, or a lineage that ever had one (closing the page does not reopen it at the next push). The title is the commit's subject when one commit was pushed, else the branch's name. CI hears `opened` and Terraform plans are queued, as for one opened by hand.
- **Versions belong to a pull request** by `pull_request_id`: set when the version is copied (the first open pull request whose head is the branch), and by `linkVersionsToPull` when a pull request is opened on a branch that already has versions. `versionsForPull` reads those, of the newest lineage; a second pull request from the same head has none of its own and reads the branch's.
- **Start work** (`handlers/agents.ts`) creates the branch at the base's commit and a draft pull request whose body is the ask, with no commits between them (`pulls.create` refuses that; this handler does not go through it).
- **Review comments are written on a version** (`git_review_comments.version_number`) and carried forward by the consumer (`carryThreads`, in `syncHead`): `RepoReader.mapLines` says where an anchor's lines are at the new head. Lines that stand move the thread to their new numbers (`commit_oid`, `line`); lines that changed mark it `outdated` with `answered_in_version`. `RIGHT` anchors are compared head to head, `LEFT` ones merge base to merge base (from the versions' rows). A file renamed between versions counts as changed. Safe to repeat: a thread already at the new head is skipped.
- **Diffs** (`queries/versions.ts` `versionDiff`, on the head repository's reader, which has every version's commit and each one's base): the whole change is base to tip. An interdiff with one base is tip to tip. After a rebase the older version is first carried to the newer base by a three-way merge in memory (`mergeTrees(oldBase, newBase, oldTip)`, nothing stored), and that tree is compared with the newer tip, so what the rebase brought does not show. When that merge conflicts the tips are compared as they are and the answer says `exact: false`. The merge is redone for each page of the diff.
- **The must-fix merge block is live** in `mergeabilityDetail` (`must_fix_findings`, never bypassable with `bypass: true`): an open must-fix finding no `git_merge_overrides` row covers, where the repository's settings hold merges on them. Nothing writes findings yet.
- **Pruning** (`review/prune.ts`, the hourly cron trigger): `prune_after` is set thirty days out when the branch is deleted (the consumer) or its pull request merged (`pulls.merge`). The run removes the refs in the object, then the rows. A repository whose storage does not answer is left for the next run.

### Instructions (`db/instructions.ts`, `review/instructions.ts`, `handlers/instructions.ts`)

- **What the agent is told is written out when it is sent.** A review thread becomes its path, lines, version and every submitted comment quoted, then the reviewer's words; a finding its severity, place and text (`findingBody`, which whoever queues one itself can use). So an edit, a resolved thread or a pruned version does not change what was asked. A comment of a pending review cannot be sent.
- **States.** `queued`, `delivered`, `answered`, `dismissed`, each a single conditional `UPDATE`. `answered` without a version means "my next push": the row has no version number until `settleAnswered` gives it one, called from `recordVersions` for each version copied, for the instructions answered at or before that version's push. One marked answered after the push waits for the next. Settling also sets `answered_in_version` on the review thread the instruction came from, where a push has not already (`carryThreads` only does when the lines changed). `openInstructionCount` counts an unsettled answer as open, so the branch stays `agent_working` until the push arrives.
- **Who.** Sending and withdrawing take `write` and a person or an API key: a CI job's token is refused both (`peopleOnly`). Marking delivered and answered take `write` too, and that is the one place a job's token with write access reaches this group (`JOB_GROUPS`); a read-only job token lists and nothing else.
- **Delivery is `deliverInstructions(env, pullRequestId)`**, over rows, whoever inserted them. Whatever queues an instruction (the API, the review runner for a must-fix finding) inserts a `queued` row and calls it. It claims a row (`queued` to `delivered`, `delivered_via` the agent's kind) before telling the agent and puts it back if that fails, so two callers never tell an agent twice; it goes oldest first and stops at the first failure, so they arrive in order. Only `t3` has a sender (`t3/work.ts`). `infrawrench`, `mcp` and a branch with no agent named are pull: the agent lists its instructions and marks them itself.
- **The sweep** (`sweepInstructions`, the `*/2 * * * *` cron; `index.ts` tells the two crons apart by expression) delivers rows older than thirty seconds on pull requests whose agent has a sender. It is the backstop for a caller that did not deliver and for an environment that was asleep.
- **Sending answers after trying to deliver**, so the row a reviewer gets back already says `delivered` when the agent was reached. A T3 Code environment that does not answer costs the request its timeout (ten seconds) and leaves the row queued.

### T3 Code (`t3/`, `handlers/t3.ts`, `review/agent-connect.ts`)

Verified against T3 Code 0.1.11. An environment serves MCP at `<origin>/mcp` with MCP's OAuth; the forge is a client of it.

- **Reachability.** A Worker reaches public addresses only, so an environment is added by its public `https:` address: the one T3 Connect gives (a tunnel hostname), or a person's own proxy. `localhost`, a LAN address and a tailnet name cannot work and the first two are refused when typed, with a sentence that says to link T3 Connect. There is no relay API to go through instead.
- **Every request goes through `t3/http.ts`.** `https:` to a host `blockedHost` (the image proxy's rule) lets through, never this site, no credentials in the URL, `redirect: "manual"` with any 3xx a failure, a ten-second timeout (sixty for a clone or a launch) and a one-megabyte body cap. That applies to the addresses in the OAuth documents too (issuer, authorize, token, registration), which the environment chooses. The resource metadata address in a `401` challenge is used only on the environment's own origin. No `Origin` and no cookie is ever sent (T3 Code answers 403 to any `Origin`).
- **OAuth** (`t3/oauth.ts`): protected resource metadata, then authorization server metadata (RFC 8414 and the OpenID fallbacks, in the specification's order), dynamic registration as a public client with only `client_name`, `redirect_uris` and `token_endpoint_auth_method`, PKCE `S256` (a server that does not list it is refused), and the `resource` indicator on both requests. The redirect address is `SITE_ORIGIN` + `AUTH_PATHS.t3Callback`; nothing needs registering anywhere by hand.
- **A sign-in belongs to a session.** `state` is 32 random bytes on the row, single use, ten minutes. `t3/callback.ts` requires the browser's session to be the row's person before anything is exchanged, clears the state before the exchange, checks `iss` (RFC 9207), and redirects to a path stored when the sign-in began with `t3=connected` or `t3=failed`; nothing from the query reaches the answer.
- **Tokens.** One JSON object per row (`credentials_ciphertext`), sealed with `encrypt` under `ENCRYPTION_MASTER_KEY` and bound to the row. T3 Code issues an access token for thirty days and no refresh token, and has no revocation endpoint: a sign-in ends by running out or by being removed in T3 Code. Where a server does issue refresh tokens they are used a minute before expiry inside a transaction that holds the row (they rotate, so two requests must not spend the same one), and removal revokes where there is an endpoint.
- **`last_error` holds only sentences written here or T3 Code's own refusal** (cut to 500 characters, shown as text). Only a sign-in that no longer holds makes the status `error`; an environment that is asleep stays `connected`.
- **MCP** (`t3/mcp.ts`): Streamable HTTP, one `POST` per message, JSON or an event stream read to the response for the request's id. The client offers `2025-11-25` and takes what the server answers (T3 Code: `2025-06-18`, with a session id). A session lasts one request of the forge's; a `404` for it starts another.
- **Starting work** (`review/agent-connect.ts`, from `agents.startWork` and `agents.set`): `prepareAgent` runs before the branch is made and finds the environment's project by the repository's remote (`t3_project_list`), or clones it to `~/infrawrench-git/<owner>/<repo>` and registers it (`t3_project_clone`, `t3_project_create`, which need the person to have approved this site for full access). Then `t3_thread_launch` on a worktree named for the branch, from `origin/<base>` (the commit the forge made the branch at), with the ask, the branch to push to and how to add the forge's MCP server as the first message, and `clientRequestId` keyed by the pull request so a retry finds the same thread. The link's `externalRefs` are `threadId`, `projectId`, `threadUrl`. A launch that fails keeps the pull request and leaves `launchError`; `agents.set` with the same environment and no `threadId` tries again. `startUrl`, `launchError` and `threadStatus` are the forge's to write and are dropped from what a client sends.
- **The thread pushes with its own machine's Git credentials.** Nothing of the forge's (no session, no token) is sent to an environment, and the prompt says so.
- **State.** `agents.get` adds `externalRefs.threadStatus` (`idle`, `running`, `waiting`, ...) from `t3_thread_read`, kept fifteen seconds per isolate. The branch page's state does not ask the environment. T3 Code 0.1 has no event subscriptions, so nothing is pushed back.
- **An Infrawrench agent** is started by the app, never from here: its link carries `startUrl` (`<app>/org/<id>/agents?git=<owner>/<repo>&pull=<n>`) and `organizationId`, and the app writes `sessionId` on the same row when it starts the session. A person's repository has no organisation to start one in and is refused, unless a session that already runs is being named.

### Not built yet

`handlers/traces.ts` and `handlers/findings.ts` answer 503 `not_implemented` after their gates. Each file's header says what is already in place for it. `review/masking.ts` (`maskSecrets`) is what a trace goes through before it is stored.

### Known gaps

- A version's commit stays readable by id (the API, raw, archive) until it is pruned, which is the point, and also means a secret pushed to a branch and forced away is still readable by the repository's readers for as long as the branch lives and thirty days more. There is no way to drop one version by hand yet.
- A fork's version copied late (its event was lost and a forced push has since moved the branch) has no base: the base repository can only import what the fork's branches still reach.
- The inbox counts comments and findings with a query per row of the page.
- An instruction's delivery is claimed before the agent is told. A Worker that dies between the two leaves a row `delivered` that was not; T3 Code's `clientRequestId` makes a repeated send harmless, but nothing repeats it.
- Starting work with T3 Code waits on the environment inside the request: a clone that takes over a minute fails the request, and the retry finds the folder there and unregistered, which the person finishes in T3 Code (add the folder as a project).
- A T3 Code thread is launched with the project's default model. A project without one is refused by T3 Code in a sentence that says so; there is no model picker here.
- A branch's T3 Code environment is its connector's. Instructions other reviewers send are delivered with that person's sign-in, and stop being pushed when they remove the environment.

## Terraform (`src/terraform/`, `src/events/terraform.ts`)

`../terraform/NOTES.md` is the design and the whole flow; this is what runs in the Worker.

| File                        | Job                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------ |
| `terraform/state-store.ts`  | `WorkspaceStateStore`: the package's `StateStore` over a Durable Object's SQLite and R2.               |
| `terraform/state-serve.ts`  | What the object does with a request: the backend, restore, forced unlock. Reports the head afterwards. |
| `terraform/state-do.ts`     | `TerraformStateDO`: the shell that is Cloudflare about it.                                             |
| `terraform/client.ts`       | `stateClient(env, workspaceId)`, and `localStateClient` for tests.                                     |
| `terraform/access.ts`       | `decideStateAuth`: who may read, write and administer a state. Pure.                                   |
| `terraform/route.ts`        | `terraformState` and `terraformPlan`: the two routes, over a `TerraformDirectory`.                     |
| `terraform/directory-db.ts` | The directory over Postgres, and `recordStateHead`, the mirror.                                        |
| `terraform/tree.ts`         | A commit's tree as root discovery reads it.                                                            |
| `events/terraform.ts`       | Recording runs: pull request plans, merge applies, runs by hand.                                       |

- **One Durable Object per workspace** (`idFromName(workspaceId)`) holds the lock, the current version and the catalogue; the bytes are R2 objects `terraform/<workspaceId>/<serial>-<versionId>.tfstate`, written once each. `commit` uploads first and moves the head in one synchronous transaction that checks the head is still what the backend decided on, so of two writers one wins and the other's object is deleted again (`test/terraform-state.test.ts` races two).
- **The object never opens Postgres.** Every answer to a change carries the head in `x-infrawrench-terraform-head`; the front Worker mirrors it (`recordStateHead`: the `git_terraform_state_versions` row of a write, and the workspace's `current_*` and `lock_*` columns) and takes the header off. A mirror that fails is logged and not the client's problem: the object has answered, and the next change mirrors again. The handlers ask the object, not the row, before they delete a workspace.
- **Access** is `decideStateAuth` (`access.ts` has the table), and the answers are the route's: 401 with a Basic challenge for no valid credential, whatever the path names; 403 for a credential that may not, a missing repository and a missing workspace alike; never 404 or 204, which Terraform reads as "no state yet". People need `admin` on the repository: `write` is every member of an organisation, and a state holds every secret its workspace manages. A personal access token works for an administrator and needs `repo:write` (the directory asks `repoAccess` about the token and about the person behind it, `stateHolder`); it never administers, so deleting the state and unlocking without the lock's id are an API key's with `git:admin`, or the UI's. The routes read `Authorization` only: the session cookie is taken off before authentication, as on smart HTTP.
- **A run's job token** (`iwj_`, minted by server-core when the run is sent) carries its workspace's id and works for that workspace alone, for the run whose `ci_run_id` is its `run` claim, while that run is `queued`, `running` or `planned`. A plan's is `read`: it reads the state, takes the lock and posts its plan. An apply's is `write`: it writes the state too. Neither administers. A job token that names no workspace, or another one, is refused: without the claim it is not a credential here at all (401), with another workspace's it is a 403. The app's own token (purpose `terraform-link`) is bound to a workspace the same way; it reads a state and a plan's pricing inputs, and nothing else.
- **A plan** is posted by its job, summarised (`summarizePlan`), stored through server-core's `recordTerraformPlan` and dropped: it is never stored or logged. What pricing needs (`planPricingInputs`) waits at `terraform/<workspaceId>/plans/<runId>.json` and is deleted by the `GET` that reads it.
- **Runs.** `queuePullRequestPlans` plans the workspaces a pull request touches (`touchedRoots`: the comparison's changed paths against discovery at the head; every workspace when the storage cannot say), records a fork's as `skipped` and nothing for a personal namespace. `queueMergeApplies` records an apply as `queued` or `awaiting_approval` (`initialApplyStatus`). `recordRun` then starts, announces or notes the run through server-core, and a failure there leaves a queued row the app's pass starts.
- **The API** (`handlers/automation.ts`): `approveRun` is gated in the handler (`mayApprove`: a signed-in person with `admin` on the repository, or `ci:approve` in the organisation; never a personal access token); `createRun` starts a plan at once and an apply as approved only for someone who may approve; `discardRun` discards a plan or cancels a live run and its CI run; `forceUnlock`, `restoreStateVersion` and `downloadStateVersion` go to the object, and all three take `admin`; a CI run's output (`ci.getRun`, `ci.runLog`) is withheld from a caller without `write` when the run is a workspace's (`terraformOutputWithheld`), since Terraform prints values that are not marked sensitive; `listAccounts` is the picker; a workspace's and a resource's `monthlyCost` come from `managedResourceCosts`, through the caller's cost visibility, for a session with `costs:read`.
- **Tests.** `test/terraform-state.test.ts` runs the real `terraform` against the routes on Node stand-ins (apply, lock contention, restore, the 401 and 403 answers, the plan route) and the store's races. `test/e2e/terraform.test.ts` (opt-in, `GIT_WORKER_E2E=1`) does the same in workerd with the real `TerraformStateDO` and real job tokens. `src/__tests__/db/terraform.test.ts` (`test:db`) covers runs against Postgres: the CI run and its pipeline (no secret in it), a fork skipped, the approval gate, a plan's summary on the run, the commit and the timeline, and what a workspace manages on both sides with its cost.
- **Left to do.** A removed workspace's objects are not swept (`StateClient.destroy` exists and nothing calls it; the contract promises thirty days). Drift is not read from the app. `pluginName` on an account is its plugin id: the Worker has no plugin manifests to name it from.

## Tests (auth and data access)

`pnpm --filter @infrawrench/git-worker test` needs nothing. `DATABASE_URL=postgres://... pnpm --filter @infrawrench/git-worker test:db` runs `src/__tests__/db/` against a migrated scratch Postgres (they skip without it): the API end to end with a header in place of a session and `src/__tests__/helpers/fake-reader.ts` in place of the storage. They cover visibility (a private repository in no list and a 404 every way it is asked for), numbering under concurrency, the filters and paging of the thread lists, merging under protected branches with statuses written by server-core's writer, and the consumer's idempotency. `src/api/__tests__/handlers.test.ts` runs the content handlers through `HttpApiTest`'s in-memory client and the fetch handler with the two gates replaced, without a database.

The unit suites: `src/auth/__tests__/access.test.ts` is the access matrix (public and private, organisation roles, collaborators, token scopes, API keys, deploy keys, job tokens, archived). The rest cover credentials, tokens, job tokens, the cookie, JWT verification, the session refresh, the three sign-in routes, SSH keys, protected-branch rules and the permission rule. None needs a database or the network.

## After the security review

`git/SECURITY-REVIEW.md` has the findings. The rules that came out of it, by area:

### Access

- **A pull request's or a comparison's head is the base, or a repository in its fork network** (`api/repos.ts` `headRepository`) that the caller can read, and a private head only goes into a private base of the same namespace (`mayProposeTo`). The consumer stops following a fork that no longer passes, and `updateBranch` does not copy a private base into a fork more people can read.
- **A personal token without `repo:write` changes nothing through the API** (`api/context.ts` `mayWriteThroughApi`), and no token claims or renames a username.
- **A job token reaches the `statuses` group only** (`api/middleware.ts`).
- **Only a pull request from the base repository itself queues Terraform plans** (`plansPullRequest`).
- **A workspace's accounts are shown with `accounts:read` and lent with `ci-access:write`** in the owning organisation; a resource's match is shown with `resources:read`; a lock's id and holder and state labels at repository `write`.
- **A transfer drops the workspaces' account links and managed resources** (`moveWorkspacesToOrganization`), and CI runs are shown only under the organisation that made them.
- The assignee list is for callers with `triage` and members of the owning organisation. Commit authors are matched only to people with a forge username.

### What can be read by id

- **A commit is read by id only when a ref reaches it**: the API (`queries/session.ts` `resolveCommitId`, memoised per ref state; `createBranch` is the exception, so a writer can restore a deleted branch), the raw and archive routes and `readPath` (`Repository.isReachable`, `refs/pull/*` included, which CI needs), and `exportPack`, which sends another repository only what the source's own branches and tags reach.

### Pushes

- **A push writes `refs/heads/*` and `refs/tags/*` and nothing else** (`policy.ts` `namespaceRefusal`), with or without a policy. A ref that would be a file and a directory at once is refused. The forge's own path refuses deleting HEAD's branch too.
- **A pushed pack passes core's `ObjectFsck`** and may inflate and rebuild 8 GiB at most (`maxInflatedBytes`). Packs the server makes (repack, a fork's copy, an import) are not held to either.
- Stored `ref-delta` chains are followed 4 096 deep at most.

### HTTP

- **Smart HTTP ignores the session cookie.** Raw and archive take it (the UI's images and download links).
- **Raw files** (`transport/http/raw-headers.ts`): raster images inline with their type; SVG and PDF with their type as a download; UTF-8 text as `text/plain`; everything else `application/octet-stream` as a download. Always `Content-Security-Policy: default-src 'none'; sandbox`, `nosniff`, `Cross-Origin-Resource-Policy: same-origin`, `private, no-store`, and a file name that cannot end a header. These headers are the whole defence while raw files share the site's origin; a separate origin for them is the stronger answer and is not built.
- A request body in an encoding other than gzip is a 415, and a fetch's body is 32 MiB at most once inflated.
- **Archives** leave out names that could land outside the unpack directory, refuse a directory over 1 MiB and stop at 500 000 entries.
- **Every `/api` answer is `private, no-store`** with `Cross-Origin-Resource-Policy: same-origin`; pages add `Cross-Origin-Opener-Policy: same-origin` and `base-uri 'none'`.
- **Admission** (`http/admission.ts`, `http/rate-limit.ts`): a caller without a credential is counted by address (an IPv6 /64) against budgets for cheap reads, heavy reads and writes, and 60 refused credentials in ten minutes refuse that address's credentialed requests for the rest of the window. A caller who authenticated is counted by who they are (`Admission.admit`, `subjectOfPrincipal`: a person by id whichever credential they used, an API key, a deploy key, a CI run) against the signed-in budgets, four times the anonymous ones: by the API's `Authentication` middleware and by the Git routes (smart HTTP, raw, archive), each right after it resolves the principal and before it looks anything up. Heavy reads are a diff, a blame, a comparison, a filtered history, the file table's last commits, an archive, a raw file, a clone or fetch and a search (`classify`). Counts live in the six `RL_*` Rate Limiting bindings (`ratelimits` in `wrangler.jsonc`, per Cloudflare location, approximate by design), else the data centre's cache, which is what local development and the tests use; `http/__tests__/bindings.test.ts` holds the bindings' limits to `DEFAULT_RATE_BUDGETS`. Git over SSH is not counted here.

### SSH

- **The key is looked up again before every command**, so a removed key stops working on a connection that is already open (a command that is running finishes).
- Failed authentication is counted per IPv6 /64; an IPv4 address written inside IPv6 counts as that address.
- The client's version string and an error's message are quoted, escaped and cut at 80 characters in the log line.
- The command parser trims ASCII blanks only and refuses a path that starts with `-`.

### The reader

- New `ReaderLimits`: `treeWalkEntries` (200 000), `lastCommitsEntries` (1 000 000), `diffCountLines` (4M), `diffPageBytes` (4M characters), `diffPageCompared` (2M lines), `shownMessageBytes` (64 KiB), `listedMessageBytes` (4 KiB). The file table walks only the names it lists. A git-ops `limit` refusal is `too_large` (422). A trial merge that was refused is remembered like one that succeeded.

### Logging

- **Nothing passes an error object to `console`.** `http/log.ts` `describeError` writes the class, the message without a statement's parameters or a schema error's value, a few frames and the causes, with anything shaped like a credential cut to its kind and control characters removed.
