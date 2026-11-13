# ci-runner

A CI runner that runs every job in a WebAssembly isolate. On each commit it
clones the repository once, installs its dependencies once, freezes the
result in memory, and then starts each job in its own [Wasmer] instance over
a copy-on-write view of that snapshot. A job starts in the time it takes to
instantiate a module that is already compiled: there is no container to
pull, no clone per job and no `pnpm install` per job.

The app reaches it through the proxy (`app/packages/ci-proxy`): the GitHub
App's push and pull request webhooks become runs (`server-core/src/ci/`),
shown on the **CI** tab of the web and desktop apps. It is a standalone Rust
workspace, outside the pnpm workspace and `turbo.json`, with its own CI
(`.github/workflows/ci-runner.yml`).

[Wasmer]: https://wasmer.io

## How a run works

1. **Plan.** Read every `.infrawrench/ci/*.yml` at the commit, parse and
   validate it (`iwci-spec`), expand matrices, substitute `${{ }}`
   expressions, and drop pipelines whose `on:` does not match. A job whose
   matrix or fields read another job's outputs stays a template until that
   job finishes.
2. **Clone** (`iwci-git`). Fetch just the commit, shallow, into a persistent
   bare repository per remote, then write its tree straight from the object
   database into an in-memory file system. A commit already in the cache
   costs no network at all.
3. **Install** (`iwci-deps`). Read the lockfiles from the snapshot and fetch
   exactly what they pin, verified against the lockfile's hashes and cached
   by content: pnpm (laid out like pnpm's isolated `node_modules`), Go
   modules (a `GOMODCACHE`), Cargo crates (a `vendor/` directory), Python
   wheels (the interpreter's user site) and Composer packages (`vendor/`
   and its autoloader). No package manager runs and no install script
   executes. Both its results are cached: see [Caching](#caching).
4. **Resolve tools** (`iwci-store`). Each `using:` resolves to a manifest
   and content-addressed blobs in R2, verified by sha256.
5. **Run** (`iwci-runtime`). Jobs run in parallel as soon as their `needs`
   finish and their `paths:` and `if:` allow it, each in a fresh Wasmer instance with no host file system and
   a private loopback plus the public internet for a network (see [Networking](#networking)), under a timeout and a memory limit. Compiled modules are cached
   on disk, so a tool is compiled once per runner, not once per job. When
   more jobs are ready than may run, the one with the longest chain of
   work still ahead of it starts first (see [Job order](#job-order)).
6. **Changes.** What a job wrote is read back from its overlay layer.
   `changes: fail` fails the job if it changed anything; `changes: commit`
   turns the changes into a commit on top of the run's commit (written to
   the git cache; pushing it is left to the integration).

Workspaces are deduplicated and built on first use: jobs whose clone and
dependency settings are the same share one snapshot, so a 10-entry matrix
installs once, and a workspace only skipped jobs would use is never built.

## The pipeline file

```yaml
name: Tests

on:
  push:
    branches: [main]
  pull-request: {}

workspace:
  clone:
    depth: 1
    into: /app
  deps:
    - pnpm

jobs:
  typescript:
    name: TypeScript (${{ matrix }})
    matrix: [web, mobile]
    using: builtin:typescript@7.1
    cwd: /app/app/packages/${{ matrix }}
    args: [--noEmit]

  format:
    using: builtin:oxfmt@0.69
    args: [--write, .]
    deps: false
    changes:
      commit: "style: format"

  lint:
    using: env:bash-node@24
    run: pnpm run lint
    needs: [typescript]
```

`examples/tests.yml` is a longer one, and `schema/ci.schema.json` is the
JSON Schema for editors (`# yaml-language-server: $schema=...`).

### Top level

| Key           | Meaning                                                                                                                                        |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | Required.                                                                                                                                      |
| `on`          | `push` and/or `pull-request`, each with optional `branches` and `paths` globs, and `schedule` (below). Omitted: every push.                    |
| `workspace`   | `clone` and `deps` shared by every job unless it overrides them, and `services` every job starts with.                                         |
| `scratch`     | The most the run's shared `/tmp/workflow` may hold, such as `2GiB`. Default `1GiB`, between `16MiB` and `16GiB`.                               |
| `concurrency` | A group name, or `{ group, cancel-in-progress }`: at most one run of the repository per group is in progress. See [Concurrency](#concurrency). |
| `jobs`        | Map of job key (lowercase, digits, `-`, `_`) to job.                                                                                           |

`on.schedule` is a list of up to 16 `- cron: "0 3 * * *"` entries, always
in UTC: five fields (minute, hour, day of month, month, day of week) taking
`*`, numbers, ranges, steps and lists, month and weekday names, Sunday as 0
or 7, and `@hourly`, `@daily`, `@weekly`, `@monthly` and `@yearly`. When both
day fields are restricted, a day matching either runs, as in classic cron. A
scheduled run checks out the default branch's head, its event is
`schedule`, and it reads and writes the same caches as a push to that
branch. Runners do not keep time: something outside them has to fire the
schedule, which in this repository is the proxy Worker (see
[Scheduled runs](#scheduled-runs)).

`workspace.clone`: `depth` (`1` by default, more commits, or `full`), `into`
(default `/app`), `submodules` (default `false`).

`workspace.deps`: a list of `pnpm`, `go`, `cargo`, `pip` or `composer`, or
`- go: { dir: tools }` to read a lockfile below the root. pnpm also takes
`only: [app/packages/web]` to install just those importers' closure, and pip
`file: requirements/ci.txt` to read another lock than `pylock.toml` or
`requirements.txt`. [Python](#python) and [PHP](#php) say what the pip and
Composer installers check.

### Filters

`branches` and `paths` (under `on.push`, `on.pull-request`, and on a job)
are globs: `*` stops at `/`, `**` crosses it. A pattern starting with `!`
excludes. Patterns are read in order and the last one that matches
decides, so a later pattern can include again; a list that starts with an
exclusion begins from everything. A run or job goes ahead when any changed
path gets through.

```yaml
on:
  push:
    branches: ["**", "!dependabot/**"] # every branch but Dependabot's
    paths: [app/**, "!app/docs/**", app/docs/openapi.json]
jobs:
  test:
    paths: ["!**/*.md"] # anything but Markdown
```

Quote exclusions: YAML reads an unquoted leading `!` as a tag, and the
parser then reports an empty pattern. When the changed paths are not known
(a first push or a force push without `--base`), path filters let
everything through.

### Jobs

| Key           | Meaning                                                                                                                                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `using`       | Required, unless the job has `cloud:`. `builtin:<name>@<version>`, `repo:<name>@<version>` or `env:<name>@<version>`. See below.                                                                                   |
| `cloud`       | Run the job on one of the organisation's connected cloud accounts instead of the runner: `<provider>/<kind>` or a map. See [Cloud jobs](#cloud-jobs).                                                              |
| `args`        | For a tool: a list, or one line split like a shell splits words (quotes group, nothing expands).                                                                                                                   |
| `run`         | For an environment: a bash script, run with `set -euo pipefail`.                                                                                                                                                   |
| `name`        | Display name. Defaults to the key plus the matrix values.                                                                                                                                                          |
| `matrix`      | `[a, b]` (read as `${{ matrix }}`) or named axes `{ os: [a, b], mode: [x] }` (read as `${{ matrix.os }}`), with an optional `exclude:` list of combinations. Up to 64 entries.                                     |
| `cwd`         | Working directory in the isolate. Defaults to the clone. Plain WASI tools see it only as `$PWD` (see [Known limitations](#known-limitations)).                                                                     |
| `env`         | Extra environment variables. `IWCI_*` is reserved for the runner.                                                                                                                                                  |
| `clone`       | Override `workspace.clone`, or `false` for an empty file system.                                                                                                                                                   |
| `deps`        | Override `workspace.deps`, or `false` to install nothing.                                                                                                                                                          |
| `changes`     | `ignore` (default), `fail`, or `{ commit: "<message>" }`.                                                                                                                                                          |
| `needs`       | Jobs that must finish first. Naming a matrix job waits for all of its entries; `^<job>` in a `packages:` job waits for that job in the packages this one depends on.                                               |
| `if`          | When the job runs, given how its `needs` went. See below.                                                                                                                                                          |
| `outputs`     | Names the job writes to `$IWCI_OUTPUT` for later jobs to read. Not allowed on a matrix job.                                                                                                                        |
| `paths`       | Skip the job unless the commit touches a path these globs let through (see [Filters](#filters)). A skipped job does not block its dependents.                                                                      |
| `timeout`     | `90s`, `10m`, `1h`. Default `10m`, at most `60m`. Stopped sooner when it prints nothing and uses no CPU for 5 minutes (see [Limits](#limits)).                                                                     |
| `memory`      | `512MiB`, `4GiB`. Default `2GiB`, between `16MiB` and `16GiB`.                                                                                                                                                     |
| `cache`       | Files kept between runs: `{ key, restore-keys, paths }`, or a list of up to 16. See [Job caches](#job-caches).                                                                                                     |
| `env-cache`   | `false` turns off the caches the job's environment keeps on its own (Go's build cache), or `{ go-build: false }` the ones it names. See [Environment caches](#environment-caches).                                 |
| `tools`       | For an environment: up to 16 `builtin:` or `repo:` tools its script runs by name. See [Tools in a script](#tools-in-a-script).                                                                                     |
| `network`     | `false` to keep the job off the internet (default on). See [Networking](#networking).                                                                                                                              |
| `artifacts`   | Files handed on to the jobs that need this one. See [Artifacts](#artifacts).                                                                                                                                       |
| `downloads`   | Files kept for people to download from the run: a list of paths, or `{ paths, retention, when }`. See [Downloads](#downloads).                                                                                     |
| `packages`    | One job per workspace package, ordered by their dependencies. See [Workspace packages](#workspace-packages).                                                                                                       |
| `task-cache`  | Skip the job when nothing it reads has changed since a run that passed. See [The task cache](#the-task-cache).                                                                                                     |
| `services`    | Programs started in the job's isolate before it and stopped after it, such as a database, over `workspace.services`; `false` for none. See [Background services](#background-services).                            |
| `connections` | Infrawrench connections whose credentials are lent to the job (a kubeconfig, an SSH host entry), by name or `{ name, namespace }`. See [Connections, SSH keys and resources](#connections-ssh-keys-and-resources). |
| `ssh-keys`    | Infrawrench SSH keys written into the job's `~/.ssh`, by name. See [Connections, SSH keys and resources](#connections-ssh-keys-and-resources).                                                                     |
| `env-from`    | Resource grants whose every exported key becomes an environment variable, by their CI name. The job's own `env:` wins.                                                                                             |

Expressions in `name`, `cwd`, `args`, `run` and `env`, and in a service's
`args`, `run`, `env` and `ready` `log` and `command`: `${{ matrix }}`,
`${{ matrix.<axis> }}`, `${{ needs.<job>.outputs.<name> }}`,
`${{ needs.<job>.result }}`, `${{ commit.sha }}`, `${{ commit.short-sha }}`,
`${{ commit.branch }}`, `${{ repo.id }}`, `${{ event }}`,
`${{ pipeline.name }}` (the file's `name:`), `${{ pull-request.number }}`
(empty unless the event is `pull-request`), `${{ vars.<name> }}`,
and, in `env:` values only, `${{ secrets.<name> }}` (see
[Secrets and variables](#secrets-and-variables)) and
`${{ resources.<name>.<output> }}` (see
[Connections, SSH keys and resources](#connections-ssh-keys-and-resources)). Each is one name;
operators belong in `if:`. Every name is checked when the file is parsed:
reading a job that is not in `needs:`, or an output that job does not
declare, is an error at push time rather than an empty string at run time.

### Concurrency

```yaml
concurrency: deploy-${{ commit.branch }}
# or
concurrency:
  group: ${{ pipeline.name }}-${{ commit.branch }}
  cancel-in-progress: true
```

A pipeline in a group runs only when no other run of the same repository
holds that group. The runner evaluates the group (it parses the file; see
`POST /v1/concurrency`) and stops a run when asked (`POST
/v1/runs/{id}/cancel`); it sees one run at a time, so whoever dispatches a
repository's runs enforces the groups. In this repository that is the app
(`app/packages/server-core/src/ci/`):

- Per repository, at most one run per group is admitted. Group names
  compare case-insensitively.
- With `cancel-in-progress: true`, a newer run cancels the older run in its
  group: only that run's pipelines in the group are stopped (`POST
/v1/runs/{id}/cancel` with `{ "pipelines": [...] }`; its other pipelines
  carry on) and end `cancelled`. Without it the newer run waits
  (`pending`), and an older run already waiting in the group is cancelled:
  only the newest waiting run is kept.
- An older run never displaces or waits behind a newer one: one that
  reaches its group after a newer run of it is cancelled as superseded.
- A run is every pipeline a commit's event triggers, so a run waits as a
  whole for the groups of all of them, and holds them all.
- A pull request from a fork has its groups scoped to that pull request,
  since its pipeline files are the fork's.
- The group is substituted when the file is parsed, so it can use the names
  known before a run starts (`commit.*`, `repo.id`, `event`,
  `pipeline.name`, `pull-request.number`, `vars.*`), not `matrix`, `needs`,
  `package` or secrets. It is at most 256 characters once substituted, and
  not empty. `cancel-in-progress` is `true` or `false`, not an expression.
- Jobs have no `concurrency:` of their own: a job-level group would need the
  runner to hold a job back on a lock only the dispatcher sees.
- Scheduled runs are fired by the proxy, not the app (see
  [Scheduled runs](#scheduled-runs)), so a scheduled pipeline's group only
  counts the proxy's other scheduled runs: the proxy's runs and the app's
  never wait for each other.

A cancelled job is stopped the way its timeout would stop it (its processes
interrupted, then killed, its services stopped) and reports
`"status": "cancelled"`; jobs that had not started report `cancelled`
without running, and so do the jobs that need them, `if: always()` or
not. A pipeline cancelled before it started is reported as
`{ "outcome": "cancelled", "file", "name" }`. A cancelled job saves no
`cache:` or `task-cache:` entry, and is billed for the time it ran.

### Secrets and variables

Variables and secrets are set per organisation or per repository through
the proxy (`app/packages/ci-proxy`, "Secrets and variables"), the
repository's overriding the organisation's of the same name, and arrive
with each run.

- `${{ vars.<name> }}` works anywhere an expression does and is filled in
  when the file is parsed. A variable that is not set reads as empty.
  Variables are not secret.
- `${{ secrets.<name> }}` only works in an `env:` value, a job's or a
  service's (`TOKEN: ${{ secrets.NPM_TOKEN }}`, or inside text, `AUTH: "Bearer
${{ secrets.API_KEY }}"`). The parser keeps it as a name, so a secret is
  never part of a plan or a report; it is read when the job starts. One the
  run does not have is empty, and the job's report says so.
- Every secret's value is replaced with `***` in the live log, the job's
  captured output, its error messages and its outputs (`$IWCI_OUTPUT`),
  including each line of a multi-line secret. Values shorter than three
  characters are not masked.
- A pull request gets variables but no secrets, unless whoever starts the
  run says it comes from the repository itself rather than a fork
  (`"trusted": true` on the proxy).
- `iwci run` reads secrets from `IWCI_SECRET_<NAME>` environment variables
  and variables from `--var NAME=value`.

### Connections, SSH keys and resources

A job can be lent what Infrawrench already holds: a connection's
credentials, an SSH key, an infrastructure resource's outputs. Nothing is
lent unless someone allowed it for the repository (and, optionally, the
branch): an admin turns a connection on for CI, an SSH key's owner turns
the key on, and an admin grants a resource and the outputs jobs may read,
under a CI name. A pull request from a fork is lent nothing.

```yaml
jobs:
  deploy:
    using: env:bash-node@24
    connections: [Production cluster, { name: staging, namespace: web }]
    ssh-keys: [deploy]
    env-from: [r2-assets] # every key the resource exports, as variables
    env:
      DATABASE_URL: ${{ resources.prod-db.connectionString }}
    tools: [builtin:kubectl@1.37, builtin:ssh@10.6] # see kubectl and OpenSSH, below
    run: |
      kubectl rollout restart deploy/web
      ssh web-1 sudo systemctl restart worker # a Host entry the connection wrote
      node scripts/migrate.mjs # reads $DATABASE_URL
```

| Key           | Meaning                                                                                                                                                                                                                                                                                                          |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connections` | Up to 16 connection names (as the app shows them), or `{ name, namespace }`. A Kubernetes connection writes a kubeconfig and sets `KUBECONFIG`; an SSH host connection adds a `Host` entry named after it to `~/.ssh/config`, with its pinned host key in `~/.ssh/known_hosts` and its jump host as `ProxyJump`. |
| `ssh-keys`    | Up to 16 SSH key names: each private key is written to `~/.ssh` (mode `0600`) and named as an `IdentityFile`. Only a key whose private half Infrawrench holds.                                                                                                                                                   |
| `env-from`    | Up to 16 resource grants by CI name (`[A-Za-z0-9][A-Za-z0-9_-]*`): every key the resource exports (an R2 bucket's endpoint and keys, a tunnel's token) becomes a variable.                                                                                                                                       |

`${{ resources.<name>.<output> }}` reads one output of a granted resource,
such as a database's `connectionString` or a secret manager entry's
`value`. Like `${{ secrets.<name> }}` it only works in `env:` values, a
job's or a service's, and the parser keeps it as a name, so a value is never
in a plan or a report.

- **Literal names.** Connection, key and grant names cannot use `${{ }}`:
  the app reads them from the file before the run starts (`POST
/v1/concurrency`, each pipeline's `jobs`) and resolves exactly those.
- **Fails, never empty.** A name the app did not lend fails the job before
  it starts, with the app's reason ("staging is not lent to CI for
  acme/web on feature/x"), and so does an output it did not grant. A job of
  an untrusted run (a pull request from a fork) that names anything fails
  the same way: "connections, SSH keys and resources are never lent to an
  untrusted run".
- **Only the job that names it.** Files are written into that job's own file
  system (mode `0600` unless the app says otherwise; a directory made for
  them, such as `~/.ssh`, is `0700`), never into the clone, the shared
  `/tmp/workflow` or another job. They are never its changes, artifacts,
  downloads or cache entries, whatever paths those name. Variables come
  under the job's own `env:`, which wins.
- **Masked.** Every value is masked like a secret in the live log, the
  job's output, its error messages and outputs, and its text downloads,
  each line of a multi-line one (a private key) too. The app marks which
  parts of a file are secret, so a kubeconfig's token is masked and its
  `apiVersion: v1` is not.
- **Short-lived where the provider allows.** The app mints what it can for
  the run (a Kubernetes bearer token instead of a kubeconfig that runs
  `aws eks get-token`), and reads every value fresh per run.
- **The network does not change.** A job still reaches public addresses
  only (see [Networking](#networking)): a cluster API or host on a private
  address is reached through a public jump host, which the generated SSH
  config names as `ProxyJump`.
- `iwci run` reads what to lend from the JSON file `IWCI_LENT_FILE` names
  (the request's `lent`, below), and `--untrusted` runs as a fork's pull
  request would.
- A job that is lent anything cannot be task-cached.

### Cloud jobs

`cloud:` runs a job on one of the organisation's connected cloud accounts
that an admin opted in to CI, rather than on the runner: a fresh VM, a
one-off container, a managed build service with Docker, an existing host
over SSH, or a job on an existing cluster. The runner keeps the job in the
pipeline graph; the app, which holds the account's credentials, starts the
machine, runs the script there, and tears the machine down.

```yaml
jobs:
  image:
    cloud:
      provider: gcp # the plugin id of an opted-in connection
      kind: build # vm, container, build, host or cluster
      connection: Production # optional: which connection, when there are several
      machine: e2-highcpu-8 # optional: the provider's size name
      image: gcr.io/cloud-builders/docker # optional: container or OS image
      region: europe-west1 # optional
      gpu: a100:2 # optional: <type>[:<count>], where the provider has GPUs
    needs: [build]
    run: docker build -t europe-docker.pkg.dev/acme/web/app:${{ commit.sha }} . && docker push ...
    timeout: 30m
    outputs: [digest]
    artifacts: [out/sbom.json]
```

`cloud: gcp/build` is the short form. `provider`, `kind` and `connection`
are literal, so the app can match the job to an opted-in connection before
the run starts; `machine`, `image`, `region` and `gpu` may use
`${{ matrix }}`.

- **Like any job:** `run` (bash, with `set -euo pipefail`, on the
  machine), `env` (secrets and resources included), `needs`, `if`,
  `outputs` (`$IWCI_OUTPUT`), `artifacts` both ways (it gets the artifacts
  of the jobs it needs, and hands its own on), `matrix`, `paths`,
  `timeout`, `cwd`, `changes: fail`, `connections`, `ssh-keys` and
  `env-from`. It starts from the commit, cloned as `workspace.clone` says
  (`clone: { depth }` may change the depth).
- **Not yet**, each an error naming the key: `using`, `args`, `deps`,
  `tools`, `cache`, `memory`, `network: false`, `services`, `packages`,
  `task-cache`, `env-cache`, `downloads`, `changes: commit`, and `clone`
  other than `{ depth }`. A workspace's `deps` and `services` are not a
  cloud job's.
- **What it takes of the runner:** nothing. It waits for its executor as
  `external`, with no slot and no memory, and is billed as external time,
  apart from the runner's CPU and memory (see [HTTP API](#http-api-iwci-serve)).
- **Timeout.** The executor holds the script to `timeout:` on the machine.
  The runner also ends a claimed job `timeout:` plus 10 minutes (for the
  machine to start) after its claim, one whose executor has said nothing for
  5 minutes as lost, and one nobody has claimed after its `timeout:` (at
  least 10 minutes).
- **Never for an untrusted run.** A pull request from a fork fails its cloud
  jobs at once: "Cloud jobs only run for trusted runs", and the app is never
  asked to run them.
- **The machine gets no cloud credentials** of the account it runs on, only
  the job's own `env:` and what it is lent.
- `iwci run` has no executor: a cloud job there is an error.

### The run's scratch directory

Every job of a run sees the same writable `/tmp/workflow`
(`$IWCI_SCRATCH`), whatever its tool: one job can leave a build there and a
later job (`needs:`) pick it up without a cache or an output. It starts
empty, it is gone when the run ends, it is held in memory and capped by the
top-level `scratch:` (default 1 GiB), and nothing under it counts as a
change to the repository. Jobs running at the same time share it as they
would share a disk, so give them different paths.

### Artifacts

A job's `artifacts:` lists paths, relative to the clone or absolute, whose
files are handed on once the job passes. Every job that needs it, directly
or through other jobs, starts with those files in its own file system,
where the producing job left them. That is how one job's build becomes
another's input, as a monorepo's build order needs:

```yaml
jobs:
  core:
    using: builtin:typescript@7.1
    cwd: /app/packages/core
    args: [-p, ., --emitDeclarationOnly]
    artifacts: [packages/core/dist]

  web:
    needs: [core] # starts with packages/core/dist
    using: builtin:typescript@7.1
    cwd: /app/packages/web
    args: [--noEmit]
```

- Paths may use `${{ matrix }}` (quote them inside `[ ]`); a matrix job's
  entries hand on all of their files together.
- A job that fails, or is skipped, hands on nothing. A job keeps only the
  files it added or changed under its paths: not the checkout's own files
  there, and not the files it was handed.
- Handed-on files are not the receiving job's changes, so `changes: fail`
  and `changes: commit` ignore them. They count toward the receiving job's
  `memory:`.
- Everything kept lives in memory until the run ends and counts toward the
  run's `scratch:` limit; a job whose artifacts would pass it fails.

### Downloads

`downloads:` keeps files for people rather than for other jobs: a build, a
test report, a coverage page. Once the job ends they are uploaded to the
runners' object store, listed in the job's report, and offered on the run's
page in the app, each behind a link that works for a few minutes.

```yaml
jobs:
  build:
    using: env:bash-node@24
    run: pnpm run build && tar -czf app.tar.gz dist
    downloads: [app.tar.gz]

  e2e:
    using: env:bash-node@24
    run: pnpm run test:e2e
    downloads:
      paths: [playwright-report, test-results/junit.xml]
      retention: 7d # default 30d
      when: always # success (default), failure or always
```

| Key         | Meaning                                                                                                                                         |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `paths`     | Up to 64 paths, relative to the clone or absolute, that may use `${{ matrix }}`. A directory keeps every file under it.                         |
| `retention` | How long the files are kept: `12h`, `7d`, between `1h` and `365d`. Default `30d`. A runner may keep them for less (`--download-max-retention`). |
| `when`      | Which outcomes of the job keep them: `success` (the default), `failure` (a crash dump, a report of what failed) or `always`.                    |

- **What is kept.** The files the job added or changed under its paths, as
  with `artifacts:`: not the checkout's own files there, and not files it
  was handed by the jobs it needs. Each file is stored as itself (no
  archive), so a directory of 500 files is 500 downloads; tar it in the
  script to offer one. A path the job wrote nothing under is a note in its
  report, not a failure.
- **Secrets.** A text file (valid UTF-8 without a NUL byte) has the run's
  secret values replaced with `***` before it leaves the job, the same
  masking its log gets. **A binary file is uploaded exactly as the job left
  it, unmasked**: an archive, an image, a compiled program or a compressed
  report that contains a secret keeps it. Do not put secrets in what you
  download. A pull request from a fork gets no secrets in the first place.
- **Limits.** One file may be up to `--download-max-file` (default and most
  256 MiB) and one run's files together up to `--download-max-run` (default
  1 GiB). A file over either limit is left out and the job's notes say so;
  the job does not fail for it, and neither does an upload the store
  refuses.
- **Storage.** Downloads count toward the owner's storage quota with its
  caches, and are billed with them (`GET /v1/storage/{owner}`). An upload
  that does not fit evicts the owner's oldest caches; a download is never
  evicted to make room, so when downloads alone fill the quota, a new one is
  refused with a note.
- **Expiry.** A file stops being served when its retention runs out, and
  the proxy's Cron Trigger deletes it within about an hour after
  (`app/packages/ci-proxy`, "Downloads"). A local `--store` is never swept.
- **Not with `task-cache:`**: a hit does not run the job, so there would be
  nothing to upload.
- Each file is stored at `artifacts/<owner>/<repo-id>/<run-id>/<expires>-<id>`,
  where `<id>` is a hash of the job's id and the file's path. The report's
  `downloads` list gives each file's `path`, `size`, `sha256` (of the stored
  bytes, so after masking), `content_type`, `expires_at`, `key` and whether
  it was `masked`. Nothing is public: the bucket has no public access, and
  the proxy serves a file only for a link the app signed after checking who
  is asking.

### Workspace packages

`packages:` makes one job per package of the repository's JavaScript
workspace, the way Turborepo runs a task in every package:

```yaml
jobs:
  build:
    packages: { scripts: { build: "tsdown*" } }
    needs: ["^build"] # each package's dependencies first
    using: builtin:typescript@7.1
    args: [--emitDeclarationOnly, --outDir, dist]
    artifacts: [dist] # relative to the package
    task-cache: true

  check:
    packages: { has: [tsconfig.json], scripts: { build: "!tsdown*" } }
    needs: ["^build"]
    using: builtin:typescript@7.1
    args: [--noEmit]
```

- The packages are the directories `pnpm-workspace.yaml` lists, or, without
  it, the root `package.json`'s `workspaces` (npm, Yarn, Bun); never the
  root package or anything under `node_modules` or a hidden directory. A
  dependency is a workspace dependency when its name is another package's
  (`dependencies`, `devDependencies`, `optionalDependencies`,
  `peerDependencies`), whatever version it asks for.
- `packages: true` is every package. A filter narrows it: `only:` globs
  over each package's directory or name (`app/*`, `@scope/*`, `!` excludes,
  read in order), `has:` names that must be directly in its directory,
  `has-script:` scripts it must define, and `scripts:` a glob its command
  must match (`*` crosses `/`; `!` selects a script that does not match or
  is missing).
- Each package's job is keyed `<job>[<package dir>]`, runs in the
  package's directory, reads `${{ package.dir }}` (relative to the clone)
  and `${{ package.name }}`, and resolves relative `artifacts`, `cache`
  paths and `task-cache` inputs against the package. `paths:` globs stay
  relative to the clone, since they filter the commit's changed paths.
- In a `packages:` job, `needs: ["^build"]` waits for `build` in each
  package this one depends on; a dependency without one (filtered out) is
  looked through to its own dependencies. `needs: [build]` there means the
  same package's `build`. Any other job naming a `packages:` job waits for
  all of its packages, so `needs: [build]` on a plain job gets every
  package's artifacts. A dependency cycle among packages is an error.
- A `packages:` job can have a `matrix:`: each package's job gets its
  entries, keyed `<job>[<package dir>][<values>]` (`test[app/web][1]`), and
  naming it waits for all of them. That splits one package's long suite
  without splitting every package's; give the big packages a job of their
  own with `only:`:

  ```yaml
  test-web:
    packages: { only: [app/web] }
    matrix: [1, 2, 3, 4]
    run: vitest run --shard=${{ matrix }}/4
    task-cache: true # one entry per shard
  ```

- A `packages:` job cannot have `outputs:` or `changes: commit`, and `${{ needs.<job> }}` cannot read one (it has a
  result per package). `iwci plan` expands it over the workspace of the
  checkout the file is in; outside one, `iwci validate` checks it against a
  placeholder package.

### The task cache

`task-cache:` skips a job whose inputs have not changed since a run of it
passed, handing on that run's artifacts, outputs and log as if it had run
again. With `packages:` and `^` needs it is what makes a monorepo's CI only
recheck what a change can affect:

```yaml
task-cache: true # every file of the package (or the clone)
task-cache:
  inputs: [src/**, tsconfig.json, "!src/**/*.test.ts"]
  root-inputs: [tsconfig.base.json] # relative to the clone
  artifacts: false # what it is handed is not part of its key (below)
```

- **The key** is a hash of the job's definition (tool and version,
  arguments or script, `env:`, `cwd`, `tools:`, `artifacts:`, `outputs:`,
  `network:`, `changes:`), its workspace's settings and lockfiles
  (`pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.npmrc`, `go.mod`, `go.sum`,
  `Cargo.lock`), the files its inputs match as the commit has them, and the
  bytes of every artifact it is handed. A job downstream of one that
  changed is handed different files, so its key changes too; one whose
  upstream rebuilt the same files is not. The tool's version is the one
  `using:` names, not the one it resolves to: `env:bash-node@24` keeps its
  key when a new `24.x` is published, and runs on the new one only once
  something else changes the key. Name an exact version (`@24.0.8`) for
  the key to follow it.
- **`artifacts: false`** leaves the artifacts a job is handed out of its
  key, for a job that has them only to pass them on, such as a bundler
  that keeps its workspace dependencies external but must hand their
  `dist/` down to the tests: without it, a change at the bottom of the
  chain reruns every bundle above it. The job still receives them. Only
  for a job whose result does not depend on them, or it is skipped when
  they change.
- **Inputs** are filter globs (`!` excludes, read in order), relative to
  the package or, for a job without `packages:`, the clone. The default is
  every file there. `node_modules` and `.git` are never read; the lockfile
  stands for what was installed. Files a job reads that its inputs leave
  out are not in the key: name them, or the job can be skipped when they
  change.
- **On a hit** the job does not run, start a tool, wait for a job slot or
  take memory: it passes, its report says `cached` and replays the log of
  the run it stands for, its `outputs:` read as that run wrote them, and
  its artifacts reach the jobs that need it. It is not billed. Keys read
  the bare checkout, so a run whose jobs all hit never installs its
  workspace's dependencies.
- **The lookup comes before the queue.** As soon as a job's `needs` have
  finished, its key is computed and its entry read from the object store,
  up to 64 jobs of a run at a time, whatever `--cpus` and `--memory` are
  and whatever else the runner is doing. So a hit costs one read of the
  store (two at once for a pull request, see [Job caches](#job-caches)),
  and its `duration_ms` is that read.
- **On a miss** it joins the queue and runs as usual, taking a slot and
  its `memory:` only then, and after it passes its kept artifacts, outputs
  and log are saved under the key it was looked up by. Its `duration_ms`
  is the run's, without the lookup. Failures are never cached.
- Entries are kept with the [job caches](#job-caches), scoped and counted
  the same way: a pull request's entries are never read by a push to the
  default branch.
- **A run can skip it.** A request with `"no-task-cache": true`, or
  `iwci run --no-task-cache`, runs every task-cached job as if each lookup
  missed, and saves what passes as usual. Clearing a repository's caches
  (`DELETE /v1/storage/{owner}/{repo-id}`) drops its entries for good.
- A job that reads secrets or commits its changes cannot be task-cached:
  its result could depend on what the key cannot hold. Nor should one that
  reads the run's shared `/tmp/workflow`, which is not part of its key.

### Outputs, dynamic matrices and `if:`

A job can decide what later jobs do:

```yaml
jobs:
  affected:
    using: env:bash@5
    outputs: [packages, docs]
    run: |
      echo 'packages=["web","mobile"]' >> "$IWCI_OUTPUT"
      echo "docs=true" >> "$IWCI_OUTPUT"

  typecheck:
    needs: [affected]
    matrix: ${{ needs.affected.outputs.packages }}
    using: builtin:typescript@7.1
    cwd: /app/app/packages/${{ matrix }}

  docs:
    needs: [affected]
    if: needs.affected.outputs.docs == 'true' && changed('app/packages/website/**')
    using: env:bash-node@24
    run: pnpm run build

  report:
    needs: [typecheck, docs]
    if: always()
    using: env:bash@5
    run: echo "${{ needs.typecheck.result }}"
```

- **Outputs.** A job declares `outputs:` and writes `name=value` lines, or
  `name<<EOF` ... `EOF` blocks for multi-line values, to the file at
  `$IWCI_OUTPUT`. Writing an undeclared name fails the job, so a typo cannot
  leave a later job reading an empty string. A matrix job cannot declare
  outputs, because every entry would write the same names.
- **Dynamic matrices.** `matrix:` can be `${{ needs.<job>.outputs.<name> }}`
  holding a JSON list (read as `${{ matrix }}`) or an object of axes, and a
  single axis can be an output holding a JSON list. The job expands when its
  needs finish. An empty list runs nothing and is not a failure.
- **`if:`** takes `==`, `!=`, `&&`, `||`, `!`, parentheses, `'strings'`,
  `true` and `false`; the functions `success()`, `failure()`, `always()`,
  `contains(a, b)` (a JSON list is searched by element), `startsWith`,
  `endsWith` and `changed('glob', ...)`; and the names above. An `if:` that
  calls none of `success()`, `failure()` or
  `always()` means `success() && (...)`, so it never runs after a failure
  unless it says so. A surrounding `${{ }}` is optional. A string is false
  when it is empty or `false`, so an output of `false` reads as false.
- **What blocks what.** A job that fails, or is skipped because something it
  needs failed, holds back its dependents. A job skipped by its own `if:`,
  its `paths:`, or an empty matrix does not: jobs that need it still run.
  `needs.<job>.result` is `success`, `failure` or `skipped`.

Every tool is pinned. `@7.1` takes the newest `7.1.x`, `@7` the newest `7.x`,
`@7.1.3` exactly that; a bare name is an error, so a new release can never
change what an old commit runs.

### Job order

When more jobs are ready than may run, a run starts the one with the
longest chain of work still ahead of it: its own expected time plus the
longest of the jobs that wait on it, directly or through others. A job at
the bottom of a long `needs` chain, such as the first library every test
waits for, starts before a hundred formatting jobs nothing waits on. Ties
go to the job more jobs wait on, then to the order of the file and of the
matrix, so the same plan and history always start in the same order.
Task cache lookups go in the same order.

Expected times are what each job took the last time the pipeline ran on
the branch (or, for a branch's first run, on the default branch), kept with
the [job caches](#job-caches) as one small entry per pipeline and updated
after every run. A task cache hit counts as the run it stands for. A job
with no recorded time is expected to take the median of those with one;
with no history at all every job counts alike, so the longest chain is the
one with the most jobs on it. The order only ever applies within a run: runs
sharing a runner still share its slots and memory as before.

### What changed from the first sketch

- `git-clone` and `download-deps-with` moved to a top-level `workspace`
  (overridable per job as `clone` and `deps`): a clone and install shared
  across jobs is what makes jobs start instantly, so it is the default.
- `method: shallow` became `depth`, which also says how shallow.
- `builtin:typescript-7.1` became `builtin:typescript@7.1`, so a version is
  always separable from a name.
- A matrix can have named axes; the plain list still reads as `${{ matrix }}`.
- The TODO about committing a formatter's output is `changes: { commit: ... }`.
- `builtin:prettier` is `builtin:oxfmt`: Prettier is JavaScript, and builtins
  do not embed a JavaScript engine. oxfmt is Oxc's Rust formatter, which
  reports full conformance with Prettier's JS and TS tests and also formats
  JSON, CSS, GraphQL and YAML.
- `env:` jobs and `run:` scripts are new, and so are `outputs:`, matrices
  set by another job, and `if:`.

## Tools and environments

| Kind      | Example                  | What it is                                                                                                                   |
| --------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `builtin` | `builtin:typescript@7.1` | A tool we build and publish (`builtins/`).                                                                                   |
| `repo`    | `repo:licence-check@2`   | A wasm tool uploaded for one repository. Found in R2 under that repository's prefix only.                                    |
| `env`     | `env:bash-node@24`       | A set of Wasmer packages a `run:` script executes in. bash spawns the other commands as WASIX processes in the same isolate. |

Builtins:

| Builtin            | ABI        | Built from                                                                                                                                   |
| ------------------ | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `typescript@7.1`   | `tsc-host` | [tsc-rs] v0.8.0 (TypeScript 7.1) for `wasm32-wasip1`. Reads files through two host imports the runner serves from the in-memory file system. |
| `gofmt@1.27`       | `wasi`     | Go 1.27.3's `cmd/gofmt`, `GOOS=wasip1`.                                                                                                      |
| `oxfmt@0.69`       | `wasix`    | Oxc `apps_v1.84.0`'s pure-Rust CLI for WASIX (it needs threads).                                                                             |
| `kubectl@1.37`     | `wasix`    | kubectl 1.37.2, built with `env:go`'s toolchain for WASIX, so it reaches a cluster over the job's network. See [kubectl](#kubectl).          |
| `ssh@10.6`         | `wasix`    | OpenSSH 10.6p2's `ssh`, built for WASIX with OpenSSL 3.5.9. See [OpenSSH](#openssh).                                                         |
| `scp@10.6`         | `wasix`    | OpenSSH 10.6p2's `scp`, which runs `ssh`: list both.                                                                                         |
| `sftp@10.6`        | `wasix`    | OpenSSH 10.6p2's `sftp`, which runs `ssh`: list both.                                                                                        |
| `ssh-keygen@10.6`  | `wasix`    | OpenSSH 10.6p2's `ssh-keygen`.                                                                                                               |
| `ssh-keyscan@10.6` | `wasix`    | OpenSSH 10.6p2's `ssh-keyscan`.                                                                                                              |

Environments:

| Environment            | Packages                                                                                                                                                                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bash@5`               | `wasmer/bash` 1.0.25 (GNU bash 5.1, patched), `wasmer/coreutils` 1.0.27, `wasmer/sed` 4.9.0 (GNU sed, patched), `wasmer/grep` 3.12.0, `wasmer/findutils` 0.10.1 and our `iwci/git` (Git 2.56.1, built for WASIX here; see [Git](#git)) |
| `bash-node@24`         | the above plus `wasmer/edgejs` 0.2.5, rebuilt on a fixed C library (Node 24 compatible; `node`, `npm`, `pnpm`)                                                                                                                         |
| `python@3.13`          | `bash@5`'s packages plus `python/python` 3.13.20 (CPython 3.13.15 with pip; see [Python](#python))                                                                                                                                     |
| `php@8.1` to `php@8.5` | `bash@5`'s packages plus `phpix/phpix-8X-64bit` 0.3.1, `sendmail/sendmail` 0.1.10, `wasmer/icu-data` 78.3.0 and our `iwci/php-cli` (a php-cli compatible `php`, Composer 2.11.2; see [PHP](#php))                                      |
| `go@1.23` to `go@1.27` | `bash@5`'s packages plus Go 1.23.12, 1.24.13, 1.25.14, 1.26.11 or 1.27.4, built for WASIX here (`go`, `gofmt`; see [Go](#go))                                                                                                          |
| `postgres@18.4`        | `bash@5`'s packages plus `wasmer/pglite` 0.2.0 (PostgreSQL 18.4, in memory) and our `iwci/pglite-server` (many connections, `pgcrypto`), for `services:` (see [PostgreSQL](#postgresql))                                               |

An environment's major and minor version follow the runtime it carries
(Node 24, CPython 3.13, PHP 8.4), so `env:python@3.13` always means a
CPython 3.13. Its patch number is the environment's own revision, not the
runtime's: `bash-node` 24.0.5 is not Node 24.0.5, and `python` 3.13.16 and
`php` 8.4.28 carry the same interpreters as 3.13.15 and 8.4.27 with a
changed bash. `go` 1.27.5 likewise holds Go 1.27.4: Go's environments
carried the Go release's own number until Git came in. Each table entry
names the runtime release inside.

Scripts run with `set -euo pipefail`, but see the known limitations: under
WASIX a pipeline currently reports only its last command's status.

A file that starts with `#!` runs its interpreter, from bash or from
Node's `child_process` alike (`#!/bin/bash`, `#!/usr/bin/env node`), and a
background command (`server &`) runs beside the rest of the script. Both
come from a patched wasmer-wasix (`vendor/README.md`), as does this: no
descriptor in a job is a terminal. Its stdin is empty and its output goes to
the log, so `[ -t 1 ]` is false, a script piped to an interpreter runs as a
script rather than an interactive session, and tools that colour or prompt
only on a terminal do neither. A script can use any descriptor, 3 and 4
included (`exec 3>&1`,
[#1019](https://github.com/Infrawrench/Infrawrench/issues/1019)), which
are WASIX's preopens underneath.

A process outlives its parent, as on Linux, so a helper a subshell
detaches (`( ssh -N -L ... bastion & )`) or a `node` starts `detached`
keeps running after the subshell or `node` has exited
([#1105](https://github.com/Infrawrench/Infrawrench/issues/1105)). It does
not outlive the job: whatever a job leaves running is stopped when the
job's script ends, as a container's processes end with the container
([#1106](https://github.com/Infrawrench/Infrawrench/issues/1106)).

An argument with a line feed in it reaches the program whole, so a
multi-line `node -e`, `python -c` or `bash -c` runs every line
([#1003](https://github.com/Infrawrench/Infrawrench/issues/1003)). bash
starts every program by forking and calling `execve`, and the C library
Wasmer's bash 1.0.25 is linked with joined the arguments into one string
with a line feed after each, for WASIX's `proc_exec3` to split again. No
`wasmer/bash` release is built on a C library with `proc_exec4`, which takes
the list as a list, and rebuilding bash on one would change its fork,
signals and job control with it, so `builtins/environments/bash/build.sh`
changes that one call in Wasmer's module (nine bytes, each site checked
before it is changed, and the result pinned by hash) and repackages it.
That was `bash` 5.1.17, `bash-node` 24.0.5, `python` 3.13.16 and `php`
8.1.35, 8.2.36, 8.3.37, 8.4.28 and 8.5.13 (each the same PHP as before). The
package keeps Wasmer's version, 1.0.25, because Edge.js and Python depend on
`wasmer/bash@^1.0.25`. Drop the script once a `wasmer/bash` release calls
`proc_exec4`.

sed's `e` command and the `e` flag of `s///` had the same bug in another
call ([#1022](https://github.com/Infrawrench/Infrawrench/issues/1022)):
they run the command with `popen`, and the C library in Wasmer's sed 4.9.0
starts `sh -c` with `posix_spawn` through the line-feed-joined
`proc_spawn2`, so a command with a line feed in it ran only up to it.
`builtins/environments/sed/build.sh` changes that call to `proc_spawn3` the
same way (fourteen bytes, through `patch-module.sh`, which both scripts
share). That was `bash` 5.1.18, `bash-node` 24.0.6, `python` 3.13.17 and
`php` 8.1.36, 8.2.37, 8.3.38, 8.4.29 and 8.5.14. Drop it once a `wasmer/sed`
release calls `proc_spawn3`.

Git came into every environment in `bash` 5.1.19, `bash-node` 24.0.9,
`python` 3.13.18, `php` 8.1.37, 8.2.38, 8.3.39, 8.4.30 and 8.5.15, `go`
1.23.13, 1.24.14, 1.25.15, 1.26.12 and 1.27.5 (each the same Go as before)
and `postgres` 18.4.2 (see [Git](#git)). Go's build cache is kept between
runs from `go` 1.23.14, 1.24.15, 1.25.16, 1.26.13 and 1.27.6, the same Go
again (see [Environment caches](#environment-caches)).

Edge.js's WASIX package has no JavaScript engine inside it: it imports
N-API from the host, and the runner provides it with V8 through
[`wasmer-napi`]. That is the `node` feature (`cargo build -p iwci --features
node`), off by default because it links V8. Three things make it work, each
commented where it lives: jobs with Node run without WASIX's asynchronous
threading (V8 must run on a real thread stack; wasmer-napi's own runner does
the same), a package command's `wasi.env` is applied as defaults rather than
appended (otherwise pnpm sees `PATH` twice), and `vendor/wasmer-napi` is
patched so a job timeout can stop a script that never yields, so Node jobs
run at the same time without crashing the runner, and so worker threads work
(see `vendor/README.md`). Every `node` is an isolate in the runner's own
process, so a fault in that bridge is a crash of every run on the runner;
#947 was one (shared registries left unlocked once jobs stopped taking
turns). It also means one `node`'s state can reach another's: #955 was a
`node` that started as another ended being given the dead one's heap of
`ArrayBuffer` memory, because the bridge found it by the address the two
memories had in turn, and dying as it started with "Bad system call". On Linux it builds for x86_64 and ARM64: the vendored bridge takes
ARM64's V8 from a later `wasmerio/v8-custom-builds` release (the same V8)
and links libatomic there, and the release channel carries both
(`x86_64-linux` and `aarch64-linux`); a runner installs its own
architecture's build.

`worker_threads` work: each Worker is a WASIX thread of its `node` with an
isolate of its own, charged against the job's `memory:` like the main one,
so a job that starts more workers than its memory holds gets
`ERR_WORKER_INIT_FAILED` ("Failed to create worker env") for the rest, and
its report says memory if it then fails or hangs. A Worker started while other isolates are live starts small
(64 MiB old generation) and grows as it allocates; a 2 GiB job fits about
fifteen idle workers. A `node` that another `node` of the job spawns (a
Vitest fork, a package script) starts with the first isolate's 256 MiB, as
far as a quarter of what is left allows: on 64 MiB it collected its whole
heap every few megabytes it allocated.

`node:wasi` works. Edge.js 0.2.5 ships the module but not the binding behind
it, so the runner gives every environment job `/usr/local/lib/iwci/node`
and puts `--require /usr/local/lib/iwci/node/preload.cjs` first in
`NODE_OPTIONS` (anything the job sets is kept after it). The preload answers
`node:wasi` with a WASI written in JavaScript ([`@tybys/wasm-util`], vendored
in `crates/iwci-runtime/node/`), for `require` and `import` alike and in
worker threads, and steps aside for a built-in one that works. That is what
packages whose native addon falls back to a `wasm32-wasi` build need:
rolldown, and with it Vite 8, Vitest and tsdown; oxc; the Astro compiler.
The pnpm installer installs those `wasm32` builds: it treats a job as a
platform with cpu `wasm32` and no operating system, so they are the
optional dependencies it keeps and native ones the ones it leaves out. A
package that leaves its WASI build out of its own optional dependencies, as
rolldown does, needs it listed in the repository: an `optionalDependencies`
entry pnpm records in the lockfile but installs on no real machine.

The same preload covers one more place where Edge.js and Node differ, until
a pinned Edge.js fixes it: a blob's stream reads past empty parts, because
Edge.js's stopped at the first one and never ended (#940). A pending async
WebAssembly compile keeps `node` alive and its result is picked up as soon
as it lands, as in Node: the runner's V8 platform waits for an isolate's
background work at the end of each event-loop turn (#943,
`vendor/README.md`).

Edge.js is the one package not taken as Wasmer published it. wasix-libc,
the C library linked into its module, makes a relative path absolute in one
buffer that every thread shares, so concurrent `fs` calls by relative path
could trade paths: a read opened the working directory (EISDIR) or another
file (#937). The fix is open upstream (wasix-org/wasix-libc#145) and in no
Edge.js release, so `builtins/environments/edgejs/build.sh` builds 0.2.5's
module from its source, with its toolchain, on its sysroot with that one
object of the C library rebuilt from #145, and puts it in the published
package in place of Wasmer's. That was `bash-node` 24.0.1; 24.0.0 was
Wasmer's package with the runner making `fs` paths absolute in a preload
instead.

24.0.2 carries a second patch the same way, this one ours
(`wasix-libc-thread-exit.patch`, #967). A thread that exits releases
wasix-libc's thread-list lock itself, which lets `pthread_join` free its
stack, and then made one more host call whose result the host writes into
that stack. Another `pthread_create` could already have been handed the
block, so a byte of a starting thread's stack, start arguments or thread
structure was overwritten, and under thread churn (Workers starting and
ending) a `node` now and then lost a thread to a trap in its first
instructions and died without a word. The patched exit sends that result
to static storage.

24.0.3 adds a patch to Edge.js's own source (`edgejs-worker-stop.patch`,
#938). Edge.js stops a Worker by terminating its isolate and setting a flag
its event loop checks between turns, but V8 lifts a termination once the
JavaScript it interrupted has unwound, and the worker's message port went
on to dispatch the next queued message in the same turn. A handler that
blocked in `Atomics.wait` then blocked for good, and the parent waited
forever to join the thread: rolldown's wasm worker threads idle exactly
that way, so about one tsdown bundle in 300 to 600 printed its result and
never exited. A stopped worker now drops its queued messages, as Node does.

24.0.4 adds a second Edge.js patch (`edgejs-worker-env-race.patch`, #938).
A parent stopping a worker read the worker's env under the worker's mutex
and used it after letting go, while a worker ending by itself freed that
env before it cleared the pointer. The stop then locked a mutex inside the
freed `edge::Environment`, whose type word the allocator had overwritten,
and the parent's main thread waited on a lock it held itself, with the
rest of its workers never stopped: about one tsdown bundle in 3,000 on
x86. The request is now made under the mutex, and the worker clears the
pointer under it before freeing anything, as Node's Worker does.

24.0.7 adds three more. `edgejs-worker-env-readers.patch` (#938) does the
same for the other places a parent reads a worker's env: a task queued on
the worker (heap statistics, CPU use, profiles), a diagnostic report and
`eventLoopUtilization()`. `edgejs-request-interrupt.patch` (#1006) makes
those requests work at all: Edge.js queues each on the worker's loop and
also asks the engine to interrupt the worker's JavaScript for it, which the
bridge refuses from another thread, and it reported that as a failure with
the request still queued, so the task was freed and then run (`node`
crashed or hung) or the call failed. `wasix-libc-modes.patch` (#959, `posix.o` and
`fstat.o`) makes the C library ask the runner for file modes: `stat`,
`lstat`, `fstatat` and `fstat` fill in the permission bits from
`/proc/iwci`, `chmod`, `fchmod` and `fchmodat` set them, and `open` with
`O_CREAT` and `mkdir` record the mode they were given, less the `umask`
(see [File modes](#file-modes)).

24.0.8 adds three. `edgejs-worker-cpu-usage.patch` (#1006) makes
`worker.cpuUsage()` settle: libuv reads a thread's CPU time with
`getrusage(RUSAGE_THREAD)`, which its WASIX build lacks, and the failure
reached the parent with a null argument that made the call to its callback
fail, so the promise never settled. A worker, and
`process.threadCpuUsage()`, now read the thread's CPU clock instead, and
any task that fails is answered. `wasix-libc-getrusage.patch` (#1038,
`getrusage.o`) makes the C library's `getrusage` read CPU time: it gave
the monotonic clock (days since the host started) as both user and system
time, so `process.cpuUsage()` counted sleeping as work. The CPU clocks it
now reads are the runner's: a guest thread's and a guest process's own CPU
time (`vendor/README.md`, wasmer-wasix), not the runner's whole process's
or a pooled host thread's. All of it is user time; system time reads 0.
bash and coreutils keep Wasmer's C library, so the shell's `time` and
`times` still print the monotonic clock until wasix-libc fixes it. `edgejs-builtins-cache.patch` (#996) turns on Edge.js's
code cache for its built-in modules, which only a build with the engine
compiled in had, so a `node` no longer compiles the built-ins it loads from
source at every start. V8 takes only a cache its own build wrote with the
same flags, so the runner makes it, before the first job of an
environment with `node`: a job of its own runs that environment's Edge.js
over its built-ins with recording on (a few seconds, once per environment
and process), and every later job gets the file read-only beside the
preload, as `/usr/local/lib/iwci/node/edge.builtins`
(`crates/iwci-runtime/src/builtins.rs`). Nothing a job does changes it: a
cache a job could write would be code every later job ran. A `node` only
reads it; one that should record its own (`EDGE_BUILTINS_CACHE=<file>
EDGE_BUILTINS_CACHE_RECORD=1`) writes that file, in its own job.
`EDGE_BYTECODE_CACHE=0` turns it off. On ci-1 `node -e 0` went from 54 or 55
ms to 41 to 43 ms, and a `node` that loads `child_process`, `stream`,
`crypto` and `worker_threads` from 60 to 68 ms to 45 to 52 ms.

24.0.10 adds two. `edgejs-open-flags.patch` (#1045) opens numeric flags
that name no access mode read-only, as Node's `O_RDONLY` of 0 does
everywhere else: WASI's `O_RDONLY` is a bit of its own and the C library
refused `fs.open(path, 0)` with `EINVAL`, so Go's WebAssembly runtime
(esbuild-wasm) could open nothing. Other hard-coded Linux values, such as
`O_CREAT` as `0x40`, still mean something else here; `fs.constants` has
the right ones. `edgejs-structured-clone.patch` (#1048) makes
`structuredClone` and `postMessage` keep integer-like keys (`{ "200": ...
}`, an OpenAPI document's responses), shared references and cycles, and
leave non-enumerable properties behind. Edge.js copies a value through
N-API before V8 serializes it, to stand in for host objects and
transferables, and that copy took each object's own non-index properties
and copied an object every time it met it. `structuredClone` of plain data
(objects, arrays, maps, sets, dates, buffers, with no getters, proxies or
transferables) now skips the copy and goes to V8's serializer alone, as
Node's does; a document of a few thousand objects used to run out of N-API
handles in the copy (`DataCloneError`).

24.0.11 adds `edgejs-child-exit-poll.patch` (#1065), to Edge.js's libuv:
a `node` notices a child's exit within 100 ms whatever timers it has
pending. WASIX sends no SIGCHLD, so libuv asks whether a child has exited
after each poll, and bounded the poll for that only when nothing else
would end it. A child's output ends before its exit can be read, so the
poll that saw the end of it could find the child still running, and the
next one slept until the parent's next timer: `spawnSync` with a
`timeout` returned, with the child's status and output intact, only when
the timeout ran out (one call in six to eight, four at a time on
two CPUs), and an asynchronous child's `exit` waited for the next timer.

24.0.12 adds `edgejs-post-message.patch` (#1061): `postMessage` of a value
of several thousand objects arrives, where it used to be lost without an
error or leave the receiver waiting until the stall check. Edge.js copied
every posted value through N-API before V8 serialized it, keeping every
handle of the copy until the call returned and finding what it had
already copied by comparing with everything so far. Plain data with nothing
to transfer now goes to V8's serializer alone, as Node's does and as
`structuredClone` already did, and is not walked again when it is read
(100,000 objects through a `MessageChannel` in about 0.2 s); a value with
something to transfer still takes the copy, now in linear time and with
its handles released step by step (100,000 objects in about 6.5 s); and a
copy that fails throws `DataCloneError`. The runner's side of the same
issue is in `vendor/wasmer-napi`: a copied buffer of 16 or 64 MiB failed
to read now and then (a `messageerror`, "Message could not be
deserialized"), because reading a message could not grow the guest heap.

24.0.13 adds `edgejs-worker-report-state.patch` (#1070):
`process.report.getReport()` waited for its workers' parts on a condition
variable in its own stack frame, and a worker signalled it after letting
go of its lock, so the parent could return in between and the signal then
followed whatever that stack held next: it wrote into it, or the worker
faulted (`out of bounds memory access`, `unaligned atomic access`). The
wait's state is now shared with the requests, so the last of them frees
it.

24.0.14 adds `edgejs-worker-task-free.patch` (#1070): a worker's bootstrap
no longer fails now and then with "No such built-in module", a preload
path with four bytes zeroed or a fault when a program polls its workers.
`worker.getHeapStatistics()` and `worker.cpuUsage()` make a task holding a
reference to the object the answer goes to; a worker refuses tasks before
its env is up and while it ends, and on a refusal Edge.js freed the task
and then cleared that reference in it, a four-byte zero into freed memory.
Workers polled from the moment they are made did that thousands of times
a run, and when another thread had been handed the block by then, a
built-in module's name or a path it was holding lost four bytes. The task
is now kept until its reference is gone.

24.0.15 adds `edgejs-compile-cache.patch`: Node's module compile cache,
which Edge.js stubbed out as disabled. `NODE_COMPILE_CACHE=<dir>`, or
`module.enableCompileCache()`, keeps the engine's code cache of every
CommonJS and ES module the default loaders compile from a file in that
directory, and the next `node` takes it instead of compiling the module
again.
`module.getCompileCacheDir()`, `flushCompileCache()`,
`NODE_DISABLE_COMPILE_CACHE` and `NODE_COMPILE_CACHE_PORTABLE=1` (entries
keyed by paths relative to the cache, so it moves with the tree) behave
as in Node 24, and `NODE_DEBUG_NATIVE=COMPILE_CACHE` reports what happened
to each module. Entries live under a directory named for the Node version,
the engine's code cache version and flags (read from a code cache's
header, since N-API has no `CachedDataVersionTag()`) and the user; each
carries the size and hash of its source and of its payload, so a changed
file, an entry another engine or other flags wrote, or a damaged one costs
only the compile, and V8 refuses a cache it did not write in any case.
They are written as they are made rather than at exit, so a test runner's
worker killed at the end keeps what it compiled, and in place rather than
renamed over, since concurrent renames onto one name abort the runner
(#1092); a directory that cannot be made is no cache, never an error.
Nothing turns it on by itself yet. A job can keep the cache between runs with a [job cache](#job-caches)
inside the clone, which is scoped by branch like any other:

```yaml
jobs:
  test:
    using: env:bash-node@24
    env: { NODE_COMPILE_CACHE: /app/.node-compile-cache }
    cache:
      key: node-compile-cache-${{ hashFiles('pnpm-lock.yaml') }}
      restore-keys: [node-compile-cache-]
      paths: [.node-compile-cache]
```

The win is modest, because a code cache made right after compiling holds
only the functions V8 compiled eagerly, as Node's does. On ci-1 with the
host quiet, without and with a warm cache in one job, medians of nine
alternating runs: `node -e 0` 38 ms either way, `require("effect")` 447
to 422 ms, importing `vitest/node` 350 to 337 ms, `vitest --version` 63
to 60 ms. `client-core`'s Vitest suite took 21.2 to 22.4 s without and
20.2 to 20.5 s with it (three runs each), `ui`'s 121 and 141 s without and
116 and 116 s with it. A tsdown bundle did not move (median 1.92 s
against 1.87 s): its time is rolldown's WebAssembly. `ui`'s suite writes
about 2,800 entries.

The build is reproducible, and without the patches it gives back Wasmer's
module bit for bit (`EDGEJS_VERIFY=1`), so the patches are the whole
difference. Drop each patch when the sysroot Edge.js builds on, or Edge.js,
has its fix, and go back to pinning Wasmer's package once a release has
all the fixes (the modes patch speaks the runner's own protocol, so that
needs a way for a release to ask the host).

`builtins/*/build.sh` builds each into `dist/`, and `iwci publish` uploads
it. Every package and source is pinned to a tag or a content hash. On
`main`, each builtin's CI job publishes what it just tested to the runner
pool's bucket (`builtins/publish.sh`, with the `IWCI_R2_*` secrets). A
version already published with other bytes stays as it is and the run
shows a warning: a changed build needs a new version.

[tsc-rs]: https://github.com/pingdotgg/ts-rust
[`wasmer-napi`]: https://crates.io/crates/wasmer-napi
[`@tybys/wasm-util`]: https://github.com/toyobayashi/wasm-util

### File modes

A job's files keep their modes, as on Linux: a checked-out file git
records as executable is `0755` and every other file `0644`, a directory
`0755`, and a mode moves with its file through `mv` and is gone with it
after `rm`. WASIX has no call that sets or reads a mode, so environments
get three commands from the runner, ahead of coreutils on `PATH`, that do
it through files the runner serves at `/proc/iwci`:

- `chmod` (octal and symbolic modes, `-R`, `-f`, `-v`, `-c`, `--reference`),
- `stat` (`-c`/`--printf` formats, `-L`, `-t`, and GNU's default output;
  inode and device numbers read 0, and the job's user has no name),
- `mktemp` (GNU's options), whose file is `0600` and directory `0700`.

`stat -c %a "$(mktemp)"` therefore prints `600`. Node (`env:bash-node`
24.0.7 on) sees the same modes: its C library reads and writes them through
`/proc/iwci`, so `fs.statSync`, `fs.chmodSync`, `fs.writeFileSync(f, data,
{ mode })`, `fs.mkdirSync`, `fs.mkdtempSync`, `fs.copyFileSync` and
`process.umask` behave as on Linux, and `fs.fstatSync` reads what
`fs.statSync` does. `fs.fchmodSync` works on a file the same `node` created
or one that already has a mode recorded (the checkout's executables,
anything `chmod`ed), and leaves any other as it was. Other programs see no
modes (see the known limitations).

### Tools in a script

`tools:` makes builtins and repository tools commands an `env:` script can
run by name:

```yaml
lint:
  using: env:bash@5
  tools: [builtin:gofmt@1.27, repo:licence-check@2]
  run: |
    test -z "$(gofmt -l .)"
    licence-check --strict
```

Each tool's module is written to `/usr/local/bin/<name>`, first on the
default `PATH`, and runs as a WASI or WASIX process inside the job, sharing
its compiled code with jobs that use the tool directly. A tool's data files
and default environment come with it. Two kinds cannot be commands and are
refused when the job starts: tools that use the tsc-host ABI
(`builtin:typescript`, which reads files through its own host interface;
run it as a job of its own) and tools whose manifest has default arguments.

### kubectl

`tools: [builtin:kubectl@1.37]` puts kubectl on an environment's `PATH`.
It is Kubernetes' own `cmd/kubectl` (1.37.2, `kubectl version` says so),
built by `builtins/kubectl/build.sh` with `env:go`'s toolchain, whose
WASIX patches give it sockets, and it reads the kubeconfig a
[lent connection](#connections-ssh-keys-and-resources) writes
(`KUBECONFIG`).

```yaml
deploy:
  using: env:bash@5
  tools: [builtin:kubectl@1.37]
  connections: [Production cluster]
  run: |
    kubectl get pods
    kubectl rollout restart deploy/web
    kubectl rollout status deploy/web --timeout=5m
```

What to know:

- **No exec credential plugins.** A job has no `aws`, `gcloud` or `doctl`,
  so a kubeconfig that runs one cannot log in. The app lends a kubeconfig
  with a short-lived token instead; one you write yourself needs a token or
  a client certificate.
- **The cluster's API must be public**, or reached through a public jump
  host: jobs reach public addresses only (see [Networking](#networking)).
- **No terminal.** A job has none, so `kubectl exec -it` and `kubectl
attach -it` run without a TTY, as from any CI. Three vendored packages
  that assume a terminal (`moby/term`, kubectl's `util` and `util/term`)
  get wasip1 files that say so, which is the whole change to kubectl's
  source; `build.sh` checks each file it touches.
- **It is a 128 MB module.** A runner compiles it once (`iwci serve` warms
  it), after which a command starts in a fraction of a second.
- Tested end to end (`builtins/test.sh bash kubectl`) against a small TLS
  API server on the job's own loopback (`builtins/kubectl/fake-apiserver.go`):
  version, discovery, `get`, `-o jsonpath`, `rollout restart`, a refused
  token, and a lent kubeconfig whose token is masked in the log. Streams
  that upgrade the connection (`exec`, `logs -f`, `port-forward`) are not
  tested yet.

### OpenSSH

`tools: [builtin:ssh@10.6]` puts OpenSSH's own `ssh` on an environment's
`PATH`; `scp`, `sftp`, `ssh-keygen` and `ssh-keyscan` are builtins of their
own, at the same version, and `scp` and `sftp` start `ssh`, so a job that
copies lists both. They are OpenSSH portable 10.6p2, built from its release
by `builtins/openssh/build.sh` for WASIX with OpenSSL 3.5.9, and read what a
[lent connection or SSH key](#connections-ssh-keys-and-resources) writes:
`~/.ssh/config`, `~/.ssh/known_hosts` and the key.

```yaml
deploy:
  using: env:bash@5
  tools: [builtin:ssh@10.6, builtin:scp@10.6]
  connections: [web-1] # a Host entry, its pinned host key, ProxyJump if any
  ssh-keys: [deploy]
  run: |
    scp dist/app.tar.gz web-1:/tmp/
    ssh web-1 'tar -xzf /tmp/app.tar.gz -C /srv/app && sudo systemctl restart app'
```

What to know:

- **Host keys are checked.** A host whose key is not in `known_hosts` fails
  ("Host key verification failed"), since there is no terminal to ask, and
  so does one whose key changed. A lent connection pins its key; for any
  other host, add its key to `~/.ssh/known_hosts` from a variable or the
  repository. `ssh-keyscan` is there, but trusting what it reads is trusting
  the network.
- **Every key type and algorithm OpenSSH has**, OpenSSL's included: Ed25519,
  RSA and ECDSA keys (user and host, and certificates), the ML-KEM,
  sntrup761, Curve25519 and NIST curve key exchanges, ChaCha20-Poly1305 and
  AES-GCM/CTR. No security keys (`sk-` types, there is no USB) and no
  compression (`-C` is accepted and changes nothing).
- **Keys are held to their modes, as on Linux.** A private key a job writes
  itself needs `chmod 600`, or ssh refuses it as "UNPROTECTED PRIVATE KEY
  FILE"; a lent one already is (see [File modes](#file-modes)). A private
  key file must end with a line feed.
- **ProxyJump and ProxyCommand work**, through the job's shell, as do `Match
exec` and `LocalCommand`. A jump host must be public, like any host a job
  reaches (see [Networking](#networking)).
- **Tunnels work**: `ssh -N -L 5432:db.internal:5432 bastion &` in a job's
  script, then `wait-for-port 5432`, reaches a database behind a bastion.
- **No terminal.** `ssh -t` says so and runs without one, as from any CI.
- **No background ssh.** WASIX built this way has no `fork()`, so OpenSSH
  starts its children with `posix_spawn()` (`openssh-spawn.patch`), and
  what can only fork fails with "Function not implemented": `ssh -f`,
  `ControlPersist`, `KnownHostsCommand`, `ssh-askpass`. A job has no Unix
  sockets, so no `ControlMaster` either. There is no `ssh-agent` (`-A`
  forwards nothing) and no `sshd`.
- Tested end to end (`builtins/test.sh bash openssh`) against small SSH
  servers on the job's own loopback (`builtins/openssh/sshd-fixture`):
  commands with stdin and exit status, `scp` both ways and `sftp`, ProxyJump
  through a second server, a `-L` tunnel, RSA host and user keys, `ssh-keygen` and
  `ssh-keyscan`, and as failures a changed host key, an unknown host, a key
  without `chmod 600`, a refused connection and a connection the app did
  not lend. The lent key is printed and must come out masked. Remote (`-R`)
  and dynamic (`-D`) forwarding are not tested.

### Git

Every environment has Git 2.56.1 on `PATH`, built for WASIX from its
release by `builtins/environments/git/build.sh`: the real `git`, so
scripts get its exact behaviour and output, with its built-in commands,
the subcommands that are shell scripts (`git submodule`, `git merge -s
octopus`, `git mergetool`, `git filter-branch`, ...) and `git init`'s
templates.

```yaml
release-notes:
  using: env:bash@5
  env: { GIT_AUTHOR_NAME: ci, GIT_AUTHOR_EMAIL: ci@example.com }
  run: |
    git clone --depth=50 https://github.com/example/project.git /tmp/p
    git -C /tmp/p log --oneline v1.2.0..HEAD
```

What works:

- **Repositories a job makes or clones**: everything local (`init`, `add`,
  `commit`, `diff`, `log`, `status`, `show`, `rev-parse`, `ls-files`,
  `config`, `checkout`, `switch`, `branch`, `tag`, `merge`, `rebase`,
  `stash`, `worktree`, the plumbing), hooks, and Git run from Node's
  `child_process`, Python's `subprocess` or PHP.
- **Remotes**: a path or `file://` (fetch, push, `--depth`, a hook on the
  receiving end), and HTTP and HTTPS (`git-remote-https`, on libcurl 8.23.0
  and OpenSSL 3.5.9), over the job's [network](#networking), so not with
  `network: false`. Certificates are checked against Mozilla's CA bundle in
  the package (`/usr/share/git-core/ca-certificates.crt`); `GIT_SSL_CAINFO`
  names another. A token goes in the URL
  (`https://x-access-token:${TOKEN}@github.com/...`) or a credential helper
  such as `store` (with `HOME` set).

What to know:

- **The checkout is not a repository.** The runner writes the commit's
  tree into the job's file system without a `.git`, so `git log` or `git
describe` in `/app` fails; clone what a job needs to inspect.
- **No identity and no `HOME`.** A commit needs `user.name` and
  `user.email` (`-c`, `GIT_AUTHOR_*` and `GIT_COMMITTER_*`, or `git config`
  in the repository), and `git config --global` needs `HOME` set, which a
  job's environment does not have.
- **File modes are Git's to record**: `git init` sets `core.filemode`
  true, so `git add` records a file made executable as `100755`, and
  checkouts get their modes, executables included.
- **A status of 80 or more reads as 79** to the script that ran Git
  ([#1053](https://github.com/Infrawrench/Infrawrench/issues/1053)), so a
  fatal error (128) is 79 in `$?`; it is still a failure, and a job whose
  last command is Git ends with Git's own status.
- **No hard links** (see the known limitations), so Git renames object
  files into place and a clone from a path copies.
- **Not built**: the Perl and Python commands (`send-email`, `svn`, `p4`,
  `cvsimport`, ...), `git daemon`, `git http-backend`, `git imap-send`,
  `git shell`, the dumb HTTP protocol, the `ssh://` transport (there is
  no `ssh`), translations (messages are English) and `scalar`.

Git starts its own subcommands, hooks and the other end of a local remote
as child processes. It does that by forking, and the C library it is built
on (Edge.js's, with exception handling) has no `fork()`, so one patch
starts them with `posix_spawn()` instead; `build.sh` lists the three
patches and why. The package is 9 MB: Git's module is 3.6 MB and
`git-remote-https`'s, with OpenSSL, 4 MB.

### Python

`env:python@3.13` is CPython 3.13.15 built for WASIX, with pip, beside the
tools of `env:bash@5`. It is Wasmer's `python/python` 3.13.20 (the package's
version is Wasmer's own), which loads compiled extension modules at run
time. `python`, `python3` and `pip` are commands, and the console scripts
pip installs (`pytest`) are on `PATH`.

```yaml
test:
  using: env:python@3.13
  run: |
    pip install -r requirements.txt
    pytest
```

What `pip install` can install:

- **Pure Python packages** from PyPI, wheels and source distributions
  alike (`requests`, `pytest`, `docopt` from its sdist).
- **Packages with compiled code that Wasmer's WASIX wheel index has**
  (`https://python-registry.wasix.org/simple/`, about 220 projects with
  `wasix_wasm32` wheels: numpy, pandas, scipy, pydantic-core,
  cryptography, lxml, psycopg-binary, grpcio, duckdb, ...). pip looks there
  as well as on PyPI.

What it cannot:

- **Build native code from source.** A job has no C compiler, so a package
  with a C, C++ or Rust extension that the WASIX index lacks fails to
  install.
- **Make a virtual environment.** `python -m venv` fails (it cannot copy
  the interpreter, which lives inside the package). Packages install into
  the interpreter itself, which is the job's own copy; to keep a set apart,
  `pip install --target <dir>` and `PYTHONPATH=<dir>`.

pip and the tools it installs need these defaults, which the environment
sets and a job's `env:` can override:

| Variable                        | Value                                       | Why                                                                                                                                                                     |
| ------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `_PYTHON_HOST_PLATFORM`         | `wasix-wasm32`                              | The interpreter reports its platform as `wasi_0_0_0_wasm32`, under which pip takes none of the `wasix_wasm32` wheels and tries to build numpy and the like from source. |
| `PIP_EXTRA_INDEX_URL`           | `https://python-registry.wasix.org/simple/` | The WASIX wheel index, next to PyPI.                                                                                                                                    |
| `PIP_PREFER_BINARY`             | `1`                                         | Otherwise pip takes a newer sdist on PyPI over the index's wheel of the previous release, and fails to build it.                                                        |
| `PIP_BREAK_SYSTEM_PACKAGES`     | `1`                                         | The interpreter is marked externally managed; installing into it is what a job wants.                                                                                   |
| `PIP_ROOT_USER_ACTION`          | `ignore`                                    | A job runs as root, which pip warns about on every install.                                                                                                             |
| `PIP_DISABLE_PIP_VERSION_CHECK` | `1`                                         | No request to PyPI for pip's own newest version.                                                                                                                        |
| `PYTEST_ADDOPTS`                | `-p no:faulthandler`                        | pytest's faulthandler plugin cannot start ("Value too large for data type"). pytest adds this to a repository's own `addopts`; a job that sets its own must keep it.    |

`pip install` downloads when the job runs, over the job's
[network](#networking), checked only as far as pip checks (its
`--require-hashes`), and every job downloads its packages again.
`deps: [pip]` installs a lock before the job instead, the way the pnpm, Go
and Cargo installers do
([#1015](https://github.com/Infrawrench/Infrawrench/issues/1015)):

```yaml
workspace:
  deps:
    - pip # pylock.toml, else requirements.txt, at the root
    - pip: { dir: service, file: requirements/ci.txt }
jobs:
  test:
    using: env:python@3.13
    network: false # nothing to download
    run: python -m pytest
```

The lock is a requirements file whose every entry is pinned with `==` and
carries `--hash=sha256:` lines (`pip-compile --generate-hashes`, `uv pip
compile --generate-hashes`, `poetry export`), or a PEP 751 `pylock.toml`
(`pip lock`, `uv export --format pylock.toml`). `uv.lock` and `poetry.lock`
go through those exporters: each is its resolver's whole graph for every
platform, and the exported file is where the WASIX wheels come in (below).
What the installer does with it:

- **Markers.** Each entry's markers are evaluated for `env:python`
  (CPython 3.13.15, `sys_platform` `wasi`, `platform_machine` `wasm32`) and
  the entries that do not hold are left out, as pip would leave them out
  there.
- **Which file.** A requirements entry's files are looked up on the file's
  own `--index-url` and `--extra-index-url`, then on PyPI and
  `https://python-registry.wasix.org/simple/`; a `pylock.toml` names its
  files itself. Only a file whose SHA-256 the lock lists is a candidate,
  so an index is trusted for where to look and nothing else. Of the
  candidates, the wheel whose tags suit CPython 3.13 on `wasix_wasm32`
  best is taken, ranked as pip ranks them: a WASIX build, then pure
  Python. A wheel only for other platforms, or only a source distribution,
  is refused with the files it found: a job cannot build one.
- **Verified, then installed.** The wheel is checked against its hash
  before anything is unpacked, then installed as pip installs it, without
  running pip: its files in the site directory and its `.data` schemes
  where they belong, a script for each console entry point, `INSTALLER`,
  and a `RECORD` of where everything went. Nothing runs at install time.
- **Missing dependencies** an installed distribution declares
  (`Requires-Dist`, markers evaluated) and the lock does not install are
  reported as warnings, since only the lock decides what is installed.

Packages go into the interpreter's user site: the job gets
`PYTHONUSERBASE=/root/.local`, so they are in
`/root/.local/lib/python3.13/site-packages` with their `.pth` files read,
and `/root/.local/bin` (the console scripts) goes first on `PATH`. `pip
list` in the job shows them. The install is cached like the others (see
[Caching](#caching)).

**WASIX wheels in a lock.** A package with compiled code needs its WASIX
build's hash in the lock, and a lock made on a laptop does not have it:
Wasmer's index publishes its builds under a local version
(`numpy 2.5.1+wasix.3`), and `pip-compile --generate-hashes
--extra-index-url https://python-registry.wasix.org/simple/` hashes only
the files of the version it resolved for the laptop (`2.5.1`, PyPI's). The
simplest lock is one made where the job runs, with `pip lock` (pip 26.2 in
`env:python`), which picks the files for that interpreter and records
them, the WASIX wheel included:

```yaml
lock:
  using: env:python@3.13
  run: |
    pip lock -r requirements.in -o pylock.toml
    cat pylock.toml # commit what it prints
```

A requirements file works as well when the WASIX wheel's hash is added to
its entry by hand: `==2.5.1` matches `2.5.1+wasix.3`, and the index lists
each file's SHA-256 (`https://python-registry.wasix.org/simple/numpy/`).
A lock without a WASIX build for such a package fails the install, naming
the wheels it found.

`python -c` (multi-line included), `python - <<EOF` and a script piped to
`python` work.

### PHP

`env:php@8.1`, `@8.2`, `@8.3`, `@8.4` and `@8.5` are PHP 8.1.34, 8.2.35,
8.3.36, 8.4.27 and 8.5.12, from Wasmer's `phpix` packages (0.3.1), beside
the tools of `env:bash@5` and Composer 2.11.2:

```yaml
test:
  using: env:php@8.4
  run: |
    composer install
    vendor/bin/phpunit
```

Every version has the same extensions, `bcmath ctype curl date dom exif
fileinfo filter ftp gd hash iconv igbinary imagick intl json libxml
mbstring mysqli mysqlnd openssl pcre PDO pdo_mysql pdo_pgsql pdo_sqlite
pgsql Phar posix Reflection session SimpleXML soap sodium SPL sqlite3
standard tokenizer xml xmlreader xmlwriter zip zlib` and OPcache, plus the
ones PHP itself added since 8.1: `random` from 8.2, `lexbor` and `uri` in
8.5. There is no Xdebug or PCOV, so no code coverage, and no JIT.

phpix is not php-cli: it is a server and script runner of Wasmer's that
embeds PHP. The environment's own `php` (`builtins/environments/php-cli`,
first on `PATH`, ahead of phpix's) makes up the differences a pipeline
meets:

- **The working directory.** phpix changes into a script's own directory
  before running it, and ignores its `-C`, so `php vendor/bin/phpunit`
  looked for `phpunit.xml` in `vendor/bin` and Composer for
  `composer.json` beside its phar. `php` changes back to where it was
  started (a file prepended to the script), so scripts, `vendor/bin/*` and
  `composer` work in the job's directory, with no `--working-dir`.
- **`PHP_BINARY`** is that `php`, so a PHP that Composer (`@php`, scripts)
  or PHPUnit starts behaves the same.
- **`php -m` and `php -l`**, which phpix does not have, when they come
  first. `-l` checks syntax with PHP's parser, so errors only the compiler
  finds (a function declared twice) pass.

What still differs from php-cli:

- Of php-cli's options only `-r`, `-f`, `-d`, `-c`, `-n`, `-v`, `-h` and
  `-S` (a server) work, plus `-m` and `-l` above: no `-i` (`phpinfo()`
  prints HTML), `-a`, `-s` or `-w`, and no script on standard input.
- A fatal error (an uncaught exception) exits with 79, not 255.
- `mail()` fails: sendmail has no backend.
- A repository's own `auto_prepend_file` is replaced by the environment's.
- Composer has no `unzip` or `7z`: it unpacks archives with the zip
  extension (and says so). [Git](#git) is there, but a package installed
  from source, which needs it, has not been tried.

The environment sets `PATH` (php-cli first), `COMPOSER_ALLOW_SUPERUSER=1`
(a job runs as root, which Composer warns about on every command) and
`COMPOSER_NO_INTERACTION=1` (nobody answers, and every descriptor reads as
a terminal, [#1008](https://github.com/Infrawrench/Infrawrench/issues/1008)).

`composer install` downloads from Packagist when the job runs, over the
job's network, checked only as far as Composer checks. `deps: [composer]`
installs `composer.lock` before the job instead
([#1015](https://github.com/Infrawrench/Infrawrench/issues/1015)):

```yaml
workspace:
  deps: [composer] # composer.lock at the root; `- composer: { dir: api }` for another
jobs:
  test:
    using: env:php@8.4
    network: false
    run: vendor/bin/phpunit
```

What is verified, package by package:

- **A dist with a `shasum`** (a private repository, Satis) is downloaded
  and checked against that SHA-1 before it is unpacked.
- **A dist without one**, which is nearly every package on Packagist (the
  lock points at a GitHub archive and records `"shasum": ""`), is
  installed from the commit the lock names in `source.reference`: the
  runner fetches that commit from `source.url` (https only, without
  credentials) into its git cache, and git's object ids tie every byte of
  the tree to the commit id. The tree is laid out as the archive would
  have it (GitHub makes it with `git archive`): what the package's
  `.gitattributes` mark `export-ignore` is left out. `export-subst` is not
  applied, so a file that uses it keeps its placeholder.
- **A `path` package**, a directory of the repository, is linked from
  `vendor/`, as Composer links it.
- **Anything else is refused**: a dist without a hash whose source is not
  a git commit (a branch, an `hg` or `svn` source, a non-https URL), and
  `target-dir`.

Then it writes what `composer install` writes: `vendor/bin` with
Composer's own proxies, `vendor/composer/installed.json` and
`installed.php`, Composer's `ClassLoader` and `InstalledVersions` (from
Composer 2.11.2, MIT, the environment's version), and the autoloader:
PSR-0, PSR-4, the class map (Composer's way of finding classes, over each
`classmap` path less `exclude-from-classmap`) and `files`, for every
package and the root's `autoload` and `autoload-dev`. The autoloader is
written on every run rather than cached with the packages, since a root
`classmap` scans the repository's own files. Dev packages are installed,
as `composer install` installs them by default. Plugins and scripts do not
run (as with `--no-plugins --no-scripts`), so a package a plugin would put
elsewhere (`composer/installers`) stays in `vendor/`, and there is no
`platform_check.php`.

**Where it comes from.** phpix is libphp from `wasix-org/php` (MIT) inside
a host program of Wasmer's whose source is not public, and the OpenSSL and
curl built into it report development versions (OpenSSL 3.2.0-dev, curl
8.4.0-DEV). The packages are pinned by hash, so nothing changes under a
pin, but what is inside them can only be checked by running it. Composer's
phar is pinned by the SHA-256 getcomposer.org publishes.

### Go

`env:go@1.23` to `env:go@1.27` are the five newest Go minor releases
(1.23.12, 1.24.13, 1.25.14, 1.26.11 and 1.27.4), each a whole toolchain
running as WASIX programs beside the tools of `env:bash@5`. `go` and
`gofmt` are commands, and `go build`, `go vet`, `go test`, `go run` and
`go install` work, with the module's dependencies from the Go installer:

```yaml
workspace:
  deps: [go]
jobs:
  test:
    using: env:go@1.27
    run: |
      go vet ./...
      go test ./...
```

Upstream Go's `wasip1` port cannot host itself: `go build` runs `compile`
and `link` as child processes, and `wasip1` has none, nor real sockets.
wasix-org/go's `wasix` branch (Wasmer's `golang/go` 1.25.5-wasix-1) keeps
`GOOS=wasip1` and gives `syscall`, `os/exec` and `net` WASIX's processes and
sockets, but it is one release and, as published, does not run.
`builtins/environments/go/build.sh <minor>` builds each minor from go.dev's
release archive with a patch series in `builtins/environments/go/<minor>/`:
that branch's change ported to the release, then one patch per fix, each
written as a commit whose message says what it fixes:

| Patch                                 | Fixes                                                                                                                                    |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| take the working directory from WASIX | Relative paths resolved against nothing (`go version`: "cannot determine current directory"); `getcwd`'s length is passed by pointer.    |
| decode wait statuses                  | Every child exited 0, so a failing `go test` or a `go build` that did not compile exited 0.                                              |
| socket addresses as pointers          | `Listener.Addr()` was nil, and `httptest.NewServer` panicked.                                                                            |
| resolve names through WASIX           | Lookups went to `[::1]:53` over UDP.                                                                                                     |
| nonblocking sockets                   | Sockets blocked in the host, which blocks every goroutine: closing a connection took 60 s, so each `http.Get` and `httptest` server did. |
| report bind errors                    | Listening on a port in use succeeded.                                                                                                    |
| a NUL byte, not `string(0)`           | `go vet std` failed.                                                                                                                     |
| the file tests against `newPollFD`    | `go vet net` failed on the branch's own test file.                                                                                       |
| children in their `Dir`               | `exec.Cmd.Dir` was ignored, so a test read its parent package's `testdata`; `os.Chdir` did not move where children start.                |
| nothing written from the stubs        | `syscall.Umask` and friends printed debugging lines into the program's output.                                                           |
| `Dup` and `Dup2` with `fd_dup`        | A program using them could not start (it imported calls WASIX does not have).                                                            |
| arguments and environment as arrays   | An argument or variable with a line feed in it (a multi-line script, a PEM key) reached a child as several.                              |

Each minor's build has, besides the toolchain:

- **The standard library already compiled and vetted**, as entries of
  `GOCACHE`. A job's first `go build` compiles only the module's own
  packages: on one CPU, 1.5 s for a small module with one dependency,
  where compiling the standard library first takes 42 s. `go vet` of it
  takes 0.9 s and `go test` 2.7 s.
- **The rest of the build cache kept between runs**: what a job adds to
  `GOCACHE` (its dependencies and its own packages, compiled, vetted and
  tested) comes back on its next run, so a run compiles only what changed.
  It is the environment's `go-build` cache (see
  [Environment caches](#environment-caches)); `env-cache: false` turns it
  off.
- **Mozilla's CA certificates**, for HTTPS.

Two packages make up each environment, the toolchain and the cache, since
together they are over the store's 256 MiB limit for one file, which is
also why `src/` has no tests or `testdata`. The build is reproducible and
pinned by hash like Edge.js's. The first job to use a minor on a runner
also waits for Wasmer to compile the toolchain's programs (`compile` alone
is 40 MB of wasm): about 30 s, once, after which the compiled code is in
the runner's module cache. `iwci serve` compiles `go` and `gofmt` ahead of
time, but not `compile`, `link` and `vet`, which are files in `GOROOT`
rather than package commands.

The environment sets these, and a job's `env:` can override them:

| Variable        | Value                                       | Why                                                                                                       |
| --------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `PATH`          | `/usr/local/bin:/usr/bin:/bin:/root/go/bin` | The default, plus where `go install` puts programs.                                                       |
| `GOROOT`        | `/go`                                       | The toolchain's tree in the package; the wasm `go` cannot find it from its own path.                      |
| `GOPATH`        | `/root/go`                                  | The module cache the Go installer fills is `/root/go/pkg/mod`.                                            |
| `GOCACHE`       | `/root/.cache/go-build`                     | Where the compiled standard library is. What a job adds is kept between runs (`go-build`).                |
| `GOTOOLCHAIN`   | `local`                                     | No toolchain on the module proxy runs here; a `go` line newer than the environment's Go fails, saying so. |
| `SSL_CERT_FILE` | `/etc/ssl/certs/ca-certificates.crt`        | The package's certificates; Go's `wasip1` port looks in no default place.                                 |

What to know:

- **Programs are WebAssembly.** `go build` makes `GOOS=wasip1` programs,
  which `go run`, `go test` and the job's script run like any other
  command. `GOOS=linux GOARCH=amd64 go build` cross-compiles a Linux
  binary as it would anywhere, but the job cannot run it.
- **Pick the minor the `go` line asks for**, or a newer one: a `go.mod`
  that asks for a newer Go fails rather than fetching a toolchain.
- **Networking is the job's**: a test can listen on the loopback and
  connect to itself, and reach the internet unless the job sets
  `network: false`. Names resolve through the runner.
- **Not there**: cgo (`CGO_ENABLED=0`), `-race`, `os/signal`,
  `syscall.Kill` and file modes, and anything built on
  `golang.org/x/sys/unix` without a fallback for `wasip1`. The tools that
  read binaries and profiles (`go tool pprof`, `trace`, `objdump`, `nm`,
  `addr2line`) are not built; from 1.25 `go tool` builds one when it is
  run.
- **One thread per program.** A Go program here runs its goroutines on one
  thread, and the go command waits for each compile before it starts the
  next, so a build uses one CPU.
- Each process has at most 4 GiB of memory (wasm32).
- **`go vet` can trap** ("out of bounds memory access" in
  `runtime.mapaccess2`) in its `errorsas` and `hostport` analyzers on some
  packages. That is upstream Go's WebAssembly port: go.dev's own `vet` built
  for `wasip1` does the same under wasmtime. Turning both off gets past it:
  `go vet -errorsas=false -hostport=false`.
- **A process can start any number of children**, one after another, as
  long as no more than the job's 512 threads and processes are alive at
  once: `go vet ./...` on a module with a few hundred dependencies starts
  over 600. Each used to count until its parent exited, so the 512th
  `os/exec` (or Node `child_process`) failed with "Operation not
  permitted" ([#1082](https://github.com/Infrawrench/Infrawrench/issues/1082)).

### Rust

Rust is supported the way every language without an environment is here:
the Cargo installer makes a commit's crates available offline, and any
tool compiled to `wasm32-wasip1` or WASIX runs as a builtin or a `repo:`
tool. `cargo test` needs rustc, which has no WebAssembly build that can
host itself, so jobs that must compile Rust belong on a conventional
runner.

## Job caches

A job can keep files between runs, for what the dependency installers and
its environment's own caches do not cover (`.tsbuildinfo`, `.turbo`, a
downloaded fixture):

```yaml
jobs:
  typecheck:
    cache:
      key: tsc-${{ matrix }}-${{ hashFiles('pnpm-lock.yaml', 'app/packages/web/**/*.ts') }}
      restore-keys: ["tsc-${{ matrix }}-"]
      paths: [app/packages/web/.tsbuildinfo, /tmp/fixtures]
```

- Before the job runs, the exact `key` is restored, or else the newest
  cache saved under the first `restore-keys` prefix that has one.
- After the job passes, `paths` are saved under `key`, unless it started
  from an exact hit. A failed job saves nothing.
- `hashFiles('glob', ...)` hashes the matching files (relative to the
  clone) as the commit has them, by path and content. It only works in
  `key` and `restore-keys`. In a `[...]` list, quote anything with `${{`.
- `paths` are relative to the clone or absolute: anywhere in the job's
  file system, `/tmp` and an environment's directories (`/root/...`)
  included. In an environment's directory only what the job added or
  changed is saved, never the environment's own files. Restored files
  belong to the cache, not the repository: they never count as changes for
  `changes: fail` or `changes: commit`.
- Restored files count against the job's `memory:` like any other write.
- **Scoped by branch, so a pull request cannot poison the default
  branch.** A push saves into its branch's scope and reads that, then the
  default branch's (`--default-branch`, default `main`). A pull request
  saves into a scope of its own, which nothing on the default branch reads.
  The exact `key` is read in both scopes at once, and the run's own scope
  wins when both have it; `restore-keys` are read one scope after another.
- **Counted against the owner's storage quota** (see below). A save that
  would pass the quota evicts the owner's oldest caches first; one larger
  than the whole quota is refused.

Caches live in the object store beside the tools, so on R2 every runner
shares them.

### Environment caches

An environment can keep a directory's additions between runs on its own,
with no `cache:` entry: `env:go@*` keeps Go's build cache, so a job's
second run compiles only the packages that changed. Each one works like a
job cache that the environment wrote:

- **Only what the job added.** An environment's directories are mounted
  under the job's file system, not copied into it, so what a job writes
  there is all the job's file system holds: the environment's own files
  (Go's prebuilt standard library) are never saved, since every run has
  them already.
- **One per job and environment build.** The key is the repository (and
  its scope, below), the job's id (matrix values included), the
  environment's name and exact version, and the runner's architecture: a
  different Go, or a V8 code cache from another machine, is never read.
  Saving replaces it, so a job reads the newest save in its scope, or else
  the default branch's.
- **Scoped like job caches**, through the same store: a pull request reads
  the default branch's cache and saves into a scope of its own, which
  nothing on the default branch reads. These caches hold compiled code that
  later builds link or run, so this matters more here, not less.
- **Saved after a pass, and only when the job changed it.** A failed job
  saves nothing, and a run that leaves the directory as it was restored
  saves nothing either.
- **Bounded.** A cache keeps at most its declared `max-bytes`, and never
  more than a quarter of the job's `memory:` (restored files are in the
  job's memory). Past that, only what that run wrote or changed is kept,
  so a cache that has grown with entries no build reads any more starts
  over from what the last build needed; a run that alone wrote more than
  the limit saves nothing. Go never trims its own cache here (the
  environment's entries are dated 2100), so this is the only bound.
- **Counted against the owner's storage quota**, with the job caches.
- Its lines are in the job's `caches`: ``env cache `go-build`: restored
12345 KiB``, `miss`, `unchanged`, `saved ...`.

`env-cache: false` turns them all off for a job; `env-cache: { go-build:
false }` turns off the ones it names.

An environment declares them in its `build.json` (which `iwci publish`
turns into its manifest), beside `env`:

```json
"env": { "GOCACHE": "/root/.cache/go-build" },
"caches": [
  { "name": "go-build", "path": "/root/.cache/go-build", "max-bytes": 1073741824 }
]
```

`name` is what `env-cache:` and the report call it (`[a-z0-9][a-z0-9_-]*`),
`path` an absolute directory, and `max-bytes` between 1 MiB and 4 GiB; up
to 8 per environment, none inside another. The variable that tells the
program to use the directory goes in `env`, as `GOCACHE` does. The
directory may be one a package ships (Go's) or one nothing ships yet. In
`builtins/environments/build.sh`, set `CACHES` for the `build_env` call (as
`GO_CACHES` is for Go), and give the environment a new version: a
published version never changes. A runner older than the `caches` field
refuses such a manifest (manifests reject unknown fields), so publish the
new versions only once every runner is on a release that has it.

## Networking

Each job has a loopback of its own, in memory, shared by that job's
processes and nothing else. A test suite can start a server on `127.0.0.1`
(or `0.0.0.0`, which means the same here) and connect to it; `localhost`
resolves to it, a closed port refuses rather than reaching some other
listener, a closed listener's port can be listened on again (a server
stopped and restarted, or one per test), and two jobs never see each
other's ports. A listener on `::`,
which is where Node listens when it is given no host, takes connections to
`127.0.0.1` as well as `::1`, as a dual-stack socket does. Nothing a job
listens on appears on the host.

Jobs also reach the **public internet** by default: names resolve through
the host and connections to public addresses go out over host sockets, so a
job can fetch from a registry or call an API. Only public unicast addresses
qualify, checked on the address actually connected to: never the runner's
own loopback (where its API listens), private ranges, link-local addresses
(including cloud metadata at `169.254.169.254`), shared, multicast,
documentation or reserved ranges, in IPv4, IPv6 or IPv4 inside IPv6, nor the host's own addresses, which from the host itself would skip any outside firewall. DNS
answers that point inside are dropped. UDP is not offered.

`network: false` on a job keeps it off the internet, leaving only its
loopback. The `iwci` command turns the internet on for its jobs; the
runtime's own tests never use it.

### Background services

A job's `services:` are programs the runner starts before the job and
stops when it ends: a database, or the job's own API server, for its tests.

```yaml
jobs:
  db-tests:
    using: env:python@3.13
    services:
      postgres:
        using: env:postgres@18
        run: pglite-server
        ready: { port: 5432 }
    run: |
      pip install 'psycopg[binary]'
      pytest   # connects to postgres:5432, any user and database
```

| Key     | Meaning                                                                                                                                                                                                               |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `using` | Required. `env:<name>@<version>`, with `run:`, or a `builtin:` or `repo:` tool, with `args:`.                                                                                                                         |
| `run`   | For an environment: a bash script that starts the service (`pglite-server`, `node server.js`), with `set -euo pipefail`. It starts in the job's `cwd`.                                                                |
| `args`  | For a tool: its arguments, as a job's.                                                                                                                                                                                |
| `env`   | Its environment variables, over the runner's (`CI`, `HOME`, `IWCI_COMMIT`, `IWCI_JOB`, ...). Nothing of the job's `env:`. `${{ secrets.<name> }}` works here as in a job's.                                           |
| `ready` | When the job may start: `{ port: 5432 }`, `{ log: "<regex>" }` or `{ command: "<script>" }`, each with an optional `timeout` (default `60s`, at most the job's). Without `ready`, as soon as the service has started. |

`workspace.services` gives every job the same services. A job's own
`services:` are added to them, one of the same name taking its place, and
`services: false` turns them off for that job. Up to 8 per job.

- **Where it runs.** In the job's isolate, never on the host: on the job's
  own loopback (a service listening on `127.0.0.1:5432` is what the job
  connects to, and nothing else can), over the job's files, so what it
  writes counts as the job's (its changes and its `memory:`), with a
  `/bin`, `/tmp` and `/dev` of its own and process ids of its own.
- **Its name** resolves to `127.0.0.1` inside the job, so `postgres:5432`
  works as on other CI systems; `localhost` and `127.0.0.1` work as well.
  Nothing on the host is changed for it.
- **Its output** goes to the job's stderr, each line after
  `[service <name>] `, and is masked like everything else the job prints:
  a secret in a service's `env:` shows as `***`.
- **Ready.** `port` waits until something in the job listens on that port
  of the loopback, from the runner's table of listeners: it never
  connects, so a service that takes one client (pglite) still has its one
  client for the job. `log` waits for a line of the service's output, on
  either stream, to match a regular expression
  ([Rust's `regex` syntax](https://docs.rs/regex/latest/regex/#syntax),
  which reads like `grep -E` for ordinary patterns). `command` runs a
  script in the service's environment, with its `env:`, every half second
  until it exits 0 (each attempt has 10 s); only an `env:` service has one.
  A service that exits first, or is not ready in time, fails the job
  without running it, and the reason names it: ``service `postgres` exited
with 3 before it was ready``, ``service `postgres` was not ready after
60s: nothing listened on port 5432`` (a `command` check's last output is
  in the log).
- **While the job runs**, a service that exits is reported in the log
  (``iwci: service `postgres` exited with 0 while the job ran``); whether
  that fails the job is up to the job.
- **Stopping.** When the job's script ends, passed, failed or timed out,
  every process of every service gets SIGTERM, then SIGKILL two seconds
  later, and is marked finished a second after that whatever it is doing:
  a service never keeps a job running. A service's output and CPU time are
  the job's, though, so a busy or chatty service keeps a hung job from
  being stopped as stalled (see [Limits](#limits)) before its timeout.
- **Memory.** Each of a service's processes is held to the job's
  `memory:` as each of the job's own is, and a Node service's heaps share
  the job's V8 budget.
- A `task-cache:` job's key covers its services, and a job whose services
  read secrets cannot be task-cached, as with its own `env:`.
- `builtin:typescript` (the tsc-host ABI) has no network or processes, so
  a job using it cannot have services, nor can it be one.

A script can also start a service itself, with `&`, and the runner ends
whatever is still running when the script finishes. Two commands on every
environment's `PATH` wait for it to be ready, so a job need not guess with
`sleep`:

- `wait-for-port PORT [--host 127.0.0.1] [--timeout 30s]` returns once
  something in the job listens on the port (`--host` is `127.0.0.1`, `::1`
  or `localhost`; a job can only wait for its own services). It never
  connects: the runner knows every listener on the job's loopback, and a
  port with one is a port a connection would be accepted on.
- `wait-for-log FILE PATTERN [--timeout 30s]` returns once a line of the
  file matches the pattern, an extended regular expression as `grep -E`
  reads it.

Each exits 1 when its time runs out, saying what it waited for
(`wait-for-log` also prints the file's last lines), and 2 on a usage error.
Durations are seconds, or a number with `ms`, `s`, `m` or `h`.

```yaml
api-tests:
  using: env:bash-node@24
  run: |
    node server.js > server.log 2>&1 &
    wait-for-port 3000
    npm test
```

#### PostgreSQL

`env:postgres@18` is [`wasmer/pglite`](https://wasmer.io/wasmer/pglite)
0.2.0, PostgreSQL 18.4 compiled for WASIX, and `pglite-server` in front of
it, beside the tools of `env:bash@5`. The data is in memory, and the
extensions are `plpgsql`, `dict_snowball` and a `pgcrypto` (below).

```yaml
services:
  postgres:
    using: env:postgres@18
    run: pglite-server
    ready: { port: 5432 }
env:
  DATABASE_URL: postgres://app:app@localhost:5432/app
```

pglite is PostgreSQL's single-user backend behind a socket of its own: one
session, which serves one connection and exits when that client
disconnects. `pglite-server` starts it, keeps that one connection, and
serves PostgreSQL clients on port 5432 (`-port`), as many as connect, so
connection pools, migration tools and test suites that open several
connections work. It prints `pglite-server: ready on port 5432` once they
can.

Every connection gets the one session in turn, **a transaction at a
time**: from a client's first statement until the session is idle outside
a transaction block with nothing of that client's outstanding, nobody else
runs (an extended-protocol exchange runs whole to its `Sync` too). That is
transaction pooling over one backend, and it is what a test that needs
real concurrency should know:

- **Transactions never overlap.** A second one waits until the first has
  committed or rolled back, so it never meets the first one's row locks.
  Claims with `FOR UPDATE SKIP LOCKED` from several connections still take
  each row exactly once, but because they run one after another, not
  because one skipped what another held. A test that holds a lock in one
  connection to watch another skip it cannot pass here.
- **A wait on a transaction that is doing nothing fails** with SQLSTATE
  `55P03` after 15 seconds (`-wait 30s` to change it), naming the
  connection that holds the session. Code that opens a transaction and,
  inside it, waits for a statement on another connection would otherwise
  wait forever; on a real server it would not wait at all. A transaction
  that is running a statement is never given up on.
- **Session state is shared**: `SET`, session advisory locks (the one
  session holds them all, so `pg_advisory_lock` never blocks), `LISTEN`,
  temporary tables. Prepared statements are not: each connection's
  protocol-level statements are its own, and its SQL `PREPARE`s are
  deallocated when it disconnects. A connection that disconnects inside a
  transaction has it rolled back. Once no connection that has used the
  session is left, the session is reset (`DISCARD ALL`), so the next client
  starts from a clean one.
- **Any user, database and password are accepted**, and every client gets
  the database `postgres` as the user `postgres` (`current_user` and
  `current_database()` say so). No TLS; a cancel request does nothing (a
  statement runs to its end).

`pgcrypto` here is a stand-in, since pglite is built without OpenSSL:
`CREATE EXTENSION pgcrypto` installs `digest`, `hmac` and
`gen_random_bytes`, with pgcrypto's signatures and results, for `md5`,
`sha224`, `sha256`, `sha384` and `sha512` (PostgreSQL's own hash
functions). The rest of pgcrypto (`crypt`, `gen_salt`, `sha1`, the PGP and
raw encryption functions) is missing, so calling it fails as an undefined
function. `gen_random_uuid()` is PostgreSQL's own.

`pglite` alone is still there: one connection, ended when that client
disconnects (`ready: { port: 5432 }` never connects, so a readiness check
does not use it up; its log line `OLIPHAUNT_WASIX_SOCKET_READY 5432` works
as `ready: { log: ... }`). PostgreSQL with backends that really run at the
same time needs `fork` with memory shared between processes, which WASIX
does not have: a forked WASIX process gets a copy of its parent's memory.

What else is and is not available:

- **No real MySQL, MariaDB or Redis exists for WASIX**, nor for WASI. A
  MySQL-compatible server (go-mysql-server, an in-memory engine that speaks
  the MySQL protocol) runs, but no environment carries it, and it is not
  MySQL: no InnoDB semantics, and partial isolation and dialect coverage.
- **SQLite** needs no server: Python's `sqlite3` is in `env:python`.
- **A service of your own** is a script in an environment, such as a Node
  server in `env:bash-node@24`, or a WASI or WASIX program uploaded as a
  `repo:` tool.

## The `iwci` command

```sh
iwci validate .infrawrench/ci/*.yml [--json]      # check files, all errors at once
iwci plan .infrawrench/ci/tests.yml [--json]      # the expanded jobs
iwci run --repo https://github.com/org/repo (--sha <commit> | --branch <name>) \
         [--repo-id <id>] [--owner <owner>] [--event push|pull-request] [--base <sha>] \
         [--default-branch main] [--pipeline <file>] [--cpus <n>] [--jobs-per-cpu 4] \
         [--memory <size>] [--storage-quota <size>] [--stall-after 5m] [--json] [--store <dir>] \
         [--keep-installs-unpacked 24h] [--no-task-cache] [--module-memory 1GiB] \
         [--download-max-file 256MiB] [--download-max-run 1GiB] [--download-max-retention 90d]
IWCI_SERVER_KEY=... iwci serve [--listen 127.0.0.1:8547] [same limits as run] [--memory-reserve 4GiB]
iwci publish dist/builtin/gofmt/1.27.3 ...        # upload builtins/*/build.sh output
```

Without `--sha`, `--branch` runs that branch's head as it is now. The owner
(who storage and usage count against) defaults to the GitHub organisation
or user in the URL, as `github.com-<org>`; the repository id to its name.

`--store <dir>` uses a local directory laid out like the bucket; without
it, R2 comes from `IWCI_R2_ACCOUNT_ID`, `IWCI_R2_BUCKET`,
`IWCI_R2_ACCESS_KEY_ID` and `IWCI_R2_SECRET_ACCESS_KEY`, with a disk cache
in front. A private repository's token is `IWCI_GIT_TOKEN`. Credentials come
from the environment only. `--base` gives the changed paths that `paths:`
and `changed()` read. Caches (git, fetched packages, compiled modules,
objects) live under `--cache`, `$IWCI_CACHE_DIR` or `~/.cache/iwci`.

Jobs see `CI=true`, `HOME=/root` (unless they set their own), `IWCI_COMMIT`,
`IWCI_BRANCH`, `IWCI_REPO_ID`, `IWCI_JOB` and `IWCI_OUTPUT`, plus `PWD` set
to their `cwd`. That is the only way a plain WASI tool learns its working
directory: Go's `wasip1` port reads it, and a wasi-libc tool must (see
[Known limitations](#known-limitations)). A `run:` script and what it starts
also see `SHELL=/bin/bash` (unless the job or its environment sets one), and
a user database that agrees: `/etc/passwd` and `/etc/group` with `root`
(uid and gid 0, home `/root`, shell `/bin/bash`) and `nobody`, so Node's
`os.userInfo()`, Python's `pwd` and Go's `os/user` answer for the root a job
runs as. They sit under the environment's own files, so an environment that
brings a user database keeps it. Installers add their own: Go
jobs get `GOMODCACHE`, `GOPROXY=off`, `GOFLAGS=-mod=readonly` and friends,
Cargo jobs `CARGO_NET_OFFLINE=true`.

On a warm cache, a five-job pipeline (bash, a dynamic matrix, gofmt with a
commit) runs in about 0.35 s.

## Caching

Everything a run builds is cached under `--cache`, so the second run of a
commit, and of most commits after it, does almost nothing:

| What             | Kept under  | Keyed by                                                                                                                                                                                       |
| ---------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| git objects      | `git/`      | One repository per remote (the run's, and Composer packages fetched by commit). A commit already there costs no network.                                                                       |
| downloads        | `deps/`     | The lockfile's hash: npm `integrity`, Cargo `checksum`, Go's `h1:` from `go.sum` (checked over the zip's files), a pip lock's `sha256`, a Composer dist's `shasum`. Re-verified on every read. |
| installs         | `installs/` | What the install read. See below.                                                                                                                                                              |
| compiled modules | `modules/`  | The module's sha256 and the Wasmer version, compiler and CPU features.                                                                                                                         |
| tools from R2    | `objects/`  | sha256.                                                                                                                                                                                        |

**Installs** (`node_modules`, the `GOMODCACHE`, `vendor/`, a Python user
site) are cached whole. An install runs in a layer over the checkout that records every read
reaching the checkout, including files it looked for and did not find, and
keeps every write to itself. Both are stored, and a later run reuses the
result only when every recorded read still sees the same thing. So a bumped
lockfile, an edited patch file or a newly added `.npmrc` is a miss, without
any installer having to list its inputs. A runner process keeps recent
installs in memory and replays them by sharing buffers. On disk an install
is kept **unpacked** while it is in use: its files' bytes back to back
after an index, with a SHA-256 per 8 MiB. A new process restores one by
mapping the file and checking the hashes on every core, with no decoding
and no copy, so the restored files are page cache the kernel can reclaim
rather than the runner's own memory. Infrawrench's own `node_modules` (1.8
GB in 209,000 files) is read and checked in 0.16 s and in the workspace 1 s
later. An install nobody has used for `--keep-installs-unpacked` (default
`24h`, on `run` and `serve`) is **packed** into one zstd stream with a
checksum (371 MB for that one, about 3 s) and its unpacked copy removed;
the next use unpacks it again, 1.2 s more, and keeps both until it goes
unused again. `iwci serve` packs in the background at start and every ten
minutes, `iwci run` after its run. Each file's modification time is the
install's last use, so the window survives a restart. A damaged file of
either kind, or one an older runner wrote, is a miss. Disk use is bounded
per install (ecosystem, directory and options): the four most recently used
states of its inputs are kept, each unpacked at its full size while in use
(plus its packed copy, if it has been packed before) and packed after, so a
runner holds about the raw size of the installs it ran in the last day. In
the end-to-end run above, pnpm and Go together took 4.3 s cold (downloads,
unpacking and first compilation) and came from the cache in 0.25 s for the
whole pipeline.

## Limits

`--cpus <n> --jobs-per-cpu <k> --memory <size>` (or `IWCI_CPUS`,
`IWCI_JOBS_PER_CPU` and `IWCI_MEMORY`; flags win) limit the whole runner:

- **Slots.** The runner has `cpus × jobs-per-cpu` job slots, shared by
  every run it is doing, whatever repository or owner each is for. Four
  jobs share a vCPU by default: CI work waits on its subprocesses and its
  files often enough that a core interleaves several jobs better than it
  runs one, and the operating system time-slices them. `--cpus` also sizes
  the runtime's threads, the pool Wasmer compiles on and the installers'
  threads. A WASIX program's own threads and subprocesses (bash running
  `sed`) are not capped, because a script waiting on its child would
  deadlock. Default: the machine's cores.
- **`--memory`** is a budget across running jobs. A job reserves its
  `memory:` before it starts and waits until that fits, also when other
  runs hold the memory (any run giving memory back wakes the rest); a job
  asking for more than the whole budget is an error, not a hang. The reservation
  stands for the job's program and its files together. The frozen workspace
  snapshots are not counted: they are built once and shared. Default: no
  budget for `iwci run`; see `--memory-reserve` for `iwci serve`.
- **`--memory-reserve`** (or `IWCI_MEMORY_RESERVE`, `iwci serve` only,
  default `4GiB`) is what the server keeps for itself outside the job
  budget: the compiled modules and environments jobs are using, workspace
  snapshots, logs. Jobs run inside the server's process, so the job budget
  is held to the host's memory (or the service's cgroup `memory.max`, if
  lower) less this reserve, and without `--memory` it is all of that. A
  `--memory` larger than that is lowered, and the server says so when it
  starts. It logs its resident and anonymous memory against the budget
  every ten minutes, and at once when its anonymous memory beyond what jobs
  have reserved passes the reserve (`iwci serve: memory: ...`), and
  `/v1/capacity` reports the same numbers. Every half minute it lets go of
  what no job uses: finished runs' reports and logs five minutes after they
  end (the reports stay in the store), and the allocator's free memory. It
  fixes glibc's allocator thresholds (a 2 MiB trim threshold) so that
  includes the top of every thread's arena, which glibc's own adjustment
  stops trimming after the first large block it frees (#1066).
- **One V8 heap space for every Node job (#1063).** Every `node` of every
  job is an isolate of the runner's one V8, which compresses pointers into
  a single 4 GiB cage: the JavaScript heaps of all jobs together have 4 GiB
  of address space, whatever the job budget is. The bridge keeps an account
  of 3.5 GiB of it on top of each job's `memory:`, charging each heap what
  it has committed (reported after every garbage collection) and the room
  its last growth was promised. A `node` starts only while 512 MiB of the
  account stays free, and a heap that needs to grow past what is free waits
  for others; a waiting job is busy, not stalled. While the account is
  three quarters used, new heaps start small and grow in small steps. Room
  given back goes to the largest waiting heap first, so one heap gets what
  it needs to finish rather than each a little. A wait ends in vain after
  two minutes in which no heap gave any room back, or at once for the
  smallest heap when every live heap waits to grow (each holds its own, so
  then one has to give up), as an out-of-memory note saying the shared
  heap was full, not the job's `memory:`; such a job may pass when it runs
  again. Before this, the heaps of a few busy test jobs together filled the
  cage, and V8 failed inside a job well within its `memory:` ("young object
  promotion failed", "CALL_AND_RETRY_LAST"), losing the isolate. The log
  line and `/v1/capacity` say how much of the account is used. More
  `--memory` does not buy more JavaScript heap.
- **`--module-memory`** (or `IWCI_MODULE_MEMORY`, default `1GiB`) bounds
  the compiled modules kept in memory, counted as the size of their
  artifacts (their native code takes about a third again). Past it, a job
  that starts loads what it uses from the disk cache, which on ci-1 made a
  `node`, `python3` or `php` job start 0.15 to 0.25 s later and a `go run`,
  which loads several modules, about 0.45 s later. Wasmer frees a module's native code only with the engine it
  was loaded into, so modules are kept by generation: a set of jobs shares
  an engine, and once the modules loaded into it pass the limit, jobs that
  start get a fresh one; the old one is freed when its last job ends. A
  job never loses a module it is using. While an old generation still has
  jobs, the current one is not retired again, so at most two are kept.
- **A task cache lookup takes neither.** A `task-cache:` job holds a slot
  and its `memory:` only if it misses and runs (see
  [The task cache](#the-task-cache)).
- **`--stall-after`** (or `IWCI_STALL_AFTER`, default `5m`, `0` for
  never) stops a job that has written no output and used no CPU time for
  that long, instead of letting it hold its slot until its timeout. Its
  report's reason starts `stalled: no output and no CPU use for`, and its
  `execution.stalled_after` holds the seconds. CPU time is read from the
  CPU clock of every thread working for the job: the ones running its
  processes and their threads (bash and each command it spawns, libuv's
  pool, `worker_threads`), the one driving the job, and V8's worker
  threads while they run its garbage collection or background
  compilation. A process being instantiated counts as work as well, and
  so does a module being compiled, for every job at once: a compile holds
  the engine all jobs share, so the others wait for it. So a silent
  compile or test run keeps using CPU and is never stopped, and a process
  waiting on a wake-up that never comes (#938) is. Under 2% of one core
  over the window (six seconds in five minutes) counts as none: a hung
  program's timers still wake it, and each wake-up costs a guest about a
  quarter of a millisecond, so a hung Vitest used a third of a percent
  (#986). Waiting is not work: a job that only sleeps or waits on the
  network in silence for that long is stopped too, so print something now
  and then. Measured on Linux only; elsewhere jobs wait for their timeout.
  tsc jobs are not watched.

Inside a job, `memory:` holds its program memory (Wasmer's linear-memory
limit) and, separately, the files it writes, which live in memory: without
that a job could write past any limit. That is every file it writes, in
`/tmp` and in its environment's directories (`GOCACHE`) too. A write over it is refused before
any of it lands, and the job's report says so.

A Node job's V8 heaps, one per `node` and per worker thread, and the
`ArrayBuffer` memory they share are held to its `memory:` too. When a heap
cannot grow, its JavaScript is stopped and the runner ends the job; when a
`node` or worker thread cannot start, or a buffer is refused, the program
gets an error to handle (`ERR_WORKER_INIT_FAILED`, "Failed to initialize
runtime environment"). Either way, a job that fails then has
`out_of_memory: true`, a reason that says it ran out of its memory (beside
a timeout or a stall, when it hung waiting on a worker that never started),
and a note at the end of its stderr saying which of these happened (#964).
A Vitest suite that forks a `node` per test file needs room for that many
heaps at once (`--maxWorkers`). One job's heap running out never ends the
runner (#972, see `vendor/README.md`).

### A job that dies of a signal

A program killed by a signal says only which one: wasix-libc prints
`Program recieved fatal signal: Bad system call` and exits with 127 (or the
host ends it with 128 plus the signal), and by then nothing shows who sent
it (#955). The runner keeps, for every job, the last signals its processes
sent (`raise`, `kill`, `abort`) with the syscalls the sending thread made
just before and how its task began, the signals delivered to a handler,
and the syscalls that returned `ENOSYS` or `ENOTSUP`, and when a job ends
that way it adds them to the end of the job's stderr:

```text
Program recieved fatal signal: Bad system call
iwci: the job exited with 127 after a signal. What the runner saw of it (#955):
  0ms before the end, a guest called proc_signal(pid=1 sig=Signal::Sigsys)
    its thread's syscalls before that: proc_id x2 proc_parent stack_checkpoint x2 fd_filestat_get stack_checkpoint x6
    its thread's task had started 48 syscalls before
  0ms before the end, delivered to a handler: pid=1 signal=Signal::Sigsys
  0ms before the end, a guest called thread_signal(tid=1073741823 sig=Signal::Sigabrt)
    its thread's syscalls before that: proc_parent stack_checkpoint x2 fd_filestat_get stack_checkpoint x6 callback_signal fd_write
    its thread's task had started 50 syscalls before
  no syscall returned ENOSYS or ENOTSUP
```

The `thread_signal` with `Sigabrt` is `abort()`, which is how wasix-libc
ends a process after a fatal signal. A thread's task is the process or
guest thread it runs: it either `started` there or `resumed from a deep
sleep`, a wait long enough that wasmer-wasix unwound its stack, gave the
host thread back and later rebuilt it on another. `[task start]` among
the syscalls is where that happened, and `[deep sleep]` where a thread
went into one. A signal that was delivered
without a guest having sent it came from the host runtime, and one that
libc names but that was never delivered was raised inside the guest; the
lines say which. A job that fails any other way gets nothing added.

A crash is added the same way. When a command the script runs, or one
thread of a process, traps, the script may carry on and fail somewhere
else, and wasmer-wasix prints the trap only on the runner's own stderr;
the job's stderr gets `iwci: a process or thread of the job crashed, which
its exit status (1) does not say:` and the trap.

The lines are part of the job's stderr, so they are in the live log and
the report and are masked like the rest of it. The signal lines hold
syscall names, ids, signal names and error names, never the job's own
text; a trap's lines can name functions of the job's module.
`iwci-runtime/src/signals.rs` is the recorder, a `tracing` subscriber over
what wasmer-wasix already traces. It reads every syscall's return value;
`IWCI_SIGNAL_LOG=0` turns it off.

## HTTP API (`iwci serve`)

`iwci serve` runs the same runner as a service. Every route but `/healthz`
needs `Authorization: Bearer <key>`, with the key from `IWCI_SERVER_KEY`
(at least 32 characters). It listens on loopback unless `--listen` says
otherwise. Runners are meant to sit behind a plain load balancer: reports,
billing records and caches go to the shared object store, so any runner can
answer for any owner, and a full runner says so instead of queueing.

| Route                                   | Does                                                                                                                                                                    |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /healthz`                          | `200 ok`, unauthenticated.                                                                                                                                              |
| `GET /v1/capacity`                      | Slots (total, free), active runs, memory reserved and waited for, the process's own memory (below), and V8's out-of-memory losses (below).                              |
| `POST /v1/runs[?wait=true]`             | Runs a request (below): `202` with an id, or with `wait=true` the result when done.                                                                                     |
| `GET /v1/runs/{id}[?owner=]`            | A run's state and report, and while it runs its `progress` (each pipeline's jobs and their states so far); `?owner=` reads it from the store when this runner lacks it. |
| `GET /v1/runs/{id}/logs`                | The run's log as Server-Sent Events: everything so far, then live until it ends.                                                                                        |
| `POST /v1/runs/{id}/cancel`             | Cancels a run on this runner, or only some of its pipelines (below).                                                                                                    |
| `GET /v1/runs/{id}/jobs[/{job}]`        | The run's cloud jobs and their state, nothing secret (below).                                                                                                           |
| `POST /v1/runs/{id}/jobs/{job}/claim`   | Claims a cloud job for its executor: the spec, the environment with its secrets, a claim token (below).                                                                 |
| `POST /v1/runs/{id}/jobs/{job}/log`     | A cloud job's output; every call renews the claim's lease.                                                                                                              |
| `POST /v1/runs/{id}/jobs/{job}/finish`  | How a cloud job went.                                                                                                                                                   |
| `GET .../jobs/{job}/inputs?claim=`      | A cloud job's input artifacts, a tar archive. The claim token instead of the key.                                                                                       |
| `PUT .../jobs/{job}/artifacts?claim=`   | A cloud job's own artifacts, a tar archive. The claim token instead of the key.                                                                                         |
| `POST /v1/concurrency`                  | The pipelines a request (below) would run and each one's `concurrency:` group, without running anything (below).                                                        |
| `POST /v1/prepare`                      | Warms a request's clone, dependency installs and tools without running a job.                                                                                           |
| `GET /v1/storage/{owner}[?quota=]`      | The owner's storage (caches and downloads), total and per repository, against its quota.                                                                                |
| `DELETE /v1/storage/{owner}/{repo-id}`  | Deletes one repository's caches, never its downloads (below), and answers what went.                                                                                    |
| `GET /v1/usage/{owner}[?month=YYYY-MM]` | The owner's billed usage for a month, total and per repository.                                                                                                         |
| `POST /v1/schedules/read`               | A repository's scheduled pipelines on a branch: file, name, crons and the file's text.                                                                                  |
| `POST /v1/drain`                        | Stops taking runs; running ones finish. `/v1/capacity` shows `draining`.                                                                                                |

A request body (for `runs` and `prepare`):

```json
{
  "repo": "https://github.com/acme/web",
  "branch": "main",
  "sha": "optional: a commit; without it, the branch's head",
  "event": "push, pull-request or schedule",
  "base": "optional: commit to diff against for paths: and changed()",
  "owner": "optional: defaults to github.com-acme",
  "repo-id": "optional: defaults to web",
  "default-branch": "main",
  "storage-quota": "10GiB, or bytes; overrides the server's --storage-quota",
  "pipeline": "optional: a pipeline file's text, run instead of the repository's",
  "ref": "optional: the ref the commit is reachable from, such as refs/pull/12/head; default refs/heads/<branch>",
  "token": "optional: for a private repository; never stored or echoed",
  "secrets": { "NPM_TOKEN": "optional: never stored or echoed, masked in output" },
  "vars": { "REGION": "optional: for ${{ vars.<name> }}" },
  "no-task-cache": "optional: true runs every task-cache: job; passes still save",
  "trusted": "optional: false for a pull request from a fork; default false for a pull request, true otherwise",
  "lent": "optional: connections, SSH keys and resource outputs lent to the jobs, by name (below)"
}
```

`lent` is what the app lends the run's jobs (see
[Connections, SSH keys and resources](#connections-ssh-keys-and-resources)).
Like `secrets` it is never stored, echoed or put in a plan, every secret in
it is masked, and an untrusted run is given none of it:

```json
{
  "connections": {
    "Production cluster": {
      "env": { "KUBECONFIG": [{ "text": "/root/.kube/config" }] },
      "files": [
        {
          "path": "/root/.kube/config",
          "mode": "600",
          "content": [
            { "text": "apiVersion: v1\nkind: Config\nusers:\n- name: ci\n  user:\n    token: " },
            { "secret": "<a short-lived token>" }
          ]
        }
      ]
    },
    "staging": { "refused": "staging is not lent to CI for acme/web on feature/x" }
  },
  "ssh-keys": {
    "deploy": {
      "files": [{ "path": "/root/.ssh/id_deploy", "content": "<the private key>" }]
    }
  },
  "resources": {
    "prod-db": {
      "outputs": { "connectionString": "<value>" },
      "refused-outputs": { "adminPassword": "adminPassword of prod-db is not granted to CI" }
    },
    "r2-assets": { "env": { "AWS_ACCESS_KEY_ID": "<value>", "AWS_SECRET_ACCESS_KEY": "<value>" } },
    "stripe-key": { "refused": "stripe-key is not granted to CI for acme/web" }
  }
}
```

- **Values.** A string is secret as a whole. A list of parts says which
  pieces are: `{ "text": ... }` is shown as it is, `{ "secret": ... }` is
  masked. Each value is at most 64 KiB, without a NUL byte.
- **Files.** `path` is absolute, without `..`, and not under `/iwci`,
  `/dev`, `/proc`, `/usr/local/lib/iwci`, `/tmp/workflow` or the job's
  clone (a job whose file would land in its clone fails); `mode` is octal,
  default `600`; up to 16 per entry. Two entries the same job names that
  write one path (an SSH host's `~/.ssh/config` entry and a key's) are
  joined in the order the job lists them, connections before keys, with
  the stricter mode.
- **Variables** may not be `IWCI_*`. A connection's and key's come first,
  then `env-from`'s, then the job's own `env:`, which wins.
- **Refusals.** `refused` (1 to 1024 characters) instead of the material,
  or `refused-outputs` per output, is what a job that names it fails with.
  A name the job uses that `lent` does not have fails it as "connection
  `X` was not lent to this run".
- Up to 64 entries of each kind; the whole body is at most 1 MiB.

- **Capacity.** A run is admitted when a slot is free and fewer runs are
  active than there are slots; otherwise `429` with `Retry-After` and the
  current capacity, so the balancer can try another runner. `prepare` takes
  a slot while it works and is refused the same way.
- **Memory.** `memory_total` and `memory_used` are the job budget and what
  running jobs have reserved of it. `memory_waiting` is the memory asked
  for by jobs that are ready but not started (waiting for memory, or for
  one of their run's workers), across every run; a job whose `needs` have
  not finished counts only once it is ready. The proxy places runs by these
  three (`app/packages/ci-proxy`, "Placement"); a runner from before
  `memory_waiting` leaves it out. Beside them, each `null` where it
  cannot be read: `memory_host` (the host's memory, or the service's
  cgroup limit), `memory_reserve` (`--memory-reserve`), `memory_resident`
  and `memory_anonymous` (the process's resident memory and the part of it
  that is not backed by a file, jobs included) and `modules_resident` (the
  compiled modules in memory, counted as their artifacts' size). All in
  bytes. See [Limits](#limits).
- **V8 heap space.** `v8_heap_space_total` and `v8_heap_space_used` are
  what the Node jobs' V8 heaps may use together and what the account says
  they use now (every heap's committed memory and promised growth, and lost
  isolates' heaps), in bytes;
  `v8_heap_space_waits` counts the times a `node` or a growing heap waited
  for room since the process started, and `v8_heap_space_refusals` the
  times it waited in vain. See [Limits](#limits).
- **V8's out-of-memory losses.** `/v1/capacity` also says what V8 running
  out of memory where it cannot recover has cost the process since it
  started: `v8_lost_isolates` (isolates abandoned, with their memory, which
  no job's `memory:` counts any more), `v8_parked_threads` (threads parked
  for good), `v8_parked_worker_threads` (those of them that were V8's
  worker threads, a pool every Node job shares) and `v8_lost_heap` (bytes
  of the V8 heap space the abandoned isolates hold). The vendored bridge keeps
  each such out-of-memory to its job at that cost
  ([vendor/README.md](vendor/README.md)), and the server logs the counts
  whenever they grow and restarts itself once they are too high (see
  [Deploying, draining and updating](#deploying-draining-and-updating)).
- **Logs.** For each pipeline, `pipeline-started` (its jobs: `key`, `name`,
  `needs` and the `ids` their entries report under, or `null` while a matrix
  waits on another job), then `job-started`, `output` (one line, with its
  stream) and `job-finished` events; then `run-finished`. A finished job's
  report carries its `needs` too. A client that connects late
  gets the backlog first. Up to 8 MiB of output is kept per run; past that a
  `truncated` event says so and job events still flow. A finished run's log
  is kept for five minutes after it ends; its report is read from the store
  after that, by `GET /v1/runs/{id}` on the runner that ran it or with
  `?owner=` on any. A comment every 15 s
  keeps idle connections open through proxies.
- **Billing.** Each run writes a record to
  `usage/<owner>/<yyyy>/<mm>/<started>-<id>.json`: the run, its jobs, and
  its usage. A job is charged its wall time at `1 / jobs-per-cpu` of a vCPU
  (`vcpu_seconds`) and the memory it reserved over that time
  (`memory_gib_seconds`). A cloud job ran on the customer's own account: it
  is in none of those, but in `external_jobs` and `external_seconds` (from
  its claim to its end), and its line in `jobs` is `"external": true` with
  that time as `duration_ms`. Failed and errored runs are recorded too,
  with no usage. The record's `schema` is 3: 2 added a job `status` of
  `cancelled` (1 had only `passed`, `failed`, `skipped` and `error`), 3 the
  external fields. Storage is read from `GET /v1/storage/{owner}`, for billing by
  GB-month: `used_bytes` is caches and unexpired downloads together, with
  `entries` (cache entries), `download_bytes` and `downloads` beside it and
  the same four per repository under `repos`.
- **Quotas.** An owner's caches and downloads across all its repositories
  are held to its storage quota: the request's `storage-quota`, else the
  server's `--storage-quota` (default 10 GiB). Only caches are evicted to
  make room.
- **Run ids.** A finished run's result carries its `run_id`, which is what
  its downloads are stored under.
- **Cancelling.** `POST /v1/runs/{id}/cancel` with no body, or `{}`,
  cancels the whole run; `{ "pipelines": [".infrawrench/ci/test.yml"] }`
  cancels only those pipeline files (a pipeline sent as `pipeline` text is
  `request`): the one running is stopped and the others never start. It
  answers `202 { "id", "state": "cancelling" }` for a run running on this
  runner, `200 { "id", "state": "finished" }` for one it has already
  finished (nothing changes), and `404` otherwise; asking twice is
  harmless. Stopping takes as long as a timeout's (at most a few seconds,
  services included). The run's result then has `"cancelled": true` and
  `"passed": false`, its stopped and never-started jobs
  `"status": "cancelled"` (see [Concurrency](#concurrency)), and the live
  log's `job-finished` events say `cancelled` and `run-finished` carries
  `cancelled`.
- **Concurrency groups, and what to lend.** `POST /v1/concurrency` takes
  the same body as a run and resolves it as a run would (the commit, the
  pipeline files or `pipeline`, `base` for `paths:`), without a job slot,
  answering only the pipelines the event triggers:
  `{ "commit", "pipelines": [{ "file", "name", "concurrency": { "group", "cancel-in-progress" }, "jobs": [...] }] }`,
  with `"concurrency": null` for a pipeline without one. `jobs` lists each
  job key that runs on a cloud account or is lent anything, which is what
  the app resolves before it dispatches the run:
  `{ "key", "cloud"?: { "provider", "kind", "connection"?, "machine"?, "image"?, "region"?, "gpu"? }, "connections"?: [{ "name", "namespace"? }], "ssh-keys"?: [...], "resources"?: { "<name>": ["<output>", ...] }, "env-from"?: [...] }`
  (a key is left out when empty; `cloud` holds the block as written, its
  `machine`, `image`, `region` and `gpu` possibly with `${{ matrix }}`
  still in them; `resources` includes what the job's services read). One
  route rather than a second, because the app already calls it before every
  dispatch, and a second would clone and parse the commit again. Files that
  do not parse are left out (the run reports them). `400` for a bad
  request, `422` when the commit cannot be fetched. `POST
/v1/schedules/read` carries each scheduled pipeline's `concurrency` the
  same way.
- **Cloud jobs.** See [Cloud jobs: the executor's routes](#cloud-jobs-the-executors-routes).
- **Without the task cache.** A request with `"no-task-cache": true`, or
  `iwci run --no-task-cache`, runs every `task-cache:` job instead of
  replaying a passing run's entry, and each says so in its cache lines. A job that
  passes still saves under its key, so the next run that reads the task
  cache is cached again. `cache:` entries restore as usual; to drop those
  too, clear the repository's caches.
- **Clearing a repository's caches.** `DELETE /v1/storage/{owner}/{repo-id}`
  deletes everything under `caches/<owner>/<repo-id>/`: every branch's and
  pull request's `cache:` and `task-cache:` entries and their `restore-keys`
  pointers, which is what `GET /v1/storage/{owner}` counts for that
  repository. It answers
  `{ "owner", "repo-id", "deleted_objects", "deleted_bytes", "deleted_entries" }`.
  Its downloads (`artifacts/`) keep their own retention and are not
  touched. Other repositories, other owners, run reports, billing records and each
  runner's own caches (git objects, installs, compiled modules) stay. A run
  saving at the same moment can leave its new entry behind.

### Cloud jobs: the executor's routes

A cloud job that is ready (its needs done, its `if:` true) waits on the
runner that has its run as `external`: the run's `progress` shows its
`status` as `external` with its `cloud` block, the live log sends
`job-external` (`{ "job", "name", "cloud" }`), and it takes no slot or
memory. The executor (the app, through the proxy) then calls these. `{job}`
is the job's id, percent-encoded as one path segment (`build%5Bapp%2Fweb%5D`
for `build[app/web]`). Every body and answer is JSON unless it says tar.

- `GET /v1/runs/{id}/jobs` answers `{ "run", "jobs": [<spec>, ...] }`, and
  `GET /v1/runs/{id}/jobs/{job}` one `<spec>`: nothing secret in either.

  ```json
  {
    "run": "<run id>",
    "job": "image",
    "name": "image",
    "pipeline": ".infrawrench/ci/build.yml",
    "state": "external | claimed | finished | cancelled | lost | timed-out",
    "cloud": { "provider": "gcp", "kind": "build", "machine": "e2-highcpu-8" },
    "commit": {
      "repo": "https://github.com/acme/web",
      "sha": "...",
      "branch": "main",
      "ref": "refs/heads/main"
    },
    "clone": { "depth": 1, "into": "/app" },
    "cwd": "/app",
    "script": "docker build ...",
    "env_keys": [
      "CI",
      "IWCI",
      "HOME",
      "IWCI_COMMIT",
      "IWCI_BRANCH",
      "IWCI_REPO_ID",
      "IWCI_JOB",
      "TOKEN"
    ],
    "secret_env": ["TOKEN"],
    "files": [{ "path": "/root/.kube/config", "mode": "600", "bytes": 512 }],
    "timeout_secs": 1800,
    "deadline_secs": 2400,
    "lease_secs": 300,
    "outputs": ["digest"],
    "changes": "ignore | fail",
    "inputs": { "files": 3, "bytes": 1234 },
    "artifacts": { "paths": ["/app/out/sbom.json"], "max_bytes": 1073741824 }
  }
  ```

  `clone` is `null` for a job without one, `depth` a number or `"full"`;
  `inputs` is `null` when the jobs it needs kept nothing, `artifacts` when
  it keeps nothing. The commit's `repo` never has credentials in it.

- `POST /v1/runs/{id}/jobs/{job}/claim` with `{ "executor"?: "<what runs
it, shown on its report>" }` answers `200` with the spec and, **secret**:
  `claim` (the token for the calls below), `env` (every variable, with
  secrets, resource outputs and lent values filled in), `files` (`[{ "path",
"mode", "content" }]`, lent files with their content); `inputs.url` and
  `artifacts.url` are the two token routes below, with the token in them.
  `409 { "error", "state" }` when it is already claimed or has ended.
  The claim's lease is 5 minutes.
- `POST .../log` with `{ "claim", "stream"?: "stdout" | "stderr", "text"?: "<output, any number of lines>" }`
  answers `{ "state": "claimed", "lease_secs" }`. An empty `text` is a
  heartbeat; every call renews the lease. The runner splits text into lines
  and masks every secret and lent value before the live log or the report
  sees it. A report keeps 16 MiB of each stream.
- `POST .../finish` with
  `{ "claim", "status": "passed" | "failed" | "error", "exit_code"?, "output"?: "<the text of $IWCI_OUTPUT>", "error"?: "<why>", "timed_out"?: false, "changes"?: [{ "path", "kind": "added" | "modified" | "deleted" }] }`
  answers `{ "state": "finished" }`. `passed` checks `output` as a local
  job's `$IWCI_OUTPUT` is checked (an undeclared name fails the job) and,
  for `changes: fail`, fails it for any change; `failed` fails it with
  `error` or the exit code; `error` is for an executor that could not run
  it (no opted-in connection, a machine that would not start). Without
  `claim`, only an unclaimed job can be finished, and only with `status:
error`. Outputs, `error` and the log are masked.
- `GET .../inputs?claim=<token>` answers a tar archive of the artifacts
  of the jobs it needs, paths relative to `/` (`app/dist/app.txt`),
  oldest job first, so a later file wins when extracted with `tar -xf - -C
/`.
- `PUT .../artifacts?claim=<token>` takes a tar archive of its artifacts,
  paths relative to `/`, every entry at or under one of its `artifacts:`
  paths (a directory on the way to one is fine): files, directories and
  symbolic links, together within the run's `scratch:` room. Another upload
  replaces it. They are handed on only if the job passes.
- **Who may call.** The first three need the runner's key. The two token
  routes take the claim's token instead of the key, so the app can hand the
  URLs to the job's machine; a wrong token is `403`, and both stop working
  when the job ends.
- **How it ends.** `finish`; or the run (or pipeline) is cancelled; or its
  lease runs out (`lost`); or it is still claimed `timeout:` plus 10
  minutes after the claim (`timed-out`); or nobody claims it in its
  `timeout:` (at least 10 minutes, `lost`). From then on every call about it
  answers `409 { "state" }`, and `404` once its run has finished: either way
  the executor tears the machine down.
- An untrusted run's cloud jobs fail at once and are never listed.

### Warm builtins

`iwci serve` downloads and compiles every published builtin and environment
when it starts, then again every `--warm-every` (default `10m`), so a job
never waits on a cold tool: the newest release of each `major.minor`,
which covers every pin a pipeline can write. Blobs stay in the disk cache
in front of R2 (`<cache>/objects`) and compiled code in the module cache
(`<cache>/modules-*`); neither is ever evicted, so give the cache directory
a persistent disk. Warming does not keep anything in memory: a job loads
the modules it uses from the disk cache, and they stay in memory within
`--module-memory` (see [Limits](#limits)). Before #1035 every warmed
module stayed in memory for the life of the process, 4.6 GB with the 16
builtins and environments published then. Repository tools warm on first use.
`/v1/capacity` reports the last round under `warm`. `--no-warm` turns it
off.

## Scheduled runs

`app/packages/ci-proxy` is a Cloudflare Worker that sits in front of the
runners and owns schedules, because a Cron Trigger fires once for a whole
Worker, where every runner in a pool keeping its own clock would fire each
schedule once per runner. Its README has the routes; the short version:

1. `PUT /v1/schedules` on the proxy registers a repository. The proxy asks a
   runner (`POST /v1/schedules/read`) which pipelines on the default branch
   have `on.schedule`, and stores their crons and text in D1. Tokens are
   refused: a scheduled run of a private repository uses the runners'
   `IWCI_GIT_TOKEN`.
2. Once a minute the proxy re-reads registrations older than ten minutes
   (twenty per minute at most), then matches every stored cron against the
   minute. A due pipeline is claimed in D1 for that minute first, so a
   repeated trigger fires nothing twice, and then sent as a normal run with
   `event: schedule` and the stored text as `pipeline`.
3. A minute that finds every runner full is recorded as `no-capacity` and
   not retried. Billing is the runners' own usage record, as for any run.
4. Of a group's pipelines due in the same minute only the last fires. A
   scheduled run of the group still going (started in the last 6 hours)
   is cancelled when the pipeline has `cancel-in-progress`; otherwise the
   fire is skipped and recorded as `concurrency: waiting for ...`, never
   queued, as a full pool is. Pushes and pull requests, which the app
   dispatches, are not counted, and do not wait for scheduled runs.

## Known limitations

- **Pipelines in `env:` scripts.** WASIX bash reports only the last
  command's exit status: `false | cat` succeeds even under `pipefail`, and
  `PIPESTATUS` holds one entry. A plain failing command, or one inside
  `$(...)`, does stop the script. This is in Wasmer's bash/WASIX process
  handling, not in the runner.
- **Coreutils `dd` cannot create a new output file** under WASIX ("No
  such file or directory"); it writes into one that exists, and
  `head -c N /dev/zero > file` creates one. Writing to stdout fails too,
  because it tries to truncate it.
- **Plain WASI tools resolve relative paths from `/`.** A `wasm32-wasip1`
  tool built on wasi-libc (Rust, C, TinyGo) starts in `/` whatever the
  job's `cwd`, so `.` is the root of the job's file system. The `cwd`
  reaches it only as `$PWD`: a `repo:` tool joins relative paths onto
  `$PWD`, or the job passes absolute paths. WASIX tools (oxfmt) ask the
  runtime for their working directory and Go's `wasip1` port reads `$PWD`,
  so neither is affected. Preopening the `cwd` as `.` cannot fix this, so
  do not retry it
  ([#906](https://github.com/Infrawrench/Infrawrench/issues/906)):
  wasi-libc strips `/` and `.` from preopen names, so both become the
  empty prefix; it makes a relative path
  absolute against its own cwd, which is always `/`, before looking it up,
  so `foo` and `/foo` arrive as the same path; and of equal matches it
  takes the preopen registered last. With `.` before `/` nothing changes;
  with `.` after `/` relative paths work but every absolute path
  (`/tmp/workflow`, a tool's data files) resolves inside the `cwd`. The
  runtime test `a_command_sees_only_the_root_preopen_and_its_cwd_as_pwd`
  pins the layout.
- **A refused write reads as an I/O error** to the program (`EIO`), not
  "no space left", because Wasmer does not carry the error kind through.
  The job's report names the limit.
- **Not run end to end yet:** the real TypeScript module (the runtime's
  `tsc-host` tests use a module written to the same ABI), oxfmt for WASIX,
  the `node` feature (implemented, never compiled here), real R2 (including
  its `DELETE` and listed sizes, which quota eviction uses) and a real
  HTTPS git remote with a token.
- **Quotas are enforced per save**, by listing the owner's caches; two
  runners saving for one owner at the same moment can overshoot by one
  entry until the next save.
- **The server keeps live state in memory**: active runs and log hubs. A
  restarted runner forgets them; finished reports and records are in the
  store.
- **Runner-local caches** (git, downloads, installs, compiled modules)
  are not evicted yet and count against no owner; give the cache directory
  its own disk.
- **File modes reach scripts and Node, not other programs.** The runner
  keeps a mode per file (see [File modes](#file-modes)), but WASIX has no
  way to pass one to a program, so only the `chmod`, `stat` and `mktemp`
  commands and Node (whose C library is built here to ask) see them:
  coreutils' `ls -l` shows every file as `rwxrwxrwx`, other WASIX programs
  read no permission bits, and nothing enforces a mode. A `changes: commit` keeps each file's original
  mode (a new file is `100644`).
- **No hard links.** `link()` fails with `EPERM` ("Operation not
  permitted"), as on a file system without them, and leaves nothing
  behind: `ln f g` fails, and a program that falls back when it cannot
  link copies or renames instead, as Git does
  ([#1052](https://github.com/Infrawrench/Infrawrench/issues/1052)).
  Symbolic links work.
- **Submodules** are skipped with a warning, and Cargo `git` dependencies
  are reported rather than vendored.
- **Pushing** the commit a `changes: commit` job makes is left to the
  integration: the commit is written to the git cache, and
  `RemoteCache::export_objects` lists its objects for the forge's API.

### Deploying, draining and updating

`infra/ci-runners` (Terraform) provisions runner hosts over SSH and tells
the proxy about them; its README has the steps. Two things in `iwci serve`
make that safe to do while jobs run:

- **Draining.** SIGTERM, SIGINT and `POST /v1/drain` stop new runs from
  being admitted (`429`, and `draining` in `/v1/capacity`, which the proxy
  reads to place work elsewhere) and let the running ones finish; on a
  signal the server then exits 0. A systemd unit's stop timeout therefore
  has to cover the longest job (60 minutes).
- **Updating itself.** With `--update-channel stable`, the server reads
  `releases/iwci/channels/stable.json` every `--update-every` (default 5m).
  It only believes a manifest signed by the release key
  (`IWCI_RELEASE_PUBLIC_KEY`): every host's store credentials can write to
  the bucket, and an unsigned channel would let one host push a native
  binary to all of them. When the channel names another version, the server
  downloads that version's binary for its platform, checks the signed size
  and sha256 and that it reports the right version, drains, and `exec`s it
  with the same arguments. The process id stays the same, nothing is
  killed, and pointing the channel back at an older version rolls back.
- **Restarting after V8 runs out of memory.** Each out-of-memory the bridge
  keeps to its job costs the process a parked thread and an abandoned
  isolate for good. Once that has cost one of V8's worker threads, whose
  pool is sized to `--cpus` and shared by every Node job,
  `--restart-after-lost-isolates` isolates (default 8; `0` for never), or
  lost isolates whose heaps hold a quarter of the V8 heap space every Node
  job shares (see [Limits](#limits); those heaps are never freed, and the
  space is all the JavaScript heap the process has), the server drains and
  `exec`s its own binary with the same arguments, the way an update does,
  and starts again with none lost.

Releases are published with `iwci release <binary> --version <v>
[--target x86_64-linux] [--channel stable]` (signing key from
`IWCI_RELEASE_SIGNING_KEY`), normally by `.github/workflows/ci-runner-release.yml`
when `ci-runner/VERSION` changes. `iwci release-keygen` makes a key pair,
and `iwci version` prints the build's version (`IWCI_VERSION` at build
time). A version's binary is uploaded once and never replaced, and
publishing a target of the channel's current version keeps only the other
targets the release key signed. `iwci release-status --version <v>
[--target ...] [--channel stable]` writes nothing and prints one word:
`published` (the signed channel lists that target for that version),
`uploaded` (the binary is in the store but not on the channel), `absent`,
or `superseded` (the channel is signed for a later version). The workflow
runs it per target and publishes only what is missing, so running it
again finishes a version one of whose targets failed, and tags
`ci-runner-v<version>` once both are out.

## Storage layout (R2)

The `iwci-store` crate documents the exact key layout and manifest formats;
the short version is that everything executable is content-addressed under
`blobs/sha256/`, manifests name blobs by hash, builtins and environments
live under their own prefixes, and a repository's uploaded tools live under
`repos/<repo-id>/tools/`, which is the only place a `repo:` reference looks.
Uploading is not implemented: the layout is the contract the upload API
will write to. Job caches, and environment caches (keyed
`env-cache/<environment>@<version>/<arch>/<cache>/<job>`), are under
`caches/<owner>/<repo-id>/<scope>/`,
downloads under `artifacts/<owner>/<repo-id>/<run-id>/` (see
[Downloads](#downloads)), billing records under `usage/<owner>/`, run reports under
`runs/<owner>/`, and releases of `iwci` itself under
`releases/iwci/<version>/<target>` (immutable) with signed channel
manifests at `releases/iwci/channels/<channel>.json`.

## Crates

| Crate          | Does                                                                                |
| -------------- | ----------------------------------------------------------------------------------- |
| `iwci-spec`    | The pipeline file: parse, validate, expand, interpolate.                            |
| `iwci-vfs`     | Snapshots and per-job overlays over Wasmer's `virtual-fs`.                          |
| `iwci-git`     | Shallow fetch with a persistent cache, checkout into a snapshot, commits.           |
| `iwci-deps`    | pnpm, Go, Cargo, pip and Composer installers over a verifying, caching fetcher.     |
| `iwci-store`   | R2 and local object stores, manifests, tool resolution.                             |
| `iwci-runtime` | Wasmer: compiled-module cache, WASI/WASIX commands, the tsc-host ABI, environments. |
| `iwci`         | The scheduler and the `iwci` command.                                               |

## Development

```sh
cd ci-runner
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

Tests never reach the network. The ones that need real artifacts say which
environment variable points them at the files: gofmt (`IWCI_TEST_GOFMT_WASM`)
and the bash environment (`IWCI_TEST_WEBC_DIR`, an environment's `dist/`
directory) skip without one, and the TypeScript module and live registries
are `#[ignore]`d. `IWCI_REQUIRE_FIXTURES=1` turns those skips into failures,
which is how CI runs them.

### Testing the builtins

`builtins/test.sh` tests builtins the way a user meets them: it builds each
with its own `build.sh`, publishes it to a throwaway store with `iwci
publish`, and runs pipelines through `iwci run` against a fixture
repository that has something to pass and something to fail for each tool.

```sh
cargo build -p iwci
bash builtins/test.sh                        # gofmt and bash
bash builtins/test.sh typescript oxfmt       # needs their toolchains
bash builtins/test.sh python php             # need the internet (pip, Composer)
bash builtins/test.sh go                     # every minor; go@1.27 for one
bash builtins/test.sh bash kubectl           # needs Go's archive and modules
bash builtins/test.sh bash openssh           # needs ssh-keygen here, and the internet
cargo build -p iwci --features node && bash builtins/test.sh bash-node
```

A job whose key ends in `-passes` must pass and one ending in `-fails` must
fail; a tool that will not resolve or start is an error and fails the test.
`SKIP_BUILD=1` reuses what is already in `dist/`.

Every environment carries Git, which `builtins/environments/git/build.sh`
builds from source (two or three minutes); a build already in
`dist/package/git/` is used as it is, and CI keeps one per architecture in
its cache, keyed by that directory.

In CI, `ci-runner.yml` builds and tests gofmt and bash on every change.
`ci-runner-builtins.yml` builds and tests typescript, oxfmt and bash-node,
which each need a large toolchain, python and php, whose tests install
from the internet, each Go minor and OpenSSH, on x86_64 and on ARM64, on changes to
the builtins, the runtime or the store, and
nightly, because those builds resolve crates and a WASIX toolchain that
this repository does not pin byte for byte. The Node job
runs on x86_64; `ci-runner.yml`'s "Build with Node on ARM64" job builds the
`node` feature on ARM64 on every change, so the second architecture cannot
break unnoticed.
