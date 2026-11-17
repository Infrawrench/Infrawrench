---
title: "How to speed up GitHub Actions in a pnpm monorepo"
description: "Find where a pnpm monorepo's GitHub Actions time goes, then cut it: cache the pnpm store, cancel superseded runs, skip unaffected packages with pnpm filters, and know when splitting jobs stops paying off."
date: "2026-11-17"
kind: guide
---

A pnpm monorepo's CI tends to get slow in the same way. Every job checks out the repository, sets up Node, installs every workspace dependency and then runs the tests for every package, whatever the change touched. A one-line fix to one package waits for all of it. This guide works through the fixes in the order they usually pay off, with the workflow YAML for each, and ends with where GitHub Actions' per-job setup puts a floor under how fast a monorepo can go.

Prerequisites: a pnpm workspace (`pnpm-workspace.yaml` and a committed `pnpm-lock.yaml`) and a GitHub Actions workflow you can edit. The examples assume your default branch is `main` and your packages have `build` and `test` scripts.

## Step 1: Find where the time goes

Open a recent run, pick the slowest job and expand its steps. Each step shows its own duration. Put them in three buckets:

- **Setup:** Set up job, checkout, setup-node and the pnpm install.
- **Work:** build, typecheck, lint and tests.
- **Waiting:** time the run sat queued before a runner picked it up, visible as the gap between the run starting and the job starting.

If setup is a large share of every job, Steps 2 and 6 matter most. If the work dominates, Steps 4 and 5 matter most. If runs queue behind each other on busy branches, start with Step 3.

## Step 2: Cache the pnpm store

Without a cache, every job downloads every package from the registry. `actions/setup-node` can cache pnpm's store for you, keyed on the lockfile. pnpm has to be on the path before setup-node runs, so `pnpm/action-setup` comes first:

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm -r test
```

`pnpm/action-setup` reads the pnpm version from the `packageManager` field in your root `package.json` when you don't pass one, which keeps CI on the same version as your machine. `--frozen-lockfile` fails the install if the lockfile is out of date instead of quietly changing it.

This caches the store, not `node_modules`, so pnpm still links every package on each job. It removes the download, which is usually the biggest part of the install, but not the install itself.

## Step 3: Cancel runs nobody will read

When someone pushes three commits to a pull request in a row, GitHub Actions runs all three. Only the last one matters. A concurrency group cancels the older runs for the same branch:

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}
```

The condition keeps every run on `main`, so each merged commit still gets a full result, while pull request branches only keep their newest run. This doesn't make a single run faster, but it frees runners, which cuts queueing for everyone else.

## Step 4: Test only the packages a change affects

pnpm can select the packages that changed since a commit, plus every package that depends on them. In a pull request, compare against `main`:

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
# ...pnpm and Node setup as in Step 2...
- run: pnpm install --frozen-lockfile
- run: pnpm --filter "...[origin/main]" build
- run: pnpm --filter "...[origin/main]" test
```

- `[origin/main]` selects packages with files changed since `origin/main`.
- The leading `...` adds every package that depends on them, so a change to a shared library also tests the apps that use it.
- `fetch-depth: 0` fetches the full history. The default checkout is a single commit, so `origin/main` would not exist to compare against.

Two things to watch. A change to a root file, such as the lockfile or a shared `tsconfig`, doesn't belong to any package, so the filter can miss it. Run everything on pushes to `main`, or when root files change, so nothing slips through. And if a package's build has to run before its dependents' tests, keep the build step: the filter selects packages, but `pnpm -r` and `--filter` still run them in dependency order.

Turborepo and Nx do the same job with their own caches. With Turborepo, `turbo run test --filter=...[origin/main]` selects the same packages, and its remote cache lets a run reuse results from an earlier run where the inputs match.

## Step 5: Skip workflows a change can't affect

If docs, the website and the app live in one repository, a docs change doesn't need the app's test workflow. `paths` and `paths-ignore` on the trigger skip the whole workflow:

```yaml
on:
  pull_request:
    paths-ignore:
      - "docs/**"
      - "**/*.md"
```

Be careful with required status checks. When a workflow is skipped by a path filter, GitHub leaves its required checks pending, and the pull request can't merge. Either don't require checks from path-filtered workflows, or filter inside the job with Step 4 instead, so the workflow always runs and reports a result.

## Step 6: Split jobs, and know when it stops paying off

A matrix runs packages or test shards in parallel:

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        package: [api, web, worker]
    steps:
      # ...checkout, pnpm and Node setup, install...
      - run: pnpm --filter "${{ matrix.package }}..." test
```

Each matrix entry is its own job on its own runner, so each one pays for Set up job, checkout, setup-node and install again. With the store cached that might be under a minute, but it is paid once per job. Splitting a ten-minute test suite into three jobs helps. Splitting thirty small packages into thirty jobs usually doesn't: the setup repeated thirty times can cost more than the tests save, and every job counts towards your runner minutes.

That is why most monorepos settle on a handful of large jobs, each running a slice of everything. The catch is the one you started with: a failure is somewhere in a long log, and a small change reruns the whole slice.

## When per-job setup is the floor

Once the store is cached, superseded runs are cancelled and only affected packages run, what is left is mostly per-job setup: a fresh runner, a clone and an install for every job. That cost is how GitHub Actions jobs are built, so tuning the workflow can't remove it.

Infrawrench CI is built around removing it. It runs pipelines from a repository's `.infrawrench/ci/` folder on every push and pull request, and reports results back to GitHub as checks. For each commit it clones the repository once, into memory, and installs dependencies once from the lockfile. Every job then starts in its own WebAssembly sandbox over a snapshot of that result, so there is no clone or install per job. Because a job costs so little to start, a job per package becomes practical:

```yaml
jobs:
  build:
    packages: { scripts: { build: "tsdown*" } }
    needs: ["^build"]
    artifacts: [dist]
    task-cache: true

  test:
    packages: { has-script: [test] }
    needs: [build]
    run: pnpm test
    task-cache: true
```

`packages:` gives a job one copy per workspace package, `needs: ["^build"]` waits for the packages each one depends on, and `task-cache:` skips a job whose inputs haven't changed since it last passed. Each package's job is its own row and log, so a failure points at one package. Infrawrench's own pipeline is 897 jobs; it comes back in 9.1 seconds when nothing changed, and it ran 2 to 5 times faster than its previous GitHub Actions workflow on the same commits.

It is not a drop-in GitHub Actions runner. The pipeline format is its own, and a [migration skill](/docs/features/ci-migrate-from-github-actions) lets a coding agent convert your workflows and report what moved. macOS and Windows runners, and events it doesn't run on such as releases and tag pushes, stay on GitHub Actions. CI is part of the paid plan and billed by the second for what jobs use; a job the task cache skips isn't billed.

## Conclusion

Measure first, then cache the pnpm store, cancel superseded runs, and run only the packages a change affects. Those three usually cut a pnpm monorepo's CI time the most for the least work. Split into parallel jobs only where the work outweighs each job's setup, and if setup is what remains, that is the point where a runner that clones and installs once per commit, rather than once per job, makes the difference.

Infrawrench is one platform made of apps that all read the same connected accounts, and CI is part of its Delivery app. The [CI docs](/docs/features/ci) cover the pipeline file in full, and the [free desktop app](/) for macOS, Windows and Linux needs no account.

## References

- [actions/setup-node: caching packages](https://github.com/actions/setup-node#caching-global-packages-data)
- [pnpm/action-setup](https://github.com/pnpm/action-setup)
- [pnpm: continuous integration](https://pnpm.io/continuous-integration)
- [pnpm: filtering](https://pnpm.io/filtering)
- [GitHub Actions: control the concurrency of workflows and jobs](https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/control-the-concurrency-of-workflows-and-jobs)
- [GitHub Actions: workflow syntax, paths filters](https://docs.github.com/en/actions/writing-workflows/workflow-syntax-for-github-actions#onpushpull_requestpull_request_targetpathspaths-ignore)
- [GitHub: troubleshooting required status checks](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks)
- [Turborepo: filtering](https://turborepo.com/docs/crafting-your-repository/running-tasks#using-filters)
- [Infrawrench CI docs](/docs/features/ci)
- [Introducing Infrawrench CI](/blog/introducing-infrawrench-ci)
