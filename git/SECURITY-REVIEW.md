# git.infrawrench.com: security review

November 2026, before the forge opens. The review covered `git/packages/*` as of `9994f9dcd` (the Terraform state route and its Durable Object had not landed, and there was no deploy workflow), read with one question: how does someone who should not get a private repository, a credential or another organisation's data get it anyway, and how does one anonymous request cost a lot.

Each finding has a severity, the scenario, what was changed and where it stands. `fixed` names the test that holds it. `open` names who it is for: the Terraform runtime and the deploy configuration were being written by others while this review ran, so their findings are recorded here and not changed.

Severity is about this forge: **high** is a private repository's content, a credential or cloud access reaching someone it should not; **medium** is a narrower leak, a write that should have been refused, or one request that takes a repository or a page down; **low** is hardening.

Tests under `git/packages/worker/src/__tests__/db/` need a Postgres and were written but not run during the review; each is marked "(database)". They were run, with the workerd suites (`GIT_WORKER_E2E=1`), when sections 8 and 9 were closed.

**Afterwards.** Sections 8 and 9, and the open half of 7.10, were closed once the Terraform runtime and the deploy configuration had landed. Each of those findings names the commit that closed it. What is still open is in the summary's last column.

## Summary

| Area                              | Critical | High | Medium | Low | Still open                                      |
| --------------------------------- | -------- | ---- | ------ | --- | ----------------------------------------------- |
| 1. Object ids (SHA-1)             |          | 1    |        |     |                                                 |
| 2. Access and visibility          |          | 3    | 5      | 4   |                                                 |
| 3. Tokens, sessions, headers, log |          |      | 2      | 6   | 1 low                                           |
| 4. Transports and storage         | 1        | 3    | 5      | 5   | large raw blobs                                 |
| 5. SSH and hostile bytes          |          | 2    | 3      | 3   | the address behind Spectrum; per-principal caps |
| 6. Web UI                         |          |      | 1      | 6   |                                                 |
| 7. Denial of service and cost     |          | 2    | 7      | 1   | 7.11 (low); Git over SSH is not counted         |
| 8. Terraform                      |          | 3    | 5      | 8   |                                                 |
| 9. Deploy configuration           |          |      | 1      | 2   |                                                 |

Sections 8 and 9 were open when the review ended and are closed now; the Terraform findings that could be fixed from outside the files then in flight are in section 2.

## Decisions wanted

1. **Raw files on their own origin.** Raw content is served from the site's origin behind `sandbox`, `nosniff` and a download disposition for anything that can script (4.5). That holds in current browsers, and it is the only thing that does. Forges serve raw content from a separate registrable domain so that a mistake there cannot reach the session. **Decided:** the same origin, sandboxed as it is. Moving it later needs a domain and a route; nothing else.
2. **Who may read and write Terraform state** (8.2). The design said repository `write`. Every member of an organisation has `git:write` on every repository, so that was every member reading every state and able to rewrite it. **Decided:** repository `admin` for people, a workspace-bound claim for job tokens (8.2, 8.4).
3. **Private pull requests between private repositories of one namespace** (2.1): allowed, although their collaborators can differ. **Decided:** as GitHub does it. The pull request stays allowed, and a fork within the same owner starts with its parent's collaborators, so the two lists differ only once someone changes one of them.
4. **An image proxy** (6.2): without one, the author of a comment or README learns the address of everyone who reads it. **Decided:** built (6.2).
5. **Rate Limiting bindings** (7.10). **Decided:** bound in `wrangler.jsonc` (9.4). The counts are per Cloudflare location and approximate, which is what the binding offers.

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
- **Decided (decision 3).** Two private repositories of one namespace can have different collaborators, and a pull request between them shows the head's commits to the base's readers. That stays, as on GitHub, where a fork within one organisation copies its parent's collaborators and team settings: `repositories.fork` copies the parent's collaborators, with their roles, when the fork stays with the same owner (`db/collaborators.ts` `copyCollaborators`). The lists then drift only when someone changes one of them, as GitHub's do. `src/__tests__/db/visibility.test.ts` "shows stars and forks only where the repository shows".

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

### 4.5 Raw files: types, disposition, isolation (medium, fixed)

- **Scenario.** A repository holds `page.html` or an SVG with script. Served from the site's origin, it must never run there.
- **Fix.** `transport/http/raw-headers.ts`: raster images inline; SVG and PDF as downloads; UTF-8 text as `text/plain`; the rest as `application/octet-stream` downloads; always `default-src 'none'; sandbox`, `nosniff`, `Cross-Origin-Resource-Policy: same-origin`, `private, no-store`; file names encoded so they cannot end or add a header.
- **Test.** `worker/src/transport/__tests__/transport.test.ts` "serves a repository's files so that none can run on this origin".
- **Decided.** The same origin (decision 1). **Open.** Raw blobs are buffered and cannot exceed 32 MiB through the internal call; there are no range requests.

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
- **6.2 Images from other sites told their host who was reading** (low, fixed; decision 4): a README, comment or avatar loaded straight from the address it named, so its author learned every reader's address. They now load through `/-/image?url=` (`worker/src/images/proxy.ts`): served only to an image on one of this site's pages (`Sec-Fetch-Site: same-origin`, `Sec-Fetch-Dest: image`), fetched with no cookie, referrer or browser string, only `http(s)` on a public address (each redirect checked again), only an image type, at most 10 MiB, and sent back with `sandbox` and `nosniff`. The page's policy is now `img-src 'self' data: blob:`, so an image the UI forgot to route there does not load rather than leak. Counted by address against the anonymous read budget. `worker/src/images/__tests__/proxy.test.ts`, `web/src/lib/__tests__/safe-url.test.ts`, `web/src/components/__tests__/markdown.test.tsx`.
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
- **7.10 Nothing limited how often** (medium, fixed; the second half in `8a0dd3bfc`): `http/admission.ts` counts callers without a credential by address (an IPv6 /64) against budgets for cheap reads, heavy reads and writes, and refuses an address after 60 refused credentials in ten minutes. A caller who authenticated is counted by who they are (`Admission.admit`: a person by id whichever credential they used, an API key, a deploy key, a CI run) against the signed-in budgets, by the API's authentication and by the Git routes (smart HTTP, raw, archive), each right after it resolves the principal and before it looks anything up. Heavy reads are a diff, a blame, a comparison, a filtered history, an archive, a raw file, a clone and a search. The counts live in Cloudflare's Rate Limiting bindings (9.4): per location and approximate. `http/__tests__/admission.test.ts`, `rate-limit.test.ts`, `bindings.test.ts`; `api/__tests__/handlers.test.ts` and `transport/__tests__/transport.test.ts` for where it is asked. **Open:** Git over SSH is not counted against these budgets (the per-principal cap of section 5).
- **7.11 `isReachable` walks without a commit cap** (low, open): memoised per ref state and id, so the cost is one walk per distinct old id; covered by the heavy budget for anonymous callers.

## 8. Terraform

The state route, the plan route and the state object did not exist when the review ran, so these were written as requirements for them. All are closed now; each names the commit that closed it. `d` below is `git/packages/worker/src/__tests__/db/terraform.test.ts` (database), `s` is `git/packages/worker/test/terraform-state.test.ts` (the real `terraform` against the routes) and `e` is `git/packages/worker/test/e2e/terraform.test.ts` (the same in workerd, with real job tokens).

### 8.1 The dispatcher must check the fork rule again (high, fixed in `729f63e7c`)

- **Scenario.** 2.2 stops plan rows being queued for forks. A row that got there some other way would still be sent, with the workspace's accounts and a token for its state.
- **Fix.** `server-core/src/ci/terraform.ts` `terraformDispatch` reads the pull request's head repository again before it mints anything (`terraformForkRefusal`): a head that is not the base repository, or a pull request that is gone, is refused and nothing is sent.
- **Test.** `server-core/src/ci/__tests__/terraform.test.ts` "asks the fork rule again when a run is sent"; `d`.

### 8.2 State access at repository `write` was every member (high, fixed in `9aad0fce6`; decision 2)

- **Scenario.** The member role has `git:write` on every repository of the organisation. Reading state is reading the credentials Terraform created; writing it with a higher serial that lists a production resource makes the next apply destroy it.
- **Fix.** `worker/src/terraform/access.ts` `decideStateAuth`: people need `admin` on the repository to read, lock or write a state. A personal access token works for an administrator (the directory asks `repoAccess` about the token and about the person behind it, `stateHolder`), needs `repo:write`, and never administers. Downloading a version through the API takes `admin` too (`contract/src/groups/automation.ts`); restore, force-unlock and delete already did. The UI offers the backend block and the download to administrators only.
- **Test.** `worker/src/terraform/__tests__/access.test.ts` (the whole table); `s`, `e`; `d` (the download).

### 8.3 The state route must take tokens only, and must not trust the last path segment (medium, fixed in `9aad0fce6`)

- **Fix.** `worker/src/terraform/route.ts` takes the cookie off before authentication, as smart HTTP does, so a session is a 401 there. The route comes from the router's own segments (`stateRouteOf`: nothing, `lock` or `unlock`; anything else is a 400, after the credential) and is handed to the handler, which no longer reads the URL. No valid credential is a 401 with a Basic challenge; a credential that may not, a missing repository and a missing workspace are the same 403; nothing is a 404 or 204 but a workspace that is truly empty.
- **Test.** `s` "answers 401 and 403, and never 404 or 204, to those who may not".

### 8.4 Job tokens carried no workspace (high, fixed in `34a266611`, `729f63e7c`, `9aad0fce6`)

- **Scenario.** A run's token was `write` on the whole repository and visible to the job's own code as `TF_HTTP_PASSWORD`: a job could push with it, and reach the state of every workspace of the repository while its run was live.
- **Fix.** client-core's `git-job-token.ts` has a `workspace` claim (`ws`), under the signature like the rest. A verifier that names a workspace takes only a token bound to it; one that names none refuses a bound token. Server-core mints a Terraform run's token with its workspace, `read` for a plan and `write` for an apply (`terraformTokenAccess`), and the app's own service token the same way. The Worker authenticates such a token on the Terraform routes only (`authenticateRequest` `workspaceTokens`), so it is a 401 on smart HTTP, the raw and archive routes and the API, and `repoAccess` gives such a principal nothing of the repository. On the state route it must name this workspace and its run must be live; a plan's reads and locks (`canLock`), an apply's writes too. A job token with no workspace is refused there.
- **Test.** `client-core/src/__tests__/git-job-token.test.ts`; `worker/src/auth/__tests__/credentials.test.ts` "refuses a Terraform run's token on every route but Terraform's"; `access.test.ts`; `e` "keeps a run's token to its state" and "gives a plan's token the lock and the state, and nothing to write"; `d`.

### 8.5 Never surface a `JSON.parse` message (medium, fixed in `10c191ada`)

- **Fix.** A plan that does not parse answers "The plan is not valid JSON."; a state, a lock and a `*.tf.json` root file likewise answer in fixed words (`worker/src/terraform/route.ts`, `terraform/src/state/document.ts`, `state/http.ts`, `roots/discover.ts`, the last of which used to pass the parser's message on).
- **Test.** `s` "takes a run's plan..." (a body with the fixture's secret in it); `terraform/test/roots.test.ts` "says a JSON file is not JSON without quoting what is in it".

### 8.6 Terraform's output in CI logs (medium, fixed in `9aad0fce6`)

- **Scenario.** Plan and apply print attribute values not marked sensitive, and a CI run is read with `read`, which on a public repository is everyone.
- **Fix.** `worker/src/api/handlers/automation.ts` `terraformOutputWithheld`: for a workspace's run, `ci.getRun` answers its jobs with empty output and `ci.runLog` is a 403 unless the caller has `write`. The run, its jobs and the plan's summary (which has no values) stay readable.
- **Test.** `d`.

### 8.7 Root discovery queued without bound (medium, fixed in `10c191ada`)

- **Fix.** `terraform/src/roots/discover.ts` pushes a directory only while `walked + queue.length < maxDirectories`.
- **Test.** `roots.test.ts` "stops at its limits and says it did": 2 000 names at every level, ten listings asked for.

### 8.8 Lower (fixed)

- **A 32 MiB plan parsed to several hundred MB in the front Worker**: 16 MiB at most (`MAX_PLAN_BYTES`). `9aad0fce6`, `s`.
- **`suggestWorkspaceName` was quadratic on a run of dashes**: trimmed by index on a bounded piece of the path; the UI's copy bounds its input. `10c191ada`, `roots.test.ts`.
- **`describeReason` returned inherited properties**: own keys only. `10c191ada`, `terraform/test/plan-summary.test.ts`.
- **`withSerial` corrupted a serial written with an exponent**: the whole number is replaced. `10c191ada`, `terraform/test/state-http.test.ts`.
- **The cached Terraform binary was run without checking it came from the verified archive**: the cache holds the archive, and every job unpacks the program from the checked archive into its own directory (`pipeline/generate.ts`). `10c191ada`. Not run on a runner here.
- **The apply pipeline's `manual` trigger had no branch limit**: the runner's `on.manual` takes no branch filter, so the limit is where the run is made. `terraformCiRun` refuses an apply that is not of the workspace's branch, and the forge records an apply by hand on that branch. `729f63e7c`, `9aad0fce6`, `server-core/src/ci/__tests__/terraform.test.ts`.
- **Force-unlock cleared only the Postgres mirror**: it goes to the workspace's object, and the mirror follows (`stateClient.forceUnlock`). Was so when the runtime landed; `e`.
- **A stored CI secret named `IW_GIT_JOB_TOKEN` could shadow the minted token**: it cannot. The proxy puts the secrets a request carries over stored ones (`ci-proxy/src/app.ts` `withStoredValues`). Checked, and held by a test now: `ci-proxy/src/__tests__/app.test.ts`, `729f63e7c`.

### 8.9 For the app: "managed by" named repositories the viewer could not read (medium, fixed in `729f63e7c`)

- **Fix.** `server-core/src/git-terraform/managed.ts` `managedByForResource` takes who is asking: a workspace of a private repository is named only to a caller with `git:read`, `git:write` or `git:admin` in the organisation, which `web/src/http/domains/iac/index.ts` reads from the principal. A caller that passes no viewer gets public repositories only. API `1.130.1`.
- **Test.** `web/src/http/domains/__tests__/iac-pr-checks.test.ts`; `d`.

Checked and holds: body and lock size limits, serial and lineage checks, MD5 as a checksum only; state and plan readers never assign from input and are depth-bounded; the plan summary keeps no values (addresses with their `for_each` keys, types, actions and attribute names survive); the generated pipeline takes every workspace value through `env:` as a quoted scalar and refuses `${{`; approval needs repository `admin` and is scoped to the repository.

## 9. Deploy configuration

All closed, in `8a0dd3bfc` unless another commit is named. `worker/src/http/__tests__/bindings.test.ts` reads `wrangler.jsonc` and holds 9.1, 9.2 and 9.4.

- **9.1 Archive tokens reached Workers Logs** (medium, fixed): `"observability": { "enabled": true, "redact_query_string": true }`. The key is in the installed wrangler's schema (4.162) and in Cloudflare's configuration reference; `wrangler deploy --dry-run` takes the file.
- **9.2 Version preview URLs were not pinned off** (low, fixed): `"preview_urls": false` beside `"workers_dev": false`.
- **9.3 The job token key had two names** (low, fixed in `34a266611`): the Worker's secret, the app's variable, the tfvars example, the deploy workflow and the notes all say `GIT_JOB_TOKEN_KEY`. The last place that said `JOB_TOKEN_KEY` was the header of client-core's `git-job-token.ts`.
- **9.4 Rate Limiting bindings** (for 7.10, fixed): six `ratelimits` bindings, cheap reads, heavy reads and writes for callers without a credential (`RL_*_ANON`, namespaces 1101, 1103, 1105) and for callers who authenticated (`RL_*_SIGNED_IN`, 1102, 1104, 1106), with the limits of `DEFAULT_RATE_BUDGETS`. A namespace id is a number the configuration chooses: nothing is provisioned, and `infra/git/setup.mjs` says so.
- **9.5** `TERRAFORM_STATE` is bound, with migration `v2` (it landed with the runtime); `.infrawrench/ci/git.yml` tests these packages and `.github/workflows/git-deploy.yml` deploys them. `worker/README.md` no longer says otherwise.

Checked and holds: no secret values in `wrangler.jsonc`, `vars` are origins and hostnames, `workers_dev` is off, the queue has a dead-letter queue; no secret has a fallback in code; the dependencies the packages declare are few, current and without install scripts (`react-markdown`, `remark-gfm`, `shiki`, `effect`, `drizzle-orm`).
