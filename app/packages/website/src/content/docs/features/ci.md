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

| Environment                    | What it has                                                               |
| ------------------------------ | ------------------------------------------------------------------------- |
| `env:bash@5`                   | bash, coreutils, sed, grep and findutils                                  |
| `env:bash-node@24`             | the same, plus `node` (Node 24 compatible), `npm` and `pnpm`              |
| `env:python@3.13`              | the same as `env:bash@5`, plus Python 3.13 with `pip`                     |
| `env:php@8.1` to `env:php@8.5` | the same as `env:bash@5`, plus PHP 8.1, 8.2, 8.3, 8.4 or 8.5 and Composer |

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

### Background services

A job can start a server in the background with `&` and test against it on `127.0.0.1`. Each job has a network of its own, so ports never clash between jobs, and anything still running when the script ends is stopped. Two commands wait until a service is ready, so a job need not guess with `sleep`:

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

No environment includes a database server yet, and there is no MySQL, MariaDB or Redis build for WebAssembly. SQLite needs no server and is available in `env:python@3.13` and the PHP environments.

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

## Usage and billing

CI is part of paid plans. The usage card shows this month's runs, compute and cache storage. It is billed on your plan's invoice, by what you use:

- **vCPU time**: each job's running time, at its share of a vCPU.
- **Memory**: the memory each job reserves, for as long as it runs.
- **Cache storage**: the space your caches take on the runners, measured every hour. Task cache results count here too.

A job the task cache stood in for did not run, so it uses no vCPU time or memory.

Complimentary organizations are never billed. See [Billing and plans](../team-and-billing/billing-and-plans.md#ci).

## Limits

- CI runs for GitHub repositories, through the Infrawrench GitHub App.
- The mobile app does not show CI.
- The pipeline format, the builtin tools and the limits on each job are described in the runner's reference (`ci-runner/README.md` in the Infrawrench repository).
