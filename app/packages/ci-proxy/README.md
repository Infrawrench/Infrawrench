# ci-proxy

The one public front of the iwci runner pool (`ci-runner/`, `iwci serve`),
as a Cloudflare Worker. It authenticates callers, places each run on the
runner with the most free slots, sends status and log requests back to the
runner that has the run, and fires `on.schedule` pipelines from a
once-a-minute Cron Trigger. It is not wired into the app yet.

Runners stay stateless: reports, billing records and caches are in their
shared object store, so the proxy keeps nothing about a run. Its only state
is the schedule registry in D1.

## Routes

Every route but `/healthz` needs `Authorization: Bearer <PROXY_KEY>`.

| Route                                            | Does                                                                           |
| ------------------------------------------------ | ------------------------------------------------------------------------------ |
| `GET /healthz`                                   | `200 ok`, unauthenticated.                                                     |
| `GET`, `PUT /v1/runners`                         | The runners runs go to (below).                                                |
| `GET /v1/capacity`                               | Each runner's slots and whether it answered, and the pool's totals.            |
| `POST /v1/runs[?wait=true]`                      | A run on the runner with the most free slots. `429` only when every runner is. |
| `GET /v1/runs/{id}`, `GET /v1/runs/{id}/logs`    | From the runner that has the run. Logs stream through as Server-Sent Events.   |
| `POST /v1/prepare`                               | Warms a runner for a request, placed like a run.                               |
| `GET /v1/storage/{owner}`, `/v1/usage/{owner}`   | From any runner that answers; they all read the same store.                    |
| `PUT /v1/schedules`                              | Registers a repository's scheduled pipelines (below).                          |
| `GET /v1/schedules/{owner}`                      | An owner's registered repositories, their crons and the last refresh's error.  |
| `DELETE /v1/schedules/{owner}/{repo-id}`         | Stops a repository's scheduled runs.                                           |
| `GET /v1/orgs/{owner}[/repos/{repo-id}]/secrets` | Secret names and when each was set; never values.                              |
| `PUT`, `DELETE .../secrets/{name}`               | Sets (`{ "value": "..." }`) or removes a secret.                               |
| `GET`, `PUT`, `DELETE .../vars[/{name}]`         | The same for variables, whose values are listed.                               |

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
# set RUNNERS in wrangler.jsonc to the runners' base URLs, then:
pnpm --filter @infrawrench/ci-proxy deploy
```

For local development, put `PROXY_KEY`, `RUNNER_KEY` and `SECRETS_KEY` in `.dev.vars`
(gitignored), apply the migrations with `--local`, and run
`wrangler dev --test-scheduled`; `GET /__scheduled?cron=*+*+*+*+*` then
fires a tick.

## Checks

`pnpm --filter @infrawrench/ci-proxy typecheck` and `... test`. The tests
drive the routes and the tick against fake runners and an in-memory store,
with no network.
