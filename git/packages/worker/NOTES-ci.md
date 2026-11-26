# Infrawrench CI and the Worker

What the Worker must do for repositories here to run Infrawrench CI. The app side is finished and tested (`app/packages/server-core/src/ci/`); this file is everything the Worker has to call and serve, so wiring it needs no reading of CI.

## The shape of it

- A run's repository is a GitHub installation's or one of ours. One of ours is a `ci_runs` row with `git_repository_id` set and `installation_id` 0 (`GIT_SOURCE_INSTALLATION_ID`, `ci/source.ts`). Nothing else about a run differs: the same dispatcher, concurrency groups, approvals, retries, cancels, billing and CI tab.
- **The runner fetches the commit from us over smart HTTP**, as it does from GitHub: one commit by id, shallow, with Basic auth as `x-access-token:<token>`. The token is a job token. This (and not a source archive) is what keeps `paths:` and `changed()` (a diff against `base`), `changes: fail`, `changes: commit` and a pull request's `refs/pull/<n>/head` working as on GitHub. The runner and the CI proxy needed no change: they never knew which host they were talking to.
- **The app writes commit statuses, we show them.** The poller (not the Worker) follows a run and writes `git_commit_statuses`.

## 1. The queue consumer calls `handleGitEvent`

```ts
import { handleGitEvent } from "@infrawrench/server-core/ci/git-events";
```

Call it once per branch a push moved, and once per pull request that got new code. It records the run and starts it (dispatch, or for a fork the "waiting for a maintainer" status); it returns `null` when the event starts nothing, and it never throws for a dispatch that did not go through (the `ci` poller pass retries those). An error it does throw (the database is away) should retry the message: the dedupe key makes a second delivery harmless.

It decides everything itself, so pass every event and do not filter first: tags, deleted branches, a person's own namespace (no organization), an organization without a paid plan, a repository with CI switched off and redeliveries all return `null`.

A push, one call per ref in `updates`:

```ts
await handleGitEvent({
  kind: "push",
  repository, // below
  ref: "refs/heads/main", // the full ref
  before: oldOid, // null or all zeros when the ref did not exist
  after: newOid, // null or all zeros when the ref was deleted
  forced: !isAncestor(oldOid, newOid), // a non-fast-forward
  created: oldOid === null, // optional: taken from `before` when left out
  deleted: newOid === null, // optional: taken from `after`
  pusher: actor.username ?? null, // null for a deploy key
});
```

`forced` matters: a forced push gets no `base`, so `paths:` filters let everything through rather than diff against a commit the new head does not descend from. Compute it honestly.

A pull request, when it is opened, reopened, or its head moves (`synchronize`); the consumer already synchronises pull requests after a push, so that is where the `synchronize` call belongs:

```ts
await handleGitEvent({
  kind: "pull_request",
  repository, // the BASE repository
  action: "opened" | "synchronize" | "reopened",
  number,
  head: {
    sha: headOid,
    ref: headBranch, // the branch's name, for display
    repository: headRepo ? { id: headRepo.id, fullName: "ns/name" } : null, // null: a deleted fork
  },
  base: { sha: baseBranchOid, ref: baseBranch },
  actor: username ?? null,
});
```

**Forks.** A pull request is a fork's when `head.repository.id` is not the base repository's id (compared by id, never by name) or is `null`. A fork's run waits for someone with `ci:approve` in the app and is never sent `trusted`, so it never gets secrets or anything lent. Never pass the base repository as the head's to "help" a fork run: that is the one way to hand a stranger the organization's secrets.

`repository`, everywhere:

```ts
{
  id, // git_repositories.id
  namespace, // the namespace's slug, as spelled
  name,
  defaultBranch,
  organizationId, // git_namespaces' owning organization, or null for a user's namespace
}
```

The runner's owner for a repository is `git.infrawrench.com-<namespace lowercased>` (the host comes from `GIT_BASE_URL`), which is what the runner itself derives from the clone URL. Caches, secrets, variables and usage are kept per owner, so a namespace never shares any with a GitHub account of the same name.

## 2. Smart HTTP takes a job token

The format has one definition, which both sides import:

```ts
import { isGitJobToken, verifyGitJobToken } from "@infrawrench/client-core";

const checked = await verifyGitJobToken(env.GIT_JOB_TOKEN_KEY, token, {
  repositoryId: repo.id,
  access: "read", // "write" for receive-pack
});
if (!checked.ok) return unauthorized(); // checked.reason: malformed | signature | expired | repository | access
```

- `GIT_JOB_TOKEN_KEY` is a secret of both the Worker and the app, with the same value, at least 32 characters.
- A token is `iwj_<payload>.<signature>`, HMAC-SHA256, and names one repository **by id**, `read` or `write`, what it was minted for (a run's id, or `schedules` / `manual` / `env-file`) and an expiry at most an hour off. Nothing is stored; there is nothing to revoke.
- In the credential resolver: a Basic password (any user name; the runner sends `x-access-token`) or a Bearer token starting `iwj_` is a job token. Resolve the repository from the URL **first**, then verify against its id, and map the result to `repoAccess` of `read` (or `write`) for that repository and nothing else. A job token is never a user: no API access, no other repository.
- The app mints `read` tokens for everything CI itself does, and one `write` token: a Terraform workspace's run gets it as the run secret `IW_GIT_JOB_TOKEN`, for the state backend (`terraform/access.ts`). Refuse a push on `git-receive-pack` unless the claim says `write`.
- Never log a token, and keep it out of error messages.

What the runner's fetch needs from `git-upload-pack` (it uses gitoxide, protocol v2):

- `ls-refs` with `ref-prefix`, and `fetch` with `want <oid>` for **any commit reachable from a ref**, not only advertised tips: the runner asks for the run's commit by id, and a branch may have moved on since the push.
- `shallow` / `deepen`: the fetch is shallow, deepened when the commit is not within reach of the ref's tip, and unshallowed (`deepen` to the root) for a pipeline that asks for full history.
- `refs/pull/<n>/head` must exist and point at each open pull request's head, a fork's included, in the **base** repository. The runner is sent `ref: refs/pull/<n>/head` as the hint that makes the commit reachable, and a fork's commits are only reachable there.
- The run's `base` (the commit a push moved the branch from, or a pull request's base branch head) is fetched the same way, by id at depth 1, for `paths:` and `changed()`. It is always reachable from a branch: a forced push is sent without a `base`.
- Its local refs as `have`s: the runner keeps one object cache per clone URL, so later fetches should get thin answers.

The app also asks one thing over smart HTTP itself: a branch's head, for a run started by hand. It is a plain protocol v2 `ls-refs` (`POST /<owner>/<repo>.git/git-upload-pack`, `Git-Protocol: version=2`, `ref-prefix refs/heads/<branch>`) with a job token, which needs nothing beyond the above. It is sent without a preceding `info/refs` request, as stateless HTTP allows.

## 3. Two small routes for the app

Both take a `read` job token for that repository.

| Route                                      | Auth                                                  | Answers                                                                                                                                                                                         |
| ------------------------------------------ | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /<owner>/<repo>/raw/<sha>/<path>`     | `Authorization: Bearer <job token>`                   | The file's bytes at that commit; `404` when the commit has no such file. Used for `env-file:` (a `.infraenv` read at the run's commit).                                                         |
| `GET /<owner>/<repo>/archive/<sha>.tar.gz` | `Authorization: Bearer …` **or** `?token=<job token>` | The commit as a gzipped tar with **one top-level directory** (as GitHub's archives have; the machine extracts with `--strip-components=1`). Used by cloud jobs, which run on someone's machine. |

The archive needs the query form because the app answers a cloud job's machine with a redirect to this URL, and the machine follows it sending no header of its own. A link is seen by more than a header is, so that token is minted for ten minutes and **bound to the commit** (a `commit` claim): `verifyGitJobToken` passes it only when the caller says which commit it is serving, and refuses it everywhere else. So on this route, and only on this route, verify with the commit from the URL:

```ts
await verifyGitJobToken(env.GIT_JOB_TOKEN_KEY, token, {
  repositoryId: repo.id,
  access: "read",
  commit: sha,
});
```

Smart HTTP and the raw route verify without `commit`, as in section 2, which is what makes a token lifted from an archive link useless for a clone. Take `?token=` on the archive route alone. Keep the query string out of request logs (log the path only), and answer `Cache-Control: private, no-store`.

`<sha>` is always a full 40-character commit id on both routes. The existing raw and archive routes for people can serve these if they accept the job token.

## 4. Commit statuses

The app publishes; the Worker only reads `git_commit_statuses` to draw them and to gate a merge. `server-core/src/ci/status.ts` `writeGitCommitStatus` is the writer: an upsert on (repository, sha, context).

What gets written, upserted on (repository, sha, context):

| Context                                                  | When                                                                                                                         |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `Infrawrench CI / push`, `Infrawrench CI / pull request` | The run: pending while queued or running, then how it ended. Also `Infrawrench CI / schedule` and `Infrawrench CI / manual`. |
| `<pipeline> / <job> (push)`, `… (pull request)`          | One per job key, as it starts and finishes.                                                                                  |

`state`: `pending` (not finished, and a fork waiting for approval), `success` (passed, and "nothing to run" on a pull request, so a required status never blocks a pull request whose `paths:` leave every pipeline out), `failure` (a job failed), `error` (cancelled, lost, could not start, rejected). `description` is one line of at most 140 characters; `target_url` is the run's page in the app (`${APP_URL}/org/<org>/ci/<run>`), or null on a server without `APP_URL`.

For protected branches: require `Infrawrench CI / pull request`. It covers every job, whichever jobs a change adds or removes. A push that no pipeline runs on writes no status at all.

## 5. Settings the forge's UI owns

The app's CI tab lists and shows these runs, their schedules and their manual pipelines. What is per repository or per namespace lives in the forge's settings and calls server-core:

```ts
import {
  ciGitRepository,
  ciGitRepositoriesOf,
  setCiGitRepository,
} from "@infrawrench/server-core/ci/git-repositories";
import { deleteCiValue, listCiValues, setCiValue } from "@infrawrench/server-core/ci/values";
```

- **The CI switch.** `setCiGitRepository(repository, enabled, userId)` with the same `repository` as above (its `organizationId` not null). `ciGitRepository(orgId, repoId)` reads it; no row means on. Gate it on `git:admin` (or the repository's `admin`).
- **Secrets and variables** are per namespace and per repository: `listCiValues(orgId, { gitNamespace }, repoNameOrNull)`, `setCiValue(orgId, { gitNamespace }, repo, "secrets" | "variables", name, value)`, `deleteCiValue(…)`. Secret values are write-only. The namespace must be one the organization has a repository in that CI has heard of (a push, or a use of the switch), or the call answers 404.

## 6. Left for integration

- Done: the foreign keys (`ci_runs`, `ci_schedules` and `ci_git_repositories` name `git_repositories.id` with `on delete cascade`, migration `0199_git_forge_links`), the status writer, the queue consumer's calls (section 1) and the CI tab's reads.
- **Smart HTTP and the two routes of section 3** are the storage's: `src/http/router.ts` has their insertion points.
- **The CI switch of section 5** is `ci.settings` and `ci.updateSettings` (`GET` and `PUT /api/repos/:owner/:repo/ci/settings`, `admin` on the repository), which the repository's Settings > CI page uses. **Secrets and variables** have no endpoints here: that page links to the app, where they are edited.
- **Renames and transfers.** `ci_git_repositories` follows the repository's id and takes its names from each event, so it corrects itself on the next push. `ci_schedules` is keyed by name: after a rename the old row stops being readable and is dropped within a day, and the new name's row appears with the next push. Call `noteRepository` from `ci/schedules` on rename if that day matters.
- **CI prices on the subscription.** Ticking **Run CI** for a GitHub account calls web's `ensureCiPrices`, which adds the metered CI prices to a subscription that predates them. Nothing does that for an organization whose only CI is here, so its usage is recorded but an old subscription has no item to bill it to. Move `ensureCiPrices` where the forge can reach it, or call it when the namespace is claimed.
- **Lending to a repository by name.** A list of repositories something is lent to names ours as `git.infrawrench.com/<namespace>/<name>`; a plain `owner/name` means GitHub's. The app's pickers only offer GitHub repositories so far, so until they list ours a connection is lent to a repository here by "every repository".
- **`github-token:`** in a pipeline is refused for a repository here, by name, in the job's log. A job that pushes back needs a `write` job token lent the same way; the format has room for it and nothing mints one yet.
- **Caches in the app's CI tab** list GitHub accounts only; a namespace's caches are stored and billed, but not listed or clearable from the app yet.
