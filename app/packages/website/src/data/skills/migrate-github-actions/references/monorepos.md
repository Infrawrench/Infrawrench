# Monorepos: from a few big jobs to a job per package

On GitHub Actions every job pays for its own machine, checkout and install, so monorepo workflows usually have a handful of jobs that each run one task across every package (`turbo run test`, `nx affected -t lint`, `pnpm -r typecheck`). In Infrawrench CI a job costs none of that, so write one job definition per task and let it expand to one job per workspace package. Each package's job is its own row and log in the run, and the task cache skips the ones a change cannot affect.

## The shape

```yaml
name: Test

on:
  push:
    branches: [main]
  pull-request: {}

workspace:
  deps: [pnpm]

jobs:
  build:
    packages: { has-script: [build] }
    needs: ["^build"]
    using: env:bash-node@24
    run: pnpm run build
    artifacts: [dist]
    task-cache: true

  typecheck:
    packages: { has: [tsconfig.json] }
    needs: ["^build"]
    using: builtin:typescript@7.1
    args: [--noEmit]
    task-cache: true

  test:
    packages: { has-script: [test] }
    needs: [build]
    using: env:bash-node@24
    run: pnpm test
    task-cache: true
    memory: 4GiB
```

- **`packages:`** expands a job over the workspace (`pnpm-workspace.yaml`, or `workspaces` in the root `package.json`). `true` is every package. Narrow it with `only:` (globs over directory or name, `!` excludes), `has:` (files the package has), `has-script:` (scripts it defines) or `scripts:` (a glob its script's command must match). Each job runs in its package's directory and reads `${{ package.name }}` and `${{ package.dir }}`.
- **`needs: ["^build"]`** waits for `build` in each package this one depends on, like Turborepo's `dependsOn: ["^build"]`. `needs: [build]` in a `packages:` job means the same package's `build`. A plain job that needs a `packages:` job waits for all of its packages.
- **`artifacts:`** in a `packages:` job are relative to the package, so each package's `dist/` reaches the jobs that depend on it.
- **One slow package** can be split further: give it its own job with `only:` and a `matrix:` of shards, and leave the rest alone.

## The task cache

`task-cache: true` skips a job when nothing it reads has changed since a run of it passed, and hands on that run's log, outputs and artifacts as if it had run. Use it on every deterministic job: builds, type checks, tests, linters, formatters.

```yaml
task-cache:
  inputs: [src/**, tsconfig.json, "!src/**/*.md"] # relative to the package; default: every file in it
  root-inputs: [tsconfig.base.json, .eslintrc.cjs] # relative to the repository root
  artifacts: false # see below
```

- **The key** covers the job's definition, the exact version of every tool and environment it uses, the lockfiles, the files its inputs match, and the bytes of every artifact it is handed. A job downstream of a change reruns only when what it is handed actually changed.
- **Name every file outside the package that a job reads** in `root-inputs:` (shared tsconfig, lint and test config, fixtures). A file the key leaves out can change without rerunning the job.
- **`artifacts: false`** leaves handed-on artifacts out of the key, for a job that only passes them along (a bundler that keeps workspace dependencies external), so a change at the bottom of the graph does not rebuild everything above it. Only when the job's result does not depend on them.
- **Cannot be task-cached:** a job that reads a secret, is lent anything (`connections:`, `ssh-keys:`), has `github-token:`, keeps `downloads:` or runs on a cloud account. Keep those jobs small and put them after the cached ones.
- A cache hit is not billed, takes no slot or memory, and a run where every job hits never installs dependencies. Pull requests keep their own results: nothing a pull request saves is used on the default branch.

## Translating common commands

| GitHub Actions step                           | Infrawrench CI                                                                        |
| --------------------------------------------- | ------------------------------------------------------------------------------------- |
| `turbo run build` / `nx run-many -t build`    | A `build` job with `packages:`, `needs: ["^build"]`, `artifacts: [dist]`              |
| `turbo run test --filter=...[origin/main]`    | A `test` job with `packages:` and `task-cache: true`: the cache does the filtering    |
| `nx affected -t lint`                         | A `lint` job with `packages: { has-script: [lint] }` and `task-cache: true`           |
| `pnpm -r --parallel typecheck`                | A `typecheck` job with `packages:` and `using: builtin:typescript@7.1`                |
| `pnpm --filter web test`                      | A job with `packages: { only: [apps/web] }`, or a plain job with `cwd: /app/apps/web` |
| A `paths-filter` step choosing which jobs run | `paths:` on each job, or `if: changed('apps/web/**')`                                 |

Keep `turbo` or `nx` out of the jobs once they are split: each job runs one package's script directly, and the task cache replaces their caches.
