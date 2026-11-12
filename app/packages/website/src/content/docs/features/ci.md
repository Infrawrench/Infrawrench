---
title: CI
description: Run your repositories' pipelines on every push and pull request, each job in its own WebAssembly sandbox, with results on GitHub, maintainer approval for pull requests from forks, secrets they never see, and usage billed by the second.
sidebar_order: 14
---

Infrawrench CI runs the pipelines in a repository's `.infrawrench/ci/` folder on every push and pull request. Each job runs in its own WebAssembly sandbox over a snapshot of the commit, so a job starts in the time it takes to load a program that is already compiled: there is no container to pull, no clone per job and no dependency install per job.

CI is being rolled out to organizations one at a time. Until it is on for yours, the **CI** page says so and nothing runs.

<insert [The CI tab: the GitHub accounts card with two accounts (one with "Run CI" ticked), the usage card for this month, and the runs table with a passed push to main, a running pull request, and a pull request from a fork marked "Awaiting approval" with Approve and Reject buttons] here>

## Turn it on for your repositories

1. Open **CI** from the sidebar on the web or desktop app (cloud mode).
2. Under **GitHub accounts**, choose **Connect a GitHub account**. GitHub asks which organization or user to install the Infrawrench GitHub App on, and which of its repositories it may see. You come back to the CI page when you're done. If the App is already connected for [Workflows](./workflows.md) or [GitHub issues](./github-issues.md), the account is listed already.
3. Tick **Run CI** for each account whose repositories should run CI.
4. Add a pipeline to a repository, for example `.infrawrench/ci/tests.yml`:

```yaml
name: Tests

on:
  push:
    branches: [main]
  pull-request: {}

workspace:
  deps:
    - pnpm

jobs:
  typecheck:
    using: builtin:typescript@7.1
    args: [--noEmit]

  lint:
    using: env:bash-node@24
    run: pnpm run lint
    needs: [typecheck]
```

The next push runs it. Each run shows on the commit or pull request on GitHub as a check, **Infrawrench CI / push** or **Infrawrench CI / pull request**, so a branch with an open pull request shows both. A run whose pipelines all skip that event (for example `on.push` limited to `main`) shows as skipped, not passed. The check's **Details** link opens the run in Infrawrench.

Each job has its own check too, named after its pipeline and the event (**Test / build (pull request)**), which turns from waiting to running to passed or failed as the job does. A matrix's entries, or a `packages:` job's packages, share one check that lists each of them. Require the run's check (**Infrawrench CI / pull request**) in a branch protection rule: it covers every job, whichever jobs a change adds or removes.

Choosing accounts takes the `ci:write` permission; everyone in the organization can see runs (`ci:read`). See [Roles and permissions](../team-and-billing/roles-and-permissions.md).

## Environments

A job either runs a built-in tool (`using: builtin:typescript@7.1`) or runs a bash script (`run:`) in an environment:

| Environment                    | What it has                                                                      |
| ------------------------------ | -------------------------------------------------------------------------------- |
| `env:bash@5`                   | bash, coreutils, sed, grep and findutils                                         |
| `env:bash-node@24`             | the same, plus `node` (Node 24 compatible), `npm` and `pnpm`                     |
| `env:python@3.13`              | the same as `env:bash@5`, plus Python 3.13 with `pip`                            |
| `env:php@8.1` to `env:php@8.5` | the same as `env:bash@5`, plus PHP 8.1, 8.2, 8.3, 8.4 or 8.5 and Composer        |
| `env:go@1.23` to `env:go@1.27` | the same as `env:bash@5`, plus Go 1.23, 1.24, 1.25, 1.26 or 1.27 (`go`, `gofmt`) |
| `env:postgres@18`              | the same as `env:bash@5`, plus PostgreSQL 18.4, for a job's `services:`          |

In `env:python@3.13`, `pip install` works for pure Python packages and for packages with compiled code that have a WebAssembly build on Wasmer's wheel index, such as numpy, pandas, pydantic and cryptography. A package that has to be compiled while it installs does not, and `python -m venv` is not available: packages install into the job's own copy of Python. pip downloads while the job runs, so leave the job's network on (no `network: false`).

In the PHP environments, `composer install` and `vendor/bin/phpunit` work in the job's directory as they do on a developer's machine, and the common extensions are built in (intl, mbstring, PDO for SQLite, MySQL and PostgreSQL, curl, gd, sodium, zip and more). There is no Xdebug or PCOV, so no code coverage. Composer downloads while the job runs, too.

```yaml
jobs:
  test:
    using: env:python@3.13
    run: |
      pip install -r requirements.txt
      pytest
```

In `env:go`, `go build`, `go vet`, `go test` and `go run` work, with your module's dependencies installed before the job from `go.sum` (`deps: [go]`). The standard library comes compiled, so a first build compiles only your own packages. Go programs run as WebAssembly here: cgo, the race detector and signals are not available, and a `go.mod` that asks for a newer Go than the environment's fails rather than downloading one, so pick the version your `go` line names or a newer one. Tests can listen on the job's own loopback and reach the internet.

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

### Background services

`services:` starts programs a job's tests need, such as a database or your own API server, before the job runs, and stops them when it ends. Each runs inside the job, on the job's private network, so its name works as a host name (`postgres:5432`) and its ports never clash with another job's:

```yaml
jobs:
  test:
    using: env:python@3.13
    services:
      postgres:
        using: env:postgres@18
        run: pglite
        ready: { port: 5432 }
    run: |
      pip install 'psycopg[binary]'
      pytest
```

- `using` is an environment with a `run:` script that starts the service, or a built-in tool with `args:`.
- `env` sets the service's variables, and can read secrets (`${{ secrets.DB_PASSWORD }}`). A service does not see the job's own `env:`.
- `ready` says when the job may start: `{ port: 5432 }` once something listens on that port, `{ log: "listening on" }` once a line of the service's output matches the pattern, or `{ command: "..." }` once that script, run in the service's environment, succeeds. Each waits up to 60 seconds (`timeout: 2m` for longer). Without `ready`, the job starts as soon as the service has.
- A service that stops before it is ready, or is not ready in time, fails the job without running it, and the job's reason names the service.
- A service's output is in the job's log, each line after `[service <name>]`, with secrets hidden like the rest of the log.
- `workspace.services` gives every job of the pipeline the same services. A job's own `services:` add to them, and `services: false` turns them off for that job.

`env:postgres@18` is PostgreSQL 18.4. It runs in memory and accepts **one connection**, as user `postgres` with database `postgres` and no password, and stops when that connection closes, so a test suite has to share one connection. The `port` check never connects, so it does not use that connection up. There is no MySQL, MariaDB or Redis build for WebAssembly. SQLite needs no server and is available in `env:python@3.13` and the PHP environments.

A script can also start a server itself with `&`. Anything still running when the script ends is stopped. Two commands wait until it is ready, so a job need not guess with `sleep`:

- `wait-for-port 3000` waits until something in the job listens on port 3000. It never connects to find out, which matters for a server that serves a single client and then exits.
- `wait-for-log server.log 'listening on'` waits until a line of the file matches the pattern.

Both give up after 30 seconds (`--timeout 2m` for longer) and fail the job with a message saying what they waited for.

```yaml
jobs:
  api:
    using: env:bash-node@24
    run: |
      node server.js > server.log 2>&1 &
      wait-for-port 3000
      npm test
```

## Monorepos: a job per package

In a JavaScript workspace (`pnpm-workspace.yaml`, or `workspaces` in the root `package.json`), `packages:` gives a job one copy per package, and `needs: ["^build"]` makes each package wait for the packages it depends on, as Turborepo's `dependsOn` does. `task-cache:` skips a job when nothing it reads has changed since a run of it passed, so a change rechecks only the packages it can affect:

```yaml
jobs:
  build:
    packages: { scripts: { build: "tsdown*" } }
    needs: ["^build"]
    using: builtin:typescript@7.1
    args: [--emitDeclarationOnly, --outDir, dist]
    artifacts: [dist]
    task-cache: true

  check:
    packages: { scripts: { build: "!tsdown*" } }
    needs: ["^build"]
    using: builtin:typescript@7.1
    args: [--noEmit]
    task-cache: true
```

- Each package's job shows as its own row in the run, named after the job and the package.
- Filter which packages a job runs in by directory or name (`only:`), by the files a package has (`has:`), and by its scripts (`has-script:`, or `scripts:` to match a script's command).
- A skipped job shows as **Passed** with the reason _Cached: nothing it reads changed since a run that passed_, and its output is the output of that run. The check on GitHub says how many jobs the task cache stood in for.
- A job's cache key covers the job itself, the files it reads, your lockfile and everything earlier jobs hand it, so a change in one package reruns the jobs downstream of it only when their inputs actually changed.
- Pull requests keep their own cached results, like their caches: nothing a pull request saves is reused on your default branch.

## Runs

The runs table lists the latest runs, newest first, with their status, where they came from (a branch, or a pull request and its branch) and how long they took. Filter it by status with **Show**.

Open a run to see its jobs. The sidebar lists every job, with a matrix's entries and a `packages:` job's packages grouped under the job they were written as. **Summary** draws each pipeline as a graph: a box per job, below the jobs it needs, each with its status and how long it took. Drag to move around it, zoom with the buttons (or Ctrl and the scroll wheel), **Fit** to see all of it and **Expand** to fill the window. Click a job, in the graph or the sidebar, to read its output.

<insert [The CI run page: the sidebar of jobs with a package group expanded, and the Summary graph of a running run with passed, running, failed and waiting jobs] here>

While a run is going, the page follows it live: jobs change state as they start and finish, and an open job's output appears as it is printed. Runs from before the graph view show their jobs without the lines between them.

A job that has printed nothing and used no CPU for five minutes is stopped instead of being left to run out its timeout, and fails with a reason that starts _stalled_. That is what a hung process looks like: a job that is working uses CPU, however quiet it is. A job that only waits in silence for that long, on a slow download or a `sleep`, is stopped too, so have it print something now and then.

A run is **Queued** while every runner is busy and starts as soon as one is free. A run that cannot start is marked **Error** with the reason, for example that your plan does not include CI.

When a job fails because one of its processes was ended by a signal, or crashed, its output ends with a few lines starting `iwci:` that say what the runner saw: which signal it was and what sent it, or the crash itself. They are there to go in a bug report; your own commands' output is above them.

### Retry a run

A run that has finished (**Passed**, **Failed** or **Error**) can run again without a new push. Open it and choose:

- **Retry** runs the same commit, branch and event again. Jobs with `task-cache:` whose inputs have not changed come back from the task cache, so a retry after a flaky failure reruns only what needs to run.
- **Retry without cache** runs every job, reading nothing from the task cache. What passes is saved again, so the next run is cached as usual. Jobs still restore their `cache:` entries; to start those cold too, [clear the repository's caches](#caches) first.

A failed run also has a **Retry** button in the runs table. The retry is a new run, marked **retry** in the table. Its page links back with **Retry of run …**, and the run it retries links to the newest retry with **Retried as run …**. On GitHub, the retry's check replaces the earlier one on the commit or pull request.

Retrying takes the `ci:approve` permission, the same as approving a fork's pull request. A run waiting for approval is approved rather than retried, and a rejected one cannot be retried. A retry of a fork's pull request still runs without your secrets.

<insert [A failed CI run's page with the Retry and Retry without cache buttons beside "Open on GitHub", and below the header the "Retried as run 5e6f7a8b" link to its retry] here>

## Downloads

`downloads:` keeps files from a job for you to download from the run: a build, a test report, a coverage page. They are listed on the run's **Summary** under **Downloads**, and on each job's own page, with their size and how long they are kept. **Download** fetches the file; on the desktop app it opens in your browser, which saves it.

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
      retention: 7d
      when: always
```

<insert [The CI run page on Summary, below the graph: the Downloads list with app.tar.gz from the build job and junit.xml from the e2e job, each with its size, "Kept until" date and a Download button] here>

- **What is kept**: the files the job wrote under the paths you list. A directory keeps every file in it, each as its own download; put them in an archive in your script to download them as one.
- **When**: after the job passes, unless `when:` says `failure` (for a report of what failed) or `always`.
- **How long**: 30 days unless `retention:` says otherwise, between `1h` and `365d`. The runners keep files for at most 90 days. An expired file is deleted and shows as **Expired**.
- **How big**: up to 256 MiB per file and 1 GiB per run. A file over a limit is left out and the job's notes say so; the job still passes.
- **Secrets**: in a text file, your secrets are replaced with `***`, as in the log. **A binary file (an archive, an image, a compiled program) is stored exactly as the job left it, secrets and all**, so never write a secret into one you download. Pull requests from forks never have your secrets.
- **Who can download**: anyone in the organization who can see the run (`ci:read`). Each **Download** makes a link that works for 15 minutes, for that one file; nothing is public.
- A job with `task-cache:` cannot have `downloads:`: when the task cache stands in for it, it does not run, so there is nothing to keep.

## Pull requests from forks

A pull request from a fork runs code you have not reviewed, so it never runs on its own:

- The run waits as **Awaiting approval**, and the check on GitHub asks for action.
- Someone with the `ci:approve` permission chooses **Approve** (and confirms) or **Reject**, from the runs table or the run itself.
- Approval covers that one commit. When the fork pushes again, the new commit waits for approval again, and the old one is set aside.
- An approved run gets your [variables](#secrets-and-variables) but **never your secrets**.
- Its caches are its own: a pull request reads the default branch's caches but writes only to its own, so it cannot change what your branches build with.

Pull requests from branches of the repository itself run straight away, with secrets, since only people who can push to the repository can open them. A fork's run that nobody decides on within 14 days is closed.

## Secrets and variables

Under **Secrets and variables**, choose an account and a scope: **Every repository** for the account, or one repository, whose own values override the account's of the same name. Pipelines read them as:

- `${{ secrets.NAME }}` in a job's `env:` value. A secret's value is hidden once saved: you can replace or remove it, but nobody can read it back, and it is masked as `***` in every log and output.
- `${{ vars.NAME }}` anywhere an expression works. Variables are not secret.

Names are letters, digits and `_`, not starting with a digit. Managing them takes `ci:write`.

<insert [The Secrets and variables card with the account picker on "acme", the scope on "Every repository", one secret NPM_TOKEN shown as Hidden and one variable REGION = eu-west-1, and the add form below] here>

## Caches

The **Caches** card lists what each repository's jobs have saved, with `cache:` and `task-cache:`, across every branch and pull request: how many entries and how much space, largest first, under each GitHub account with its total against its storage quota.

To start a repository from nothing, for example after a cache that keeps restoring something broken, choose **Clear cache** on its row. The dialog says how many entries and how much space go before anything is deleted. Clearing deletes that repository's entries for every branch and pull request, and the card then says what was removed. The next run of each job starts cold and saves its caches again. Other repositories keep theirs, and so does the runners' own copy of your dependencies, which is not counted as your storage. The repository's [downloads](#downloads) are not caches and stay until they expire.

Everyone who can see runs can see the card; clearing a cache takes `ci:write` and is recorded in the [audit log](../team-and-billing/audit-log.md).

<insert [The Caches card listing two repositories of the acme account with their entries and sizes, and the "Clear the cache of acme/web?" dialog open over it saying how many entries and how much space it deletes] here>

## Usage and billing

CI is part of paid plans. The usage card shows this month's runs, compute and storage. It is billed on your plan's invoice, by what you use:

- **vCPU time**: each job's running time, at its share of a vCPU.
- **Memory**: the memory each job reserves, for as long as it runs.
- **Storage**: the space your caches and [downloads](#downloads) take on the runners, measured every hour. Task cache results count here too, and a download stops counting when it expires.

A job the task cache stood in for did not run, so it uses no vCPU time or memory.

Complimentary organizations are never billed. See [Billing and plans](../team-and-billing/billing-and-plans.md#ci).

## Limits

- CI runs for GitHub repositories, through the Infrawrench GitHub App.
- The mobile app does not show CI.
- The pipeline format, the builtin tools and the limits on each job are described in the runner's reference (`ci-runner/README.md` in the Infrawrench repository).
