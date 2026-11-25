# @infrawrench/git-worker

Notes per area. Settled decisions move up into `git/README.md` and KNOWLEDGE.md.

## Bindings and configuration (`src/env.ts`, `wrangler.jsonc`)

- `Env` is the one type for bindings and secrets: `HYPERDRIVE`, `OBJECTS` (R2), `REPO` and `TERRAFORM_STATE` (Durable Object namespaces), `EVENTS` (queue producer, typed `Queue<GitEvent>`), and the secrets `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `WORKOS_COOKIE_PASSWORD`, `SSH_HOST_KEY`, `JOB_TOKEN_KEY`, `ENCRYPTION_MASTER_KEY`. Variables: `SITE_ORIGIN`, `APP_ORIGIN`, `WORKOS_API_HOSTNAME`.
- **The Durable Object bindings and the queue consumer are commented out in `wrangler.jsonc`.** Wrangler refuses a binding whose class the entry does not export. Whoever exports `RepoDO` and `TerraformStateDO` from `src/index.ts` uncomments `durable_objects` and `migrations`; whoever adds the `queue` handler uncomments `consumers`. The names are fixed by `Env`: bindings `REPO` and `TERRAFORM_STATE`, classes `RepoDO` and `TerraformStateDO`, both SQLite classes.
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
- **CI job tokens** (`job-token.ts`): `iwj_<claims>.<HMAC-SHA256>` under `JOB_TOKEN_KEY`, stateless. Claims: repository id, write or not, run id, expiry. Default lifetime one hour, at most twelve. They cannot be revoked one at a time; rotating the key revokes all. The MAC is checked before the claims are parsed. `server-core/src/ci/` will mint these when it dispatches a run from a repository here (it needs the same key, or an endpoint here that mints for it: undecided).
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
- Modules, one per table group: `users`, `namespaces`, `repositories` (and stars), `collaborators`, `keys`, `tokens`, `organizations`, `threads` (issues, comments, labels, assignees, milestones, timeline events), `pulls` (pull requests, reviews, review comments), `policy` (protected branches, commit statuses). `policy-rules.ts` and `org-permissions.ts` are the parts with no database.
- **Conflicts come from the unique indexes**, never check-then-insert: claim, create and rename functions catch Postgres `23505` (`isUniqueViolation`) and answer null or a reason.
- **Counters move with their rows**: `next_number`, the open counts, `comments_count`, a milestone's counts, `stars_count` and `forks_count` each change in the transaction that changes what they count. `setThreadState` and `markMerged` answer null or false when the row was already in that state, so a race produces one change.
- **Lists are `(timestamp, id)` keyset pages** (`cursor.ts`), fetching `limit + 1`. `listRepositories` and `listThreads` cover the default orders; text search and the other sorts in the contract are for the handlers to add.
- `visibleTo(viewer)` is the SQL twin of `repoAccess >= read` for a whole page: public, own namespace, collaborator, or an organisation in `readableOrganizationIds`, which the caller resolves (the organisations where the viewer holds `git:read`).
- **Deleting a repository's row does not delete its objects.** R2 packs and the Durable Object are keyed by the id `deleteRepository` was given; the caller removes them. Deleting an account or an organisation in the app cascades to namespaces and repositories here, leaving objects only a sweep by id can find.

## Tests

`pnpm --filter @infrawrench/git-worker test`. `src/auth/__tests__/access.test.ts` is the access matrix (public and private, organisation roles, collaborators, token scopes, API keys, deploy keys, job tokens, archived). The rest cover credentials, tokens, job tokens, the cookie, JWT verification, the session refresh, the three sign-in routes, SSH keys, protected-branch rules and the permission rule. None needs a database or the network.
