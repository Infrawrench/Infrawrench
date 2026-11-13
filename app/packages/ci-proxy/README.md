# ci-proxy

The one public front of the iwci runner pool (`ci-runner/`, `iwci serve`),
as a Cloudflare Worker. It authenticates callers, places each run on the
runner with the most job memory to spare per run (below), sends status and
log requests back to the
runner that has the run, and fires `on.schedule` pipelines from a
once-a-minute Cron Trigger. It is not wired into the app yet.

Runners stay stateless: reports, billing records and caches are in their
shared object store, so the proxy keeps nothing about a run. Its only state
is the schedule registry in D1, and where its sweep of expired downloads
has got to. It also serves jobs' downloads straight from the runners' R2
bucket (below).

## Routes

Every route but `/healthz` and `/v1/artifacts/...` needs
`Authorization: Bearer <PROXY_KEY>`.

| Route                                                                 | Does                                                                               |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `GET /healthz`                                                        | `200 ok`, unauthenticated.                                                         |
| `GET`, `HEAD /v1/artifacts/{owner}/{repo-id}/{run}/{object}?n=&e=&s=` | A job's download, for a link the app signed (below); no bearer key.                |
| `GET`, `PUT /v1/runners`                                              | The runners runs go to (below).                                                    |
| `GET /v1/capacity`                                                    | Each runner's slots, job memory and whether it answered, and the pool's totals.    |
| `POST /v1/runs[?wait=true]`                                           | A run on the best placed runner (below). `429` only when every runner refuses.     |
| `GET /v1/runs/{id}`, `GET /v1/runs/{id}/logs`                         | From the runner that has the run. Logs stream through as Server-Sent Events.       |
| `POST /v1/runs/{id}/cancel`                                           | Cancels the run, or the pipelines the body names, on the runner that has it.       |
| `POST /v1/concurrency`                                                | A request's pipelines and their concurrency groups, from any runner; runs nothing. |
| `POST /v1/prepare`                                                    | Warms a runner for a request, placed like a run.                                   |
| `GET /v1/storage/{owner}`, `/v1/usage/{owner}`                        | From any runner that answers; they all read the same store.                        |
| `DELETE /v1/storage/{owner}/{repo-id}`                                | Clears one repository's caches (never its downloads), on any runner that answers.  |
| `PUT /v1/schedules`                                                   | Registers a repository's scheduled pipelines (below).                              |
| `GET /v1/schedules/{owner}`                                           | An owner's registered repositories, their crons and the last refresh's error.      |
| `DELETE /v1/schedules/{owner}/{repo-id}`                              | Stops a repository's scheduled runs.                                               |
| `GET /v1/orgs/{owner}[/repos/{repo-id}]/secrets`                      | Secret names and when each was set; never values.                                  |
| `PUT`, `DELETE .../secrets/{name}`                                    | Sets (`{ "value": "..." }`) or removes a secret.                                   |
| `GET`, `PUT`, `DELETE .../vars[/{name}]`                              | The same for variables, whose values are listed.                                   |

Request bodies are the runner's (`ci-runner/README.md`, "HTTP API"). A run id
is the runner's id prefixed with the runner's name (`ci-1.<32 hex>`), which
is how a status request finds its runner without a table.

## Runners

The runners come from the `runners` table, which `PUT /v1/runners` replaces
whole (`{ "runners": [{ "name": "ci-1", "url": "https://..." }] }`, up to 64).
The Terraform that provisions runner hosts (`infra/ci-runners`) calls it
after every change to the host list. While the table is empty, the
`RUNNERS` variable is used instead: `name=url` entries, or plain URLs named
by their position. `GET /v1/capacity` shows each runner's name, version and
whether it is draining; a draining runner (stopping, or about to update
itself) is never given a run, and its free slots do not count.

## Placement

A run (or a prepare) goes to the first runner in this order that takes it,
from each runner's `/v1/capacity` at that moment (`byPlacement` in
`src/pool.ts`). A runner's _room_ is its job memory budget less what
running jobs hold and what jobs ready to start ask for:
`memory_total - memory_used - memory_waiting`.

1. Runners with room first, then any that report no memory budget, then
   those with none (their admitted work already wants all of it).
2. Among runners with room, the most room per run, counting the new one:
   `room / (runs_active + 1)`. Among those without, the smallest backlog.
3. Then the most free slots, the fewest active runs, and the name.

Draining and unreachable runners are left out, and a runner that answers
`429` is passed over for the next. Slots are a tiebreak only: a runner
whose memory is reserved still has nearly every slot free, so placing by
slots sent run after run to it while another runner sat idle, and a run
cannot move once it has started (#1089). A runner from before
`memory_waiting` leaves it out and counts as nothing waiting, which still
ranks it by the memory its running jobs hold.

When every runner is short of memory the run is still placed, on the one
with the smallest backlog, rather than refused for the app to retry.
Refusing would let it go to whichever runner frees up first, but the proxy
cannot see what a run's jobs ask for, so it would also hold back runs small
enough to start at once, and a schedule's fire that finds the pool full is
skipped, not queued.

## Secrets and variables

Set per organisation (`/v1/orgs/{owner}/...`) or per repository
(`/v1/orgs/{owner}/repos/{repo-id}/...`), with `owner` and `repo-id` as the
runner works them out (`github.com-acme` and `web` for
`https://github.com/acme/web`; `src/identity.ts` follows the runner). Names
are letters, digits and `_`, values up to 48 KiB, 100 of each kind per
organisation or repository.

On `POST /v1/runs` and on every scheduled run, the proxy adds the
organisation's variables and secrets, overridden by the repository's, and
overridden in turn by any `vars`/`secrets` the request itself carries.
Pipelines read them as `${{ vars.<name> }}` and, in `env:` only,
`${{ secrets.<name> }}`, and the runner masks secret values in everything a
job prints or reports (`ci-runner/README.md`, "Secrets and variables").

- **Pull requests get no secrets** unless the request says
  `"trusted": true`, meaning the caller has checked that the branch is in the
  repository itself, not a fork; variables are given either way. The flag is
  the proxy's and is not passed to the runner.
- **Secrets are sealed** in D1 with AES-GCM under the Worker secret
  `SECRETS_KEY` (32 random bytes, base64), with the kind, owner, repository
  and name as associated data, so a row copied to another name or repository
  does not open. Without `SECRETS_KEY` secrets cannot be stored. A secret
  that will not open (the key was changed) stops the run with a `500` naming
  it, rather than starting the run with an empty value.
- Variables are stored as written and are not secret.

## Schedules

`PUT /v1/schedules` takes `repo` and optionally `owner`, `repo-id`,
`default-branch` and `storage-quota`, the same fields as a run. A `token` is
refused: nothing that stays in D1 should be a credential, so scheduled runs
of private repositories use the runners' `IWCI_GIT_TOKEN`.

The proxy asks a runner for the default branch's pipelines with
`on.schedule` (`POST /v1/schedules/read`) and stores their crons and text.
Every minute it:

1. re-reads up to 20 registrations last read more than ten minutes ago,
   keeping the old pipelines if the read fails, so a runner outage does not
   stop schedules;
2. matches every stored cron against the minute, in UTC (`src/cron.ts`
   follows `iwci-spec/src/cron.rs`, and the tests share their cases);
3. claims each due pipeline for that minute in `schedule_fires`, whose
   primary key is what stops a repeated trigger firing it twice;
4. sends it as a run with `event: schedule` and the stored text as
   `pipeline`, so exactly the file that was read runs.

A minute in which every runner is full is recorded as `no-capacity` and not
retried; the next due minute fires normally.

A pipeline with `concurrency:` (`ci-runner/README.md`, "Concurrency") keeps
its group among the proxy's own scheduled runs of the repository: of the
group's pipelines due in one minute only the last in file order fires, and
a scheduled run of the group still going from the last six hours is
cancelled when the pipeline says `cancel-in-progress: true`, or else the new
fire is skipped and recorded as `concurrency: waiting for ...`, for the same
reason a full pool's is not queued. Runs the app starts (pushes, pull
requests, retries) keep their groups in the app, which sees all of them; the
two do not wait for each other. On `POST /v1/concurrency` the proxy adds the
stored variables, never secrets, since a group may read `vars`.

## Downloads

A job's `downloads:` (`ci-runner/README.md`, "Downloads") are objects in the
runners' bucket, `artifacts/<owner>/<repo-id>/<run>/<expires>-<id>`, bound
to this Worker as `ARTIFACTS`. The proxy serves them to browsers and deletes
them once they expire; nothing about them passes through a runner or the
app's servers, and nothing in the bucket is public.

- **Links.** The app (`server-core/src/ci/downloads.ts`), after checking
  that the person may read the run, signs a link with HMAC-SHA-256 under the
  Worker secret `ARTIFACT_SIGNING_KEY` (its own `CI_ARTIFACT_SIGNING_KEY`,
  the same value) over the owner, repository, run, object, file name (`n`)
  and expiry (`e`). The proxy answers `403` for a signature that does not
  match, which is what a link moved to another owner, repository, run or
  file, a changed name or a later expiry all are; `410` once the link or the
  file has expired; and `403` for a link signed for more than a day. The app
  signs for 15 minutes. `src/__tests__/artifacts.test.ts` and server-core's
  `downloads.test.ts` check the same vector.
- **Serving.** The object streams from R2 with its content type,
  `Content-Disposition: attachment` (with the file's name),
  `X-Content-Type-Options: nosniff`, a `sandbox` CSP and `no-store`. One
  `bytes=` range is answered with `206`; several are served whole. `HEAD`
  answers the headers only.
- **Sweeping.** Each Cron Trigger also lists up to three pages (3,000 keys)
  of `artifacts/` from where the last tick stopped (the cursor is in D1,
  `download_sweep`) and deletes the keys whose expiry has passed, which it
  reads from the key itself. After a pass reaches the end it rests an hour.
  A sweep that fails is logged and never holds up the schedules. The proxy
  does this, rather than the runners, for the same reason it fires
  schedules: a Cron Trigger runs once for the whole pool.
- Without `ARTIFACTS` or `ARTIFACT_SIGNING_KEY`, download routes answer
  `503` and nothing is swept; runs still keep their downloads.

## Billing

The runners write a usage record per run to the store
(`usage/<owner>/<yyyy>/<mm>/...`), scheduled runs included, and
`GET /v1/usage/{owner}` sums a month. The proxy adds nothing to billing and
loses nothing if it restarts.

## Setup

```sh
pnpm --filter @infrawrench/ci-proxy exec wrangler d1 create infrawrench-ci-proxy
# put the database id in wrangler.jsonc, then:
pnpm --filter @infrawrench/ci-proxy exec wrangler d1 migrations apply infrawrench-ci-proxy --remote   # every file in migrations/
pnpm --filter @infrawrench/ci-proxy exec wrangler secret put PROXY_KEY
pnpm --filter @infrawrench/ci-proxy exec wrangler secret put RUNNER_KEY   # the runners' IWCI_SERVER_KEY
head -c 32 /dev/urandom | base64 | pnpm --filter @infrawrench/ci-proxy exec wrangler secret put SECRETS_KEY
# downloads: the same value goes in the app's CI_ARTIFACT_SIGNING_KEY
head -c 32 /dev/urandom | base64 | tee /dev/stderr | pnpm --filter @infrawrench/ci-proxy exec wrangler secret put ARTIFACT_SIGNING_KEY
# `r2_buckets` in wrangler.jsonc binds ARTIFACTS to the runners' bucket
# (IWCI_R2_BUCKET, infrawrench-ci-runners); it must exist in the same account
# set RUNNERS in wrangler.jsonc to the runners' base URLs, then:
pnpm --filter @infrawrench/ci-proxy deploy
```

For local development, put `PROXY_KEY`, `RUNNER_KEY`, `SECRETS_KEY` and
`ARTIFACT_SIGNING_KEY` in `.dev.vars`
(gitignored), apply the migrations with `--local`, and run
`wrangler dev --test-scheduled`; `GET /__scheduled?cron=*+*+*+*+*` then
fires a tick.

## Checks

`pnpm --filter @infrawrench/ci-proxy typecheck` and `... test`. The tests
drive the routes, the tick and the sweep against fake runners, an in-memory
store and an in-memory bucket, with no network.
