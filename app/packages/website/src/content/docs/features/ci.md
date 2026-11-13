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

In `env:bash-node`, Node's module compile cache works: with `NODE_COMPILE_CACHE` set to a directory, each `node` keeps the compiled code of the modules it loads there, and the next one reuses it instead of compiling them again. To keep it between runs, put it inside the repository's directory (jobs start in `/app`, where the repository is checked out) and cache it, which keeps a pull request's copy apart from your branches':

```yaml
jobs:
  test:
    using: env:bash-node@24
    env: { NODE_COMPILE_CACHE: /app/.node-compile-cache }
    cache:
      key: node-compile-cache-${{ hashFiles('pnpm-lock.yaml') }}
      restore-keys: [node-compile-cache-]
      paths: [.node-compile-cache]
    run: pnpm test
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
        run: pglite-server
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

`env:postgres@18` is PostgreSQL 18.4, in memory. `pglite-server` serves it on port 5432 to as many connections as a job opens, so connection pools, migration tools and test suites work. Any user, database and password are accepted, and every connection gets the database `postgres` as the user `postgres`. `CREATE EXTENSION pgcrypto` gives `digest`, `hmac` and `gen_random_bytes` (md5 and SHA-2), but not `crypt` or the encryption functions.

It is one PostgreSQL session that connections take turns on, **one transaction at a time**:

- Transactions never run at the same time. A second one waits for the first to commit or roll back, so it never sees the first one's row locks. Claiming rows with `FOR UPDATE SKIP LOCKED` from several connections still takes each row once, but a test that holds a lock in one connection to watch another skip it cannot pass.
- A statement that waits on another connection's open transaction while that transaction does nothing fails after 15 seconds with error `55P03`, instead of waiting forever. `run: pglite-server -wait 30s` changes the limit.
- `SET`, advisory locks and `LISTEN` are shared by all connections. Prepared statements are each connection's own, and a connection that closes inside a transaction has it rolled back.

`run: pglite` starts PostgreSQL without `pglite-server`: it accepts one connection and stops when that connection closes. There is no MySQL, MariaDB or Redis build for WebAssembly. SQLite needs no server and is available in `env:python@3.13` and the PHP environments.

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
- It also covers the exact version of every tool and environment the job uses. When a new version is published under a range you wrote in `using:` (such as `env:bash-node@24`), each job using it runs once more on the new version; a job that names an exact version (`@24.0.8`) stays cached.
- Pull requests keep their own cached results, like their caches: nothing a pull request saves is reused on your default branch.

## Runs

The runs table lists the latest runs, newest first, with their status, where they came from (a branch, or a pull request and its branch) and how long they took. Filter it by status with **Show**.

Open a run to see its jobs. The sidebar lists every job, with a matrix's entries and a `packages:` job's packages grouped under the job they were written as. **Summary** draws each pipeline as a graph: a box per job, below the jobs it needs, each with its status and how long it took. Drag to move around it, zoom with the buttons (or Ctrl and the scroll wheel), **Fit** to see all of it and **Expand** to fill the window. Click a job, in the graph or the sidebar, to read its output.

<insert [The CI run page: the sidebar of jobs with a package group expanded, and the Summary graph of a running run with passed, running, failed and waiting jobs] here>

While a run is going, the page follows it live: jobs change state as they start and finish, and an open job's output appears as it is printed. Runs from before the graph view show their jobs without the lines between them.

A job that has printed nothing and used no CPU for five minutes is stopped instead of being left to run out its timeout, and fails with a reason that starts _stalled_. That is what a hung process looks like: a job that is working uses CPU, however quiet it is. A job that only waits in silence for that long, on a slow download or a `sleep`, is stopped too, so have it print something now and then.

A run is **Queued** while every runner is busy and starts as soon as one is free, and **Waiting** while another run holds one of its [concurrency groups](#concurrency-groups). A run that cannot start is marked **Error** with the reason, for example that your plan does not include CI.

When a job fails because one of its processes was ended by a signal, or crashed, its output ends with a few lines starting `iwci:` that say what the runner saw: which signal it was and what sent it, or the crash itself. They are there to go in a bug report; your own commands' output is above them.

### Retry a run

A run that has finished (**Passed**, **Failed**, **Error** or **Cancelled**) can run again without a new push. Open it and choose:

- **Retry** runs the same commit, branch and event again. Jobs with `task-cache:` whose inputs have not changed come back from the task cache, so a retry after a flaky failure reruns only what needs to run.
- **Retry without cache** runs every job, reading nothing from the task cache. What passes is saved again, so the next run is cached as usual. Jobs still restore their `cache:` entries; to start those cold too, [clear the repository's caches](#caches) first.

A failed or cancelled run also has a **Retry** button in the runs table. The retry is a new run, marked **retry** in the table. Its page links back with **Retry of run …**, and the run it retries links to the newest retry with **Retried as run …**. On GitHub, the retry's check replaces the earlier one on the commit or pull request.

Retrying takes the `ci:approve` permission, the same as approving a fork's pull request. A run waiting for approval is approved rather than retried, and a rejected one cannot be retried. A retry of a fork's pull request still runs without your secrets.

<insert [A failed CI run's page with the Retry and Retry without cache buttons beside "Open on GitHub", and below the header the "Retried as run 5e6f7a8b" link to its retry] here>

A retry joins its pipelines' [concurrency groups](#concurrency-groups) like any other run, as the newest run of each.

### Cancel a run

A run that has not finished (**Queued**, **Waiting** or **Running**) has a **Cancel** button, on its page and in the runs table. A run that has not started ends as **Cancelled** at once. A running one is stopped by its runner: running jobs are stopped as a timeout would stop them (their background services too), jobs that had not started never start, and the run shows **Cancelling…** until the runner has stopped it, a few seconds later. It then ends as **Cancelled**, and so does its check on GitHub. A job that failed before the cancel keeps the run **Failed**. Jobs are billed for the time they ran.

Cancelling takes the `ci:approve` permission, like retrying, and is recorded in the audit log. A run waiting for approval is rejected rather than cancelled.

<insert [A running CI run's page with the Cancel button beside "Open on GitHub", and below the header the line "Concurrency groups: ci-main"] here>

## Concurrency groups

A pipeline can say that only one run of it, or of a set of pipelines, goes at a time. Put it at the top of the pipeline file:

```yaml
name: Deploy
concurrency: deploy-${{ commit.branch }}
```

or, to have a newer run stop the one already going:

```yaml
name: Test
concurrency:
  group: ${{ pipeline.name }}-${{ commit.branch }}
  cancel-in-progress: true
```

The group is a name built from the run: `${{ commit.branch }}` (a pull request's is `pull/<number>`), `${{ pull-request.number }}` (empty for a push), `${{ pipeline.name }}`, `${{ event }}`, `${{ repo.id }}`, `${{ commit.sha }}` and `${{ vars.<name> }}`. Groups belong to one repository, and their names ignore case. A pull request from a fork has groups of its own: its pipeline file is the fork's to write, so once approved it can only wait for, or cancel, runs of the same pull request, never your branches' runs.

At most one run of a group goes at a time in a repository. When a new run joins a group another run holds:

- With `cancel-in-progress: true`, the older run's pipelines in that group are cancelled, and the new run starts. The older run's other pipelines carry on, so a deploy in no group is not stopped by a test pipeline's group.
- Without it, the new run waits, marked **Waiting**, and starts when the group is free. Only the newest waiting run is kept: an older one that is still waiting is cancelled.

A run is every pipeline its push or pull request starts, so it waits while any of its groups is taken, and its page lists its groups under **Concurrency groups**. A run never waits behind, or cancels, a newer run of its group: if a newer one got there first, the older one is cancelled. Retries join their groups as the newest run.

Groups apply to whole pipelines; a single job cannot have a group of its own.

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

## CI access

Jobs can use what your organization has connected to Infrawrench, once someone turns it on: run on a cloud connection, use a connection's credentials, read a resource's outputs, or use an SSH key. Everything is off until then, and each permission says which repositories and branches it holds for. A run from a fork's pull request gets none of it.

Everyone who can see runs can see the **CI access** card. It lists each connection that runs jobs or lends its credentials on one line, with what it does and for which repositories and branches; choose a line, or **Manage connections**, to open every connection that can do either, with the chosen one's settings beside the list. On a phone the list comes first, and choosing a connection opens its settings with a way back. Changes to a connection take effect when you **Save**; leaving with changes unsaved asks first. Lending a connection, granting a resource and running cloud jobs on a connection take `ci-access:write`, which admins and owners hold; `ci:write` alone can only remove a grant or revoke a lent key. An SSH key is lent by its owner, with `ssh-keys:write`. None of this can be changed with an API key or by an agent: a person decides what CI jobs may use. Every change, and every time a run is lent something, is recorded in the [audit log](../team-and-billing/audit-log.md), with who allowed it.

<insert [The CI access card: a Google Cloud connection "Infrawrench GCP" on one line with the chips "Runs jobs · Compute Engine instance, Cloud Run job" and "All repositories · main, release/*", a Kubernetes connection "Production cluster" with "Lends credentials" and "acme/web · main", the Manage connections button above them, the wide "Search for resources" field, and one granted resource and one lent SSH key as compact rows] here>

<insert [The Manage connections dialog: the connection list on the left with a search field and an on dot beside Infrawrench GCP and Production cluster, and Infrawrench GCP's settings on the right with "Run jobs on it" switched on, Compute Engine instance and Cloud Run job ticked and "Ready", 2 jobs at once and 60 minutes per job, the branches "main, release/*", and Cancel and Save at the bottom] here>

### Repositories and branches

Each permission holds for **Every repository** CI runs for, or, with **Chosen repositories**, the ones you tick, and for every branch (the branch field left empty) or the branches matching a pattern: globs separated by commas, where `*` stops at `/` and `**` does not (`main, release/*`). A pattern of only commas or spaces is refused. A pull request is checked by its head branch, so `main` keeps a pull request from using a production cluster.

### Cloud jobs

A job with `cloud:` runs on a fresh machine in one of your connected cloud accounts instead of on the runners, and the machine is removed when the job ends:

```yaml
jobs:
  build-image:
    cloud:
      provider: aws # the provider of an opted-in connection
      kind: vm # vm, container, build, host or cluster
      machine: c7i.2xlarge # optional: the provider's size name
      region: eu-west-1 # optional
      connection: Production # optional: when several connections can run it
    needs: [test]
    timeout: 30m
    run: docker build -t app .
    outputs: [digest]
```

`cloud: aws/vm` is the short form. To let jobs run on a connection, open it under **Manage connections**, switch on **Run jobs on it**, then choose **Check permissions** beside each kind and tick the kinds that are ready. The check asks the provider without starting anything, and says exactly which permission the connection's credential lacks and where to grant it; a kind that fails it cannot be turned on. Then set how many of its jobs may run at once and how long one may take.

- The machine gets the job's own environment and what the job is lent, never the connection's own credentials.
- The machine starts with a one-time token for its job in its start-up script (on AWS, the instance's user data), which anyone who can read that in your cloud account can see until the job fetches its script; the token is spent on that first fetch, and it never appears in a URL.
- It starts from the commit's source (without git history), with the artifacts of the jobs it needs, and hands its own artifacts on like any job.
- Its output streams to the run page like any job's, with a badge naming the connection, the kind and the machine, and its state: **Starting machine**, **Running on its machine**, **Tearing down**.
- It is removed when the job finishes, fails, times out or is cancelled. Infrawrench also tags everything it starts (`infrawrench-ci`) and removes tagged machines no live job owns. On AWS the instance also shuts itself down, and so terminates, once the job's time is up.
- The provider bills your account for the machine.

Supported so far:

| Provider              | Kind        | Runs on                                                         |
| --------------------- | ----------- | --------------------------------------------------------------- |
| Alibaba Cloud         | `vm`        | ECS instance (default `ecs.g8i.large`)                          |
| Alibaba Cloud         | `container` | ECI container group (default `2vcpu-4gb`)                       |
| Amazon Web Services   | `vm`        | EC2 instance (default `t3.large`)                               |
| Amazon Web Services   | `container` | ECS task on Fargate (default `2vcpu-4gb`)                       |
| Amazon Web Services   | `build`     | CodeBuild build (default `BUILD_GENERAL1_MEDIUM`)               |
| boat                  | `vm`        | boat sandbox (default `default`)                                |
| Civo                  | `vm`        | Compute instance (default `g4s.medium`)                         |
| Crusoe Cloud          | `vm`        | Crusoe VM (default `c1a.4x`)                                    |
| DigitalOcean          | `vm`        | Droplet (default `s-2vcpu-4gb`)                                 |
| Docker                | `container` | Container on the daemon (default `2vcpu-4gb`)                   |
| Docker                | `build`     | Docker build container (privileged) (default `2vcpu-4gb`)       |
| Exoscale              | `vm`        | Compute instance (default `standard.medium`)                    |
| Fly.io                | `container` | Fly Machine (default `performance-2x`)                          |
| Google Cloud          | `vm`        | Compute Engine instance (default `e2-standard-2`)               |
| Google Cloud          | `container` | Cloud Run job (default `2vcpu-4gb`)                             |
| Google Cloud          | `build`     | Cloud Build build (default `e2-standard-2`)                     |
| HashiCorp Nomad       | `cluster`   | Nomad batch job (default `2vcpu-4gb`)                           |
| Heroku                | `container` | One-off dyno on a throwaway app (default `standard-1X`)         |
| Hetzner Cloud         | `vm`        | Cloud server (default `cpx22`)                                  |
| IBM Cloud             | `vm`        | VPC virtual server (default `bx2-2x8`)                          |
| IBM Cloud             | `container` | Code Engine job run (default `2vcpu-4gb`)                       |
| Kubernetes            | `cluster`   | Kubernetes Job (default `2vcpu-4gb`)                            |
| Lambda Cloud          | `vm`        | On-demand GPU instance (default `gpu_1x_a10`)                   |
| Linode (Akamai Cloud) | `vm`        | Linode (default `g6-standard-2`)                                |
| Microsoft Azure       | `vm`        | Azure virtual machine (default `Standard_D2s_v5`)               |
| Microsoft Azure       | `container` | Container Instances group (default `2vcpu-4gb`)                 |
| Microsoft Azure       | `build`     | ACR Tasks run (default `2vcpu`)                                 |
| Modal                 | `container` | Modal Sandbox (default `2vcpu-4gb`)                             |
| Northflank            | `container` | Northflank job run (default `nf-compute-200`)                   |
| OpenStack             | `vm`        | Nova server                                                     |
| Oracle Cloud          | `vm`        | OCI Compute instance (default `VM.Standard.E5.Flex/1/8`)        |
| Oracle Cloud          | `container` | OCI Container Instance (default `2vcpu-8gb`)                    |
| OVHcloud              | `vm`        | Public Cloud instance (default `b3-8`)                          |
| Paperspace            | `vm`        | Paperspace machine (default `C5`)                               |
| Proxmox VE            | `vm`        | VM cloned from a template (default `2vcpu-4gb`)                 |
| Railway               | `container` | One-off deployment in a throwaway project (default `2vcpu-4gb`) |
| Runpod                | `container` | Pod (GPU or CPU) (default `cpu3c-2`)                            |
| Scaleway              | `vm`        | Instance (default `PLAY2-NANO`)                                 |
| Scaleway              | `container` | Serverless Jobs run (default `2vcpu-4gb`)                       |
| SSH                   | `host`      | Existing SSH host                                               |
| UpCloud               | `vm`        | Cloud Server (default `CLOUDNATIVE-2xCPU-4GB`)                  |
| Vast.ai               | `container` | Instance (GPU container) (default `4vcpu-16gb`)                 |
| VMware vSphere        | `vm`        | VM cloned from a template                                       |
| Vultr                 | `vm`        | Cloud Compute instance (default `vc2-2c-4gb`)                   |

`cloud.region` is the provider's region (or zone), except on Kubernetes and Nomad, where it names the namespace the job runs in. Without it a job runs in the connection's own region or namespace.

The check beside each kind names what that provider's credential needs, and links to where to grant it. A container or build image needs `bash`, `curl`, `tar`, `gzip` and `base64`; where they are missing, most container kinds install them with the image's package manager first.

An SSH host is not created for the job and is not removed after it: the job runs as the connection's user in a work directory of its own under `~/.infrawrench-ci`, with its clone, `HOME` and anything lent to it inside, and the directory and everything the job started are removed when it ends. Two jobs on one host never share a directory. The host is reached the way the terminal reaches it, through its jump host and only with the host key pinned in Infrawrench. Because `ssh` reads its configuration from the user's real home directory, a job on an SSH host that is lent another SSH connection uses it with `ssh -F "$HOME/.ssh/config"`.

<insert [A cloud job selected on the run page: the "Cloud job" badge reading "Production · vm · t3.large · eu-west-1", the state "Running on its machine", the instance label "aws ec2 i-0abc… (eu-west-1)", and the job's log streaming below] here>

### Connections

`connections:` lends a job a connection's credentials, as files and environment variables written before it runs:

```yaml
jobs:
  deploy:
    tools: [builtin:kubectl@1.37, builtin:ssh@10.6]
    connections: [Production cluster, web-1, { name: staging, namespace: web }]
    run: |
      kubectl rollout restart deploy/web
      ssh web-1 'sudo systemctl reload nginx'
```

Names are the connections' names in Infrawrench. To lend one, open it under **Manage connections** and switch on **Lend its credentials to jobs**.

- **Kubernetes:** a kubeconfig for the cluster in `/root/.kube`, with `KUBECONFIG` pointing at it, for one context (and the namespace a job asks for). A service account's token is swapped for a short-lived one where the cluster allows it. The cluster must be served over TLS. A cluster on a private network is reached through a public SSH jump host: open a tunnel with `ssh -L` in the job.
- **SSH:** an entry in `/root/.ssh/config` named after the connection, with its key, user and port, a check against the host key Infrawrench pinned for it, and the jump host it connects through, which must be lent too. A host with no pinned key is not lent: open a terminal to it from Infrawrench once first.

<insert [A deploy job's page listing what it was lent: Connections "Production cluster, web-1" and SSH keys "deploy"] here>

### SSH keys

`ssh-keys: [deploy]` writes one of your SSH keys to `/root/.ssh/id_deploy`, used for every host. Only a key's owner can lend it: under **Settings**, **SSH keys**, choose **Use in CI jobs** on your key, give it its name in pipelines, and say which repositories and branches may use it. Only keys Infrawrench generated can be lent, since an imported key's private half is not stored. Admins can revoke a lent key from the CI access card.

<insert [The SSH keys settings page with "Use in CI jobs" on the caller's own generated key, and the dialog open with its name in pipelines "deploy" and branches "main"] here>

### Resources

A job can read a resource's outputs, granted one resource at a time under **Resources jobs may read**: type its name in **Search for resources**, choose it, and tick the outputs jobs may read. Granted resources are listed below the search, each with **Edit** and **Remove**. Sensitive outputs start unticked. For a secret in a secret manager, choose its latest enabled version or a pinned one, read as `value`.

```yaml
jobs:
  migrate:
    env:
      DATABASE_URL: ${{ resources.prod-db.connectionString }}
      API_KEY: ${{ resources.stripe-key.value }}
    env-from: [r2-assets] # every granted output, as the resource's usual variable names
```

`${{ resources.<name>.<output> }}` works where `${{ secrets.NAME }}` does, in `env:` values. Values are read fresh for every run, so a rotated secret takes effect on the next one, and they are masked in every log and output.

<insert [The grant form under Resources jobs may read, opened from the "Search for resources" results: the database "prod-db" with its provider logo and "Choose another", connectionString ticked, the sensitive adminPassword unticked, its name in pipelines "prod-db", Every repository, the branch pattern "main", and Grant and Cancel] here>

### When a job is refused

A job that names something it may not have fails before it starts, saying why: "connection `staging` is not lent to CI for acme/web on feature/x", "prod-db is not granted to CI", or, for a cloud job, which connection to opt in. It never runs with an empty value.

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
- Cloud jobs run on the providers in the [table above](#cloud-jobs); more follow.
- The pipeline format, the builtin tools and the limits on each job are described in the runner's reference (`ci-runner/README.md` in the Infrawrench repository).
