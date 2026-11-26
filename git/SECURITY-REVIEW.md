# git.infrawrench.com: security review

November 2026, before the forge opens. The review covered `git/packages/*` as of `9994f9dcd` (the Terraform state route and its Durable Object had not landed, and there was no deploy workflow), read with one question: how does someone who should not get a private repository, a credential or another organisation's data get it anyway, and how does one anonymous request cost a lot.

Each finding has a severity, the scenario, what was changed and where it stands. `fixed` names the test that holds it. `open` names who it is for: the Terraform runtime and the deploy configuration were being written by others while this review ran, so their findings are recorded here and not changed.

Severity is about this forge: **high** is a private repository's content, a credential or cloud access reaching someone it should not; **medium** is a narrower leak, a write that should have been refused, or one request that takes a repository or a page down; **low** is hardening.

Tests under `git/packages/worker/src/__tests__/db/` need a Postgres and were written but not run during the review; each is marked "(database)".

## Summary

| Area                              | Critical | High | Medium | Low | Still open                                      |
| --------------------------------- | -------- | ---- | ------ | --- | ----------------------------------------------- |
| 1. Object ids (SHA-1)             |          | 1    |        |     |                                                 |
| 2. Access and visibility          |          | 3    | 5      | 4   | 1 accepted (a decision)                         |
| 3. Tokens, sessions, headers, log |          |      | 2      | 6   | 1 low                                           |
| 4. Transports and storage         | 1        | 3    | 5      | 5   | raw files on their own origin; large raw blobs  |
| 5. SSH and hostile bytes          |          | 2    | 3      | 3   | the address behind Spectrum; per-principal caps |
| 6. Web UI                         |          |      | 1      | 6   | image proxy (a decision)                        |
| 7. Denial of service and cost     |          | 2    | 7      | 1   | signed-in rate limits; bindings in wrangler     |
| 8. Terraform (in flight)          |          | 2    | 4      | 8   | all of it, for the Terraform runtime            |
| 9. Deploy configuration           |          |      | 1      | 2   | all of it, for the deploy configuration         |

Sections 8 and 9 count only what is still open; the Terraform findings that could be fixed from outside the in-flight files are in section 2.

## Decisions wanted

1. **Raw files on their own origin.** Raw content is served from the site's origin behind `sandbox`, `nosniff` and a download disposition for anything that can script (4.5). That holds in current browsers, and it is the only thing that does. Forges serve raw content from a separate registrable domain so that a mistake there cannot reach the session. It needs a domain and a route; nothing else.
2. **Who may read and write Terraform state** (8.2). The design says repository `write`. Every member of an organisation has `git:write` on every repository, so that is every member reading every state and able to rewrite it. Recommended: repository `admin` (or a new `git:terraform` permission) for people, a workspace-bound claim for job tokens.
3. **Private pull requests between private repositories of one namespace** (2.1): allowed today, although their collaborators can differ.
4. **An image proxy** (6.2): without one, the author of a comment or README learns the address of everyone who reads it.
5. **Rate Limiting bindings** (7.10): the config is in section 9; without them the counts are per data centre and best effort.

## 1. Object ids

### 1.1 Objects were named by a SHA-1 without collision detection (high, fixed)

- **Scenario.** Two different files with one SHA-1 can be bought (SHAttered 2017, chosen-prefix 2020). Someone pushes the harmless half, it is reviewed and merged, and the other half is later served under the same id wherever the first is not already present. Git refuses such objects (`sha1dc`); this store did not, and hashed objects of 32 KiB and more with WebCrypto, which cannot.
- **Fix.** `@infrawrench/git-core`'s `Sha1` now carries the detection of Stevens and Shumow, ported from the reference implementation git vendors (`core/src/sha1.ts`, generated tables in `sha1dc-ubc.gen.ts`, licence in `core/LICENSE-sha1collisiondetection.txt`). It is on in every hasher, so every way an object gets an id is covered: pushed packs (streamed and whole objects), loose objects, and objects the server writes. WebCrypto no longer computes any id. A colliding object is a `GitError` (`sha1-collision`) and the push is refused with that message.
- **Checked by.** `core/test/sha1dc.test.ts`: both SHAttered files and both Shambles messages are refused in any chunking and with anything appended; ordinary input never is; a pack carrying an object the hasher refuses is refused; no id is computed through WebCrypto. The generated bit-condition check was compared with the compiled reference on a million blocks (all 32 vectors exercised, no difference).
- **Cost.** SHA-1 in this package goes from 388 to 304 MiB/s (22%). Large objects lose more, because they used to go to WebCrypto at 1.5 to 3 GiB/s. Core's notes have the breakdown.

## 2. Access and visibility

`repoAccess` is still the one place a level is decided, nothing caches it between requests, and every list goes through `visibleTo`. What was wrong was around it.

### 2.1 A pull request or comparison could take its head from any repository the caller could read (high, fixed)

- **Scenario.** Someone who can read the private `acme/secret` opens a pull request into any public repository with `headRepository: "acme/secret"` (or just asks for the comparison). The base copies the head's commits into its own storage and `refs/pull/<n>/head` serves them to everyone. The pull request then kept following the private branch on every push, also after the person lost access.
- **Fix.** `api/repos.ts` `headRepository`: the head must be readable by the caller, in the base's fork network, and `mayProposeTo` must hold (the head is public, or both are private in one namespace). `pulls.create`, `pulls.reopen` and the comparison use it; `pulls.updateBranch` checks the reverse direction; the queue consumer stops following a fork that no longer passes.
- **Test.** `worker/src/api/__tests__/repos.test.ts`; `src/__tests__/db/boundaries.test.ts` (database).
- **Accepted, open.** Two private repositories of one namespace can have different collaborators, and a pull request between them shows the head's commits to the base's readers. That is the rule the README sets ("inside the same owner's reach"); tightening it to "every reader of the base can read the head" is a product decision.

### 2.2 A fork's pull request queued Terraform plans in its base (high, fixed)

- **Scenario.** Anyone who can fork opens a pull request into a branch a workspace plans. A plan row was queued for the fork's head. Whatever dispatches those rows would run the fork's Terraform (providers, `external` data sources) with the workspace's cloud accounts and state.
- **Fix.** `plansPullRequest` (`api/repos.ts`): only a head in the base repository itself queues plans; both call sites (`handlers/pulls.ts`, `events/consumer.ts`) use it. The dispatcher must check again when it lands (5.1).
- **Test.** `worker/src/api/__tests__/repos.test.ts`.

### 2.3 Any member could lend the organisation's cloud accounts to a workspace (high, fixed)

- **Scenario.** Linking connected accounts to a Terraform workspace needed only `accounts:read`, which every member has, while the app's own CI lending needs `ci-access:write`. A member links production accounts to a workspace, pushes a branch, and their unreviewed code plans with those credentials.
- **Fix.** `handlers/automation.ts` `checkAccounts` requires `ci-access:write` in the owning organisation whenever a workspace's account list changes.
- **Test.** `worker/src/api/__tests__/terraform-views.test.ts`; `boundaries.test.ts` (database).

### 2.4 A personal token without `repo:write` could write through the API (medium, fixed)

- **Scenario.** A `repo:read` token (or one with no scope) could open issues, comment, review and star: those endpoints need `read` on the repository, and nothing looked at the token's scope.
- **Fix.** `api/context.ts` `mayWriteThroughApi`: a token without `repo:write` makes no change of any kind. Every handler runs through it.
- **Test.** `worker/src/api/__tests__/token-scope.test.ts`.

### 2.5 Any token could claim or rename its owner's username (medium, fixed)

- **Scenario.** A leaked token with no scopes renames the person; the old name, and every URL under it, is free for someone else.
- **Fix.** `handlers/session.ts`: claiming and renaming need the session.
- **Test.** `token-scope.test.ts`.

### 2.6 CI job tokens reached the whole JSON API (medium, fixed)

- **Scenario.** A job's `iwj_` token with write access could merge pull requests and delete branches of its repository through the API; a read token could read CI logs and Terraform runs. A job's code holds that token.
- **Fix.** `api/middleware.ts`: a job token reaches the `statuses` group and nothing else.
- **Test.** `worker/src/api/__tests__/handlers.test.ts` ("keeps a CI job token to commit statuses").

### 2.7 A transfer kept the old organisation's cloud accounts on the workspaces (medium, fixed)

- **Scenario.** After a repository moves from organisation A to B, its workspaces still lend A's accounts to B's runs and show A's account and resource names to B's readers.
- **Fix.** `db/automation.ts` `moveWorkspacesToOrganization`: one transaction moves the workspaces and deletes their account links and managed-resource rows.
- **Test.** `boundaries.test.ts` (database).

### 2.8 Readers of a public repository saw the organisation's accounts and resources (medium, fixed)

- **Scenario.** The Terraform endpoints need `read`, so on a public repository anyone, signed in or not, got the linked accounts (id, name, provider), the lock holder's `user@host`, and for each resource in state the matched Infrawrench resource id and name. A writer of state could also probe which cloud ids exist in the organisation's inventory.
- **Fix.** `handlers/automation.ts`: accounts are sent with `accounts:read` in the owning organisation, a resource's match with `resources:read`, the lock's id and holder and state-derived labels at repository `write`. Without `resources:read` the `matched` filter answers nothing.
- **Test.** `terraform-views.test.ts`; `boundaries.test.ts` (database).

### 2.9 Lower

- **CI runs from before a transfer were shown under the new owner** (low, fixed): `listCiRuns` and `getCiRun` also match the run's organisation. No test (the fixture needs most of `ci_runs`).
- **The assignee list showed an organisation's members to any signed-in reader of a public repository** (low, fixed): only callers with `triage`, or members, get it. `token-scope.test.ts`.
- **A commit's author email was matched to any Infrawrench user** (low, fixed in part): only people with a forge username are matched now (`views/commits.ts`). An email still resolves to a forge username, as on other forges.
- **A profile's website was stored unchecked** (low, fixed): `handlers/session.ts` takes `http` and `https` only, as a repository's homepage does; the UI no longer links anything else either.

### Checked and holds

Search, explore, namespace pages, `/user/repos`, stars, stargazers, fork lists and fork parents go through `visibleTo`. A private repository the caller cannot read is the same 404 as a missing one on every API route. Mentions and `fixes #n` act only inside the same repository and only from its default branch; a cross-reference from a private repository is hidden in the timeline; a head repository the viewer cannot read shows as null. A fork of a private repository stays private in the same namespace and cannot be made public or transferred. Every id in a path (comment, label, milestone, review, rule, key, run, workspace) is looked up within the repository in the path. An API key needs its owner to still be a member, reaches only its organisation, and never passes a person-only gate. Removing a member or a collaborator takes effect on the next request. Payloads are mapped field by field, `LIKE` patterns are escaped, sort columns come from enums.

## 3. Tokens, sessions, sign-in, headers, logging

### 3.1 A cookie write without an `Origin` was accepted, and a sibling site was not told apart (medium, fixed)

- **Scenario.** A page on another `*.infrawrench.com` host is same-site, so `SameSite=Lax` sends the session cookie with its POSTs; the only check left was `Origin`, and a write without one passed. The same check stands in front of sign-out and of a push over HTTPS with the cookie.
- **Fix.** `auth/sign-in.ts` `writeOrigin` reads `Origin` and `Sec-Fetch-Site`. A cookie write must say it came from this origin; one that says nothing is refused. A write that says it came from elsewhere is refused whatever credential it carries (a browser re-sends Basic credentials it remembers).
- **Test.** `auth/__tests__/session.test.ts`, `auth/__tests__/credentials.test.ts`.

### 3.2 Errors were logged whole (medium, fixed)

- **Scenario.** An uncaught error went to `console.error` as an object. A database error's message ends in the statement's parameters (the text of a private comment, an email); a schema error raised while encoding an answer holds the value, which for the token endpoints is the token just minted. Both would sit in Workers Logs.
- **Fix.** `http/log.ts` `describeError`: class, message without parameters or values, a few frames, causes; anything shaped like `iwg_`/`iwk_`/`iwj_`, a bearer or basic credential, a sealed cookie or a `token=` query is written as its kind only; control characters are removed so one log line stays one line. Used by every log call of the worker.
- **Test.** `http/__tests__/log.test.ts`.

### 3.3 Lower

- **API answers had no `Cache-Control`** (low, fixed): every `/api` answer is `private, no-store` with `Cross-Origin-Resource-Policy: same-origin`. `handlers.test.ts`.
- **`returnTo` accepted non-printable characters and any length** (low, fixed): printable ASCII, at most 2048 characters; a value a header cannot carry used to fail the redirect after the session was made. `session.test.ts`.
- **The job token reader did not bound a token's lifetime** (low, fixed): `verifyJobToken` refuses an expiry more than six hours away. `credentials.test.ts`.
- **Page headers** (low, fixed): `base-uri 'none'` and `Cross-Origin-Opener-Policy: same-origin`. `http/__tests__/router.test.ts`.
- **`onboarding` was not a reserved namespace** (low, fixed): a namespace of that name with a repository `username` would sit behind the UI's own page. Added to client-core's `GIT_RESERVED_NAMESPACES`; a new top-level page of the UI needs its name there too.
- **Sign-in state and the session cookie are sealed under one key with the same additional data** (low, open): they are told apart by shape only. Nobody can seal a value of their choosing, so it holds; a purpose label in the additional data would make it hold by construction.

### Checked and holds

`iwg_` tokens: 32 random bytes, only the SHA-256 stored, compared in constant time, revocation and expiry on every use, one answer for unknown, revoked and expired. `iwk_` keys: the same checks as the app's, stricter on permissions. `iwj_` tokens: the MAC is checked before the claims are parsed and covers their exact text, the key is used for nothing else, a commit-bound token is refused everywhere but that commit's archive. The session cookie: AES-256-GCM under an HKDF key with a per-cookie salt, `__Host-`, `Secure`, `HttpOnly`, `SameSite=Lax`, no `Domain`; the development name is never read over HTTPS. Refresh: the loser of a race stays anonymous and does not clear the winner's cookie. Sign-in state is bound to an `HttpOnly` nonce cookie, so a sign-in started elsewhere cannot finish in this browser. An `Authorization` header that is refused is a 401 and never falls back to the cookie. There is no CORS answer anywhere. The referrer policy sends other sites this origin only, never a path.

## 4. Transports and storage

### 4.1 A full clone sent objects no branch or tag reaches (critical, fixed)

- **Scenario.** `git clone` of a public repository, by anyone. The fast path for a full clone sent every stored pack whole. A repository's packs also hold what a forced push or a deleted branch left behind, what only `refs/pull/*` reach, and commits copied in from forks for a comparison or a pull request. So a secret removed with a force push was still in every clone; and with 2.1, comparing a public repository against a private fork put the fork's commits into every anonymous clone of the public one. A fork copies its parent's packs, so it carried all of that along.
- **Fix.** `repo/do/repository.ts`: the storage records whether every stored object is known reachable from a branch or tag. Creating a ref or moving a branch forward keeps that true when everything the pack brought hangs off the new tips; a forced update, a deletion, server-written objects, an import and a fork's copy do not, and the next full clone walks history once to find out (the answer is kept until refs or packs change). When leftovers exist the stored packs are not used and the protocol walks from the wants, as git does. The backend contract in `protocol/src/backend.ts` now says so.
- **Test.** `worker/test/repository.test.ts`, with the real `git`: "does not clone, fetch or read by id what a forced push left behind", "keeps commits copied in from another repository out of a clone", "goes back to the stored packs once every object is reachable again".
- **Left.** The leftovers are still stored (and billed) until a repack prunes; they are no longer served.

### 4.2 Unshallowing sent the history of any commit a client named (high, fixed)

- **Scenario.** A fetch with `shallow <any commit id>` and a deepen: the server took the named commit for one the client had and sent it with its history, reachable or not, in every protocol version.
- **Fix.** `protocol/src/fetch.ts`: only shallow commits the wants reach count (`walk.ts` `reachableAmong`).
- **Test.** `protocol/test/reach.test.ts`.

### 4.3 Raw, archive and the API read any stored commit by id (high, fixed)

- **Scenario.** A reader who knows an id (from an old page, a notification, a CI log) reads a commit a forced push removed, or one copied in from a fork, through `/raw/<sha>/...`, `/archive/<sha>.tar.gz` or the JSON API.
- **Fix.** `Repository.isReachable` (a ref's tip, what a tag peels to, or a commit some ref reaches) is required by the raw and archive routes and `readPath` (`repo/do/repo-do.ts`), and by the API wherever a caller's id becomes a commit (`repo/queries/session.ts` `resolveCommitId`, full and abbreviated).
- **Test.** `repository.test.ts` as above; `worker/test/reader.test.ts` "commits no ref reaches".

### 4.4 One repository handed another commits its own refs do not reach (high, fixed)

- **Scenario.** A comparison names a commit id in a fork; the fork's storage exported it even when nothing there reached it.
- **Fix.** `exportPack` answers only for wants its own branches and tags reach.
- **Test.** The fork test in `repository.test.ts`.

### 4.5 Raw files: types, disposition, isolation (medium, fixed; a decision is open)

- **Scenario.** A repository holds `page.html` or an SVG with script. Served from the site's origin, it must never run there.
- **Fix.** `transport/http/raw-headers.ts`: raster images inline; SVG and PDF as downloads; UTF-8 text as `text/plain`; the rest as `application/octet-stream` downloads; always `default-src 'none'; sandbox`, `nosniff`, `Cross-Origin-Resource-Policy: same-origin`, `private, no-store`; file names encoded so they cannot end or add a header.
- **Test.** `worker/src/transport/__tests__/transport.test.ts` "serves a repository's files so that none can run on this origin".
- **Open.** A separate origin (decision 1). Raw blobs are buffered and cannot exceed 32 MiB through the internal call; there are no range requests.

### 4.6 Medium and lower

- **Request bodies** (medium, fixed): an unknown or stacked `Content-Encoding` is a 415; a fetch's body is 32 MiB at most after inflating, streamed. `transport.test.ts`.
- **Lists a client could grow without bound** (medium, fixed): v2 arguments, v0 wants, shallow and deepen-not lines, `ref-prefix`, push options and commands on one stream are counted as they are read; a stateful negotiation has a budget as a whole. Worst over SSH, which has no request size. `reach.test.ts`.
- **A push could write outside branches and tags** (medium, fixed): only `refs/pull/` and `refs/infrawrench/` were refused, and nothing without a policy. Now `refs/heads/*` and `refs/tags/*` only, always. `repo/do/__tests__/policy.test.ts`, `repository.test.ts`.
- **Archives carried names that unpack outside their directory** (medium, fixed): `..`, `.git`, a separator inside a name, a link and then a directory of the same name. Left out now, with numeric fields clamped, a directory size bound and an entry cap. `repository.test.ts`.
- **Smart HTTP accepted the session cookie** (low, fixed): removed before authentication; tokens only. `transport.test.ts`.
- **A ref could be a file and a directory at once** (low, fixed), **the forge's own path could delete HEAD's branch** (low, fixed): `repository.test.ts`.
- **Stored `ref-delta` chains had no depth bound on read** (low, fixed, no test), **a `readObjects` batch could pass its byte budget** (low, fixed, no test; nothing calls it).

### Checked and holds

A missing and a private repository answer identically, for an anonymous caller and for a signed-in one who cannot read. `?token=` is taken on the archive route only, for its commit only. The internal call to the storage cannot be reached or forged from outside. A push's unpublished pack is invisible to other pushes and to fetches; a refused push leaves nothing. Connectivity accepts only objects in the pack or in this repository. Protected branches cover force push, deletion and creation, and bind tokens even of administrators. A want must be reachable from an advertised ref in every protocol version.

## 5. SSH and hostile bytes

### 5.1 A delta could make a push's storage object run out of memory (high, fixed)

- **Scenario.** Someone with push access sends a delta whose instructions are gigabytes of zeros (a few kilobytes compressed) and whose declared result is tiny. Only the result size was checked.
- **Fix.** `core/src/pack/indexer.ts`: the size limit applies to a delta's instructions before they are inflated and when they are read back.
- **Test.** `core/test/hostile.test.ts`.

### 5.2 Pushes were not held to git's object checks (high, fixed)

- **Scenario.** A tree with an entry named `.git` (or `.GIT`, `git~1`, the HFS+ spellings) or `..`, or a `.gitmodules` with a url that starts with `-`: cloning such a repository has run code on the cloner's machine in past git releases. Public forges refuse them on push; this one stored and served them.
- **Fix.** `core/src/object/fsck.ts` (`ObjectFsck`), called for every pushed pack in `worker/src/repo/do/ingest.ts`.
- **Test.** `hostile.test.ts`; `repository.test.ts` "refuses a push git's own checks refuse, and keeps nothing of it".

### 5.3 Medium and lower

- **No bound on the total work of one push** (medium, fixed): `maxInflatedBytes`, 8 GiB in the worker. `hostile.test.ts`, `repository.test.ts`.
- **A removed key kept working on an open connection** (medium, fixed): the key is looked up again before every command. `worker/src/transport/__tests__/ssh.test.ts`.
- **The failure limit could be walked around inside an IPv6 /64** (medium, fixed): counted per /64. `ssh.test.ts`.
- **The client's text could forge parts of the connection's log line** (low, fixed): quoted, escaped, cut at 80 characters.
- **The command parser** trimmed Unicode blanks and took a path that starts with `-` (low, fixed): about sixty cases in `ssh.test.ts`, among them traversal, `~`, control characters, percent-encoding, confusable and full-width letters, combining marks and direction overrides, all refused before any lookup.
- **Six failed attempts a connection**, as OpenSSH, where it was ten (low, fixed): `ssh/test/protocol.test.ts`.

### Open

- **The address behind Spectrum** (unknown): the limiter keys on `socket.opened.remoteAddress`. If that is Cloudflare's address and not the client's, twenty failures block SSH for a whole data centre. Log one connection in production before SSH opens.
- **No cap on connections per key or per address** (low): needs shared state.

### Checked and holds

Before authentication: packet length is bounded before the body is read, the version line and key exchange lists are bounded, the grace time is 30 seconds. Strict key exchange (Terrapin) is implemented. Signatures cover exactly what RFC 4252 says; `ssh-rsa` with SHA-1 is refused; the query phase never authenticates. AEAD tags are checked before anything is acted on. A deploy key reaches its one repository. `applyDelta` checks sizes before allocating and copies within bounds; delta chains are followed without recursion; the object parsers fail only with `GitError` and are linear.

## 6. Web UI

No way to run script was found: no HTML sink exists in `src/`, raw HTML in Markdown is never rendered (`react-markdown` without `rehype-raw`), and highlighter and ANSI output are React text. The page's policy (`script-src 'self'`, no inline script, `base-uri 'none'`, `frame-ancestors 'none'`) fits the built assets.

- **6.1 One comment could end the page for everyone who opened it** (medium, fixed): twenty thousand `>` overflowed the renderer's stack, a thousand-column table took half a minute. Limits on size, depth and table cells, and a fallback to plain text. `web/src/components/__tests__/markdown.test.tsx`.
- **6.2 Markdown images** (low, fixed; decision 4): `https:` and same-origin only, `no-referrer`, lazy.
- **6.3 Links** went to `href` through the library's defaults only (low, fixed): one helper, `lib/safe-url.ts`, for every URL from data, in Markdown and outside it (profile websites, homepages, status links, avatars, `returnTo`). `lib/__tests__/safe-url.test.ts`, `components/__tests__/untrusted-text.test.tsx`.
- **6.4 Direction overrides were shown raw** (low, fixed): a file named to read as another, code that reads in another order. Written out as `<U+202E>`. `untrusted-text.test.tsx`.
- **6.5 The ANSI parser left escape payloads in the output** (low, fixed): `lib/__tests__/ansi.test.ts`.
- **6.6 A new token's secret stayed in the query cache for five minutes** (low, fixed).
- **6.7 Label colours** reached `style` unchecked (low, fixed): six hex digits only.

## 7. Denial of service and cost

Every read of Git data runs in the repository's storage object: one thread, 128 MB, shared with its pushes, and reachable by anonymous callers when the repository is public. Time budgets do not fire there while code runs, so each bound below is a count. `ops/test/bounds.test.ts` and `worker/test/reader-bounds.test.ts` build the hostile input for each.

- **7.1 A text merge could run for minutes** (high, fixed): one file, the other with every second line moved to the end, 100 000 lines: 199 s in the line diff. Every view of a pull request runs a trial merge. The diff now falls back to Myers past a work bound: 0.64 s.
- **7.2 A directory of a million names took 536 MiB to parse** (high, fixed): trees over 1 MiB are refused where they would be parsed whole (a single name is still found); the parsed-tree cache is a quarter of its size.
- **7.3 A tree diff could read without limit while listing nothing** (medium, fixed): `maxDiffTrees`.
- **7.4 Rename detection** had no bound on what it read or compared (medium, fixed).
- **7.5 Merges** had no bound on text held, on criss-cross bases or on virtual merges (medium, fixed); a refused trial merge is now remembered, so a page view does not repeat it.
- **7.6 Commits with hundreds of thousands of parents** (medium, fixed): 1 024 at most; blame counts extra parents against its budget.
- **7.7 Commit messages of tens of megabytes** were listed whole (medium, fixed).
- **7.8 Diff pages and line counts** were bounded by lines only (medium, fixed): a page also stops by characters and by lines compared.
- **7.9 The file table's walk** followed every name of a directory (medium, fixed): only the names it lists, with an entry budget and a continuation.
- **7.10 Nothing limited how often** (medium, fixed in part): `http/admission.ts` counts callers without a credential by address (an IPv6 /64) against budgets for cheap reads, heavy reads and writes, and refuses an address after 60 refused credentials in ten minutes (`http/__tests__/admission.test.ts`, `rate-limit.test.ts`). **Open:** signed-in callers are not counted (it needs the principal: after authentication in the API middleware and the transports), and the counts are per data centre and best effort until the Rate Limiting bindings exist (section 9).
- **7.11 `isReachable` walks without a commit cap** (low, open): memoised per ref state and id, so the cost is one walk per distinct old id; covered by the heavy budget for anonymous callers.

## 8. Terraform (for the Terraform runtime, which was in flight)

The state route, the plan route and the state object did not exist yet, so 8.2 to 8.5 are requirements for them. None of the files involved was changed by this review.

- **8.1 The dispatcher must check the fork rule again** (high): 2.2 stops plan rows being queued for forks; whatever sends a run must still refuse one whose head repository is not the base, and send it untrusted.
- **8.2 State access at repository `write` is every member** (high, decision 2): the member role has `git:write` on every repository of the organisation. Reading state is reading the credentials Terraform created; writing it with a higher serial that lists a production resource makes the next apply destroy it; and it registers state as reconciliation input, which the app keeps from members on purpose (`iac:write`).
- **8.3 The state route must take tokens only, and must not trust the last path segment** (medium): build the principal from `Authorization` alone and refuse a session; return 404 unless the workspace name is valid and the rest of the path is exactly nothing, `lock` or `unlock` (`state/http.ts` `routeOf` takes the URL's last segment, so `.../state/x/lock` is served as `lock`); answer an anonymous caller 401, never 404, which Terraform reads as "no state".
- **8.4 Job tokens carry no workspace** (high as a gate for the route): a `write` job token is also a push token and is visible to the job's own code as `TF_HTTP_PASSWORD`. Add a workspace claim to client-core's `git-job-token.ts`, handled like the commit claim (refused everywhere that does not expect it), check it against a live run of that workspace, and give plans read and lock without write.
- **8.5 Never surface a `JSON.parse` message** (medium): V8 quotes the input (`Unexpected token 's', "{"a":s3cr3t..."`). Catch and answer a fixed text; `describeError` (3.2) does not know this shape.
- **8.6 Terraform's output in CI logs** (medium): plan and apply print attribute values not marked sensitive, and CI logs need `read`, which on a public repository is everyone. Print the summary lines only, or require `write` for a workspace run's log.
- **8.7 Root discovery queues without bound** (medium): `roots/discover.ts:316` pushes every subdirectory before checking `maxDirectories`; twelve shared trees of 2 000 entries queue ten million. Push only while `walked + queue.length < maxDirectories`.
- **8.8 Lower.** A 32 MiB plan parses to several hundred MB in the front Worker: parse in the workspace's object or cap at 16 MiB. Force-unlock clears only the Postgres mirror. `suggestWorkspaceName`'s regex is quadratic on a run of dashes (and the UI's copy in `backend-snippet.ts`). `describeReason` returns inherited properties (`constructor`). `withSerial` corrupts a serial written with an exponent. The cached Terraform binary is run without checking it came from the verified archive. The apply pipeline's `manual` trigger has no branch limit. A stored CI secret named `IW_GIT_JOB_TOKEN` could shadow the minted token.
- **8.9 For the app** (medium): `GET /iac/resource`'s "managed by" must only name repositories the viewer can read.

Checked and holds: body and lock size limits, serial and lineage checks, MD5 as a checksum only; state and plan readers never assign from input and are depth-bounded; the plan summary keeps no values (addresses with their `for_each` keys, types, actions and attribute names survive); the generated pipeline takes every workspace value through `env:` as a quoted scalar and refuses `${{`; approval needs repository `admin` and is scoped to the repository.

## 9. Deploy configuration (for whoever owns `wrangler.jsonc` and the workflows)

- **9.1 Archive tokens reach Workers Logs** (medium): `observability.enabled` records the request URL with its query, and the archive route's token rides there. Set `"observability": { "enabled": true, "redact_query_string": true }` (check the key against the installed wrangler's schema).
- **9.2 Version preview URLs are not pinned off** (low): add `"preview_urls": false` beside `"workers_dev": false`; a `*.workers.dev` URL is a second origin outside the `__Host-` cookie and the origin checks.
- **9.3 The job token key has two names** (low, fails closed): `infra/terraform/terraform.tfvars.example` and the header of client-core's `git-job-token.ts` say `JOB_TOKEN_KEY`; the Worker reads `GIT_JOB_TOKEN_KEY`.
- **9.4 Rate Limiting bindings** (for 7.10), optional in `Env`:

  ```jsonc
  "ratelimits": [
    { "name": "RL_READ_ANON", "namespace_id": "1101", "simple": { "limit": 300, "period": 60 } },
    { "name": "RL_HEAVY_ANON", "namespace_id": "1103", "simple": { "limit": 30, "period": 60 } },
    { "name": "RL_WRITE_ANON", "namespace_id": "1105", "simple": { "limit": 30, "period": 60 } }
  ]
  ```

- **9.5** `TERRAFORM_STATE` is typed as bound and is not; add it with its migration when the class lands. No workflow builds, tests or deploys these packages yet.

Checked and holds: no secret values in `wrangler.jsonc`, `vars` are origins and hostnames, `workers_dev` is off, the queue has a dead-letter queue; no secret has a fallback in code; the dependencies the packages declare are few, current and without install scripts (`react-markdown`, `remark-gfm`, `shiki`, `effect`, `drizzle-orm`).
