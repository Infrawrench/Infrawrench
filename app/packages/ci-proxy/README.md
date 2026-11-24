# ci-proxy

The one public front of the iwci runner pool (`ci-runner/`, `iwci serve`),
as a Cloudflare Worker. It authenticates callers, places each run on the
runner with the most job memory to spare per run (below), sends status and
log requests back to the runner that has the run, and fires `on.schedule`
pipelines of the repositories registered with it from a once-a-minute Cron
Trigger. The app drives it for repositories connected through the GitHub
App, and fires those repositories' schedules itself (below).

Runners stay stateless: reports, billing records and caches are in their
shared object store, so the proxy keeps nothing about a run. Its only state
is the schedule registry in D1, and where its sweep of expired downloads
has got to. It also serves jobs' downloads straight from the runners' R2
bucket (below).

## Routes

Every route but `/healthz`, `/v1/artifacts/...` and a cloud job's two
token routes needs `Authorization: Bearer <PROXY_KEY>`.

| Route                                                                     | Does                                                                               |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `GET /healthz`                                                            | `200 ok`, unauthenticated.                                                         |
| `GET`, `HEAD /v1/artifacts/{owner}/{repo-id}/{run}/{object}?n=&e=&s=`     | A job's download, for a link the app signed (below); no bearer key.                |
| `GET`, `PUT /v1/runners`                                                  | The runners runs go to (below).                                                    |
| `GET /v1/capacity`                                                        | Each runner's cores, slots, job memory, platforms, whether it answered; totals.    |
| `POST /v1/runs[?wait=true]`                                               | A run on the best placed runner (below). `429` only when every runner refuses.     |
| `GET /v1/runs/{id}`, `GET /v1/runs/{id}/logs`                             | From the runner that has the run. Logs stream through as Server-Sent Events.       |
| `POST /v1/runs/{id}/cancel`                                               | Cancels the run, or the pipelines the body names, on the runner that has it.       |
| `GET /v1/runs/{id}/jobs[/{job}]`                                          | A run's cloud jobs and their state, from the runner that has the run.              |
| `POST /v1/runs/{id}/jobs/{job}/claim`, `/log`, `/finish`                  | The executor's side of a cloud job (below), on the runner that has the run.        |
| `GET .../jobs/{job}/inputs?claim=`, `PUT .../jobs/{job}/artifacts?claim=` | A cloud job's artifacts, for its machine: the claim token, no bearer key (below).  |
| `POST /v1/concurrency`                                                    | A request's pipelines and their concurrency groups, from any runner; runs nothing. |
| `POST /v1/prepare`                                                        | Warms a runner for a request, placed like a run.                                   |
| `POST /v1/schedules/read`                                                 | A branch's `on.schedule` pipelines, from any runner; stores nothing (below).       |
| `GET /v1/storage/{owner}`, `/v1/usage/{owner}`                            | From any runner that answers; they all read the same store.                        |
| `DELETE /v1/storage/{owner}/{repo-id}`                                    | Clears one repository's caches (never its downloads), on any runner that answers.  |
| `PUT /v1/schedules`                                                       | Registers a repository's scheduled pipelines (below).                              |
| `GET /v1/schedules/{owner}`                                               | An owner's registered repositories, their crons and the last refresh's error.      |
| `DELETE /v1/schedules/{owner}/{repo-id}`                                  | Stops a repository's scheduled runs.                                               |
| `GET /v1/orgs/{owner}[/repos/{repo-id}]/secrets`                          | Secret names and when each was set; never values.                                  |
| `PUT`, `DELETE .../secrets/{name}`                                        | Sets (`{ "value": "..." }`) or removes a secret.                                   |
| `GET`, `PUT`, `DELETE .../vars[/{name}]`                                  | The same for variables, whose values are listed.                                   |

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

A run (or a prepare) goes to the runner where it is expected to finish
soonest: the first in this order that takes it, from each runner's
`/v1/capacity` at that moment (`byPlacement` in `src/pool.ts`). A run's
time is its CPU work over the cores it gets, so runners are ranked by the
cores a new run could expect to keep busy, `runCores`:

```
min(core share, memory share / 2 GiB)
```

The _core share_ is the runner's cores among the runs it would then have:

```
(cpus + idle) / 2 / (runs_active + 1)
```

where `idle` is `cpus` less the jobs running now (`slots_total -
slots_free`), floored at none. The _memory share_ is the same shape over
job memory, with a runner's _room_ being its budget less what running jobs
hold and what jobs ready to start ask for (`memory_total - memory_used -
memory_waiting`):

```
(memory_total + max(room, -memory_total)) / 2 / (runs_active + 1)
```

1. Runners that report a memory budget first, then any that do not.
2. The most `runCores`.
3. The most room, so when every runner is owed more than its budget the
   run goes where the smallest backlog waits.
4. Then the most free slots, the fewest active runs, and the name.

Memory holds a run's cores because a job cannot start until its `memory:`
is free: 2 GiB a core (`MEMORY_PER_CORE`) is what test jobs come to, at 4
to 6 GiB each for a little over two busy threads. So ci-1 (8 cores, 24
GiB) is short of cores and ci-2 (16 cores, 25.7 GiB) of memory, and an
idle ci-2 counts as 12.85 cores for a run against ci-1's 8. Ranking by
memory alone, as before, saw two nearly equal runners (24 and 25.7 GiB),
and under load could send a run to ci-1 while ci-2 had cores idle. A
runner that does not report `cpus` is ranked by its memory share alone.

`GET /v1/capacity` shows the result for each runner: `run_cores`, and
`expected_seconds`, which is a typical pull request's CPU work (2,400
core-seconds, `TYPICAL_RUN_WORK`) over it; `null` when a runner is owed
more than its whole budget. Every runner's estimate is the same work over
its cores, so the order does not depend on how large the run is, which the
proxy cannot see: a cold run (about 4,900 core-seconds) takes twice as
long everywhere.

Both shares average the whole of what the runner has, which is what runs
get over their life as the jobs running now finish, with what is free at
this moment, and divide it among the runs that would then share the host.
A run admitted a second ago has started no job, so only `runs_active`
shows it, and dividing by it is what spreads a burst: six runs placed at
once on two idle runners go four to ci-2 and two to ci-1.

Runs last tens of minutes and a runner's reservations swing between a
quarter and all of its budget in ten, so how many runs a runner has counts
as much as what is free at the instant of placing. Ranking any free memory ahead of
run counts sent every run of a burst to a runner with 2 GiB free and four
runs rather than one with none free and two (#1132). Job memory is the
only memory term: a runner's V8 heaps each count against their own job's
`memory:`, and nothing is shared between the heaps of different jobs since
every isolate has a cage of its own (#1158). A runner from before that
still reports `v8_heap_space_total` and `v8_heap_space_used`, which are
ignored. `v8_lost_isolates` and `v8_lost_heap` (isolates V8 abandoned after
running out of memory, and the most their heaps hold) are passed through
in `/v1/capacity` for whoever watches the pool; a runner restarts itself
before they cost it its memory reserve, and is draining meanwhile.

Draining and unreachable runners are left out, and a runner that answers
`429` is passed over for the next. Nothing about a runner is remembered
between placements, so one that comes back from draining is placed on at
once. Slots are a tiebreak only: a runner whose memory is reserved still
has nearly every slot free, so placing by slots sent run after run to it
while another runner sat idle, and a run cannot move once it has started
(#1089). A runner from before `memory_waiting` leaves it out and counts as
nothing waiting, which still ranks it by the memory its running jobs hold.

When every runner is short of memory the run is still placed rather than
refused for the app to retry. Refusing would let it go to whichever runner
frees up first, but the proxy cannot see what a run's jobs ask for, so it
would also hold back runs small enough to start at once, and a schedule's
fire that finds the pool full is skipped, not queued.

### Platforms

A job runs on `wasm` (an isolate, the default) or `linux` (a micro VM),
its `platform:`. Only a runner with KVM and the machine image runs
`linux`, and it lists what it runs in `/v1/capacity` as
`"platforms": ["wasm", "linux"]`; a runner
from before the field runs `wasm` only. `GET /v1/capacity` passes each
runner's list on.

The app reads which platforms a run's pipelines use from
`POST /v1/concurrency` and sends them with the run as `"platforms":
["linux"]` (sorted, without `wasm`; absent when every job runs on `wasm`).
A run or prepare that names some is placed, in the order above, only on
the runners that are up, not draining and list every one of them; when
no such runner is up, it is placed over every runner as usual, and the
runner fails just the jobs it has no machines for, saying so, while the
rest of the run goes on. Helpers are offered the run as before; which jobs
a helper may take is the runners' to decide. The field is the proxy's alone and is
taken out before any runner sees the request, since a runner refuses a
field it does not know. It is checked loosely, so a new platform needs no
change here: up to 8 names of up to 32 characters, or `400`. A schedule
registered with the proxy is placed the same way, by the `platforms` the
runner lists for each pipeline in `/v1/schedules/read` (none for a row
read before runners said).

## Split runs

A run can be shared between runners (the runner's README, "Split runs"):
the runner that has it lets another take jobs it cannot start yet. The
proxy's part is one extra request when it places a run (`placeRun` in
`src/app.ts`):

- The runner the run lands on gets `"split": { "runner": "<its name>" }`
  added to the request, when it says `"split": true` in `/v1/capacity` and
  at least one other runner that is up and not draining says so too. A
  runner that does not say it is never sent the field: it would refuse the
  request for a key it does not know.
- Every such other runner, up to three, is then sent the same request
  without its `secrets` and `lent`, and with `"split": { "of": "<the run's
id on its runner>", "runner": "<its name>" }`. A helper only runs jobs
  that are given no secret and lent nothing, and an offer sits on a runner
  for the whole of a run it may never be asked to help, so it is sent
  neither; the `token` stays, since a helper fetches the commit. That is
  an offer, not a run: the runner
  answers `202` and does nothing until the run asks for help through the
  store the runners share, and then takes only what its own runs leave
  free. The answer is not waited for (`waitUntil`) and not read; a helper
  that refuses, is down or is slow is one helper fewer.
- The proxy offers every time and decides nothing. It cannot see whether a
  pipeline says `split:`, how long the run's queue is or what a helper has
  free a minute later, and both runners can. A pipeline that does not say
  `split:` is not shared whatever is sent.
- Nothing is remembered. The caller hears of one run, on the runner that
  has it; status, logs and cancelling go there, and that runner ends its
  helpers itself. A helper's run has an id on its own runner that nobody
  is given.
- A run the caller waits for (`?wait=true`) is not shared, since its id is
  only known when it is over, and a caller's own `split` is dropped.
- Scheduled runs are shared the same way.

`GET /v1/capacity` passes on each runner's `split` and `runs_helping`.
What a runner does for other runners' runs is in none of the numbers
placement reads: it gives a helper job's slot and memory to its own run
the moment one wants them.

## Run notices

A run request may carry `"notify": { "url": "https://...", "token": "..." }`:
where the runner that has the run posts each change of its state (the
runner's README, "HTTP API"). The app sends it so it hears of a finished
run at once rather than on its next poll. The proxy takes it out of the
request (`takeNotify` in `src/app.ts`) and puts it back only for the runner
the run lands on, when that runner says `"notify": true` in
`/v1/capacity`; a runner from before notices would refuse the request for
it, and is followed by polling instead. A helper is never sent it, and
neither is a prepare or a concurrency read. Anything but an `https` URL of
up to 2048 characters and a token of 1 to 512 is a `400`; the runner
checks the URL further. `GET /v1/capacity` passes each runner's `notify`
on. The proxy keeps nothing about it and decides nothing.

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
  repository itself, not a fork; variables are given either way. The runner
  treats a pull request as untrusted unless told, so the proxy passes
  `"trusted": true` on for a vouched-for pull request and nothing otherwise.
- **Lent connections, keys and resources** (the request's `lent`,
  `ci-runner/README.md` "HTTP API") go to the runner only for a trusted run:
  the proxy drops them from an untrusted pull request, and from `POST
/v1/concurrency` and `POST /v1/prepare`, which run no job. The runner
  refuses them for an untrusted run as well.
- **Release the runners first.** A runner from before `trusted` and `lent`
  refuses a request with either (`400`, unknown field), so a proxy that
  sends them must not be deployed until every runner in the pool runs a
  release that has them.
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
2. matches every stored cron against the minute, in UTC (client-core's
   `ci-cron.ts` follows `iwci-spec/src/cron.rs`, and the tests share their
   cases);
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

### The app's schedules

Repositories connected through the GitHub App are never registered here.
Their clones need an installation token, which D1 must not hold, and their
runs need what only the app has: the plan check, the billing row, the GitHub
check and the CI tab. So the app keeps their schedules and fires them from
its `ci` poller pass (`server-core/src/ci/schedules.ts`), and the proxy only
answers `POST /v1/schedules/read` for it: the request (with the token) goes
to any runner, with stored variables added and secrets and `trusted` dropped
as for `POST /v1/concurrency`, and the answer comes back unstored. The app
then sends each due pipeline as an ordinary `POST /v1/runs` with `event:
schedule` and the pipeline's text, which the proxy treats as any other run
(secrets included, since it is not a pull request). Nothing fires a
repository twice as long as it is registered in one place only.

## Cloud jobs

A job with `cloud:` (`ci-runner/README.md`, "Cloud jobs") waits on the
runner that has its run until its executor, the app, claims it and drives
it with `claim`, `log` and `finish`. The proxy forwards those, with its key
checked and the runner key added, to the runner the run id names, and
rewrites the claim's `run` and its `inputs.url` and `artifacts.url` to the
proxy's run id (`<runner>.<id>`), so the app can give them to the job's
machine as they are.

The machine fetches the job's input artifacts with `GET
/v1/runs/{id}/jobs/{job}/inputs?claim=<token>` and uploads its own with
`PUT .../artifacts?claim=<token>`, tar archives, without the proxy key: the
claim's token (32 hex digits) is the credential, and the runner checks it
and stops honouring it when the job ends. Without a well-formed token those
paths are ordinary routes and need the key. Bodies stream through in both
directions; Cloudflare holds a request body to its plan's limit (100 MB on
most plans), so a job whose artifacts are larger than that cannot upload
them through the proxy.

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
