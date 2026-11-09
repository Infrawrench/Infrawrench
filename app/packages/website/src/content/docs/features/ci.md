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

The next push runs it. Each run shows on the commit or pull request on GitHub as the **Infrawrench CI** check, whose **Details** link opens the run in Infrawrench.

Choosing accounts takes the `ci:write` permission; everyone in the organization can see runs (`ci:read`). See [Roles and permissions](../team-and-billing/roles-and-permissions.md).

## Runs

The runs table lists the latest runs, newest first, with their status, where they came from (a branch, or a pull request and its branch) and how long they took. Filter it by status with **Show**. Open a run to see each job's output; a failed job opens already expanded. Runs that are still going refresh on their own.

A run is **Queued** while every runner is busy and starts as soon as one is free. A run that cannot start is marked **Error** with the reason, for example that your plan does not include CI.

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
- **Cache storage**: the space your caches take on the runners, measured every hour.

Complimentary organizations are never billed. See [Billing and plans](../team-and-billing/billing-and-plans.md#ci).

## Limits

- CI runs for GitHub repositories, through the Infrawrench GitHub App.
- The mobile app does not show CI.
- The pipeline format, the builtin tools and the limits on each job are described in the runner's reference (`ci-runner/README.md` in the Infrawrench repository).
