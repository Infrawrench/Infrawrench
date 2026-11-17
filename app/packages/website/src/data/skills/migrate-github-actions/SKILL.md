# Migrate GitHub Actions to Infrawrench CI

Infrawrench CI runs the pipelines in a repository's `.infrawrench/ci/` folder on every push and pull request. Each job is one script (or one tool) that runs in its own WebAssembly sandbox over an in-memory snapshot of the commit, with the dependencies already installed from the lockfile. There are no steps, no marketplace actions and no runner images: most of a GitHub Actions job's steps either disappear or become lines of one script.

The reference for every key is the runner's README, `ci-runner/README.md` in the Infrawrench repository, and the user-facing guide is https://infrawrench.com/docs/features/ci. Read the files under `references/` when the step below says so; they are written to be read one at a time.

## Process

1. **Inventory.** Read every file in `.github/workflows/`. For each workflow, list its triggers, its jobs, what each job runs on (`runs-on`), the actions it uses, its services, the secrets and variables it reads, and which jobs depend on which. Note reusable workflows (`workflow_call`) and composite actions (`.github/actions/`), which are inlined, not called.

2. **Classify each job** into one of three groups, and tell the user the result before writing files:
   - **Runs on the runner**: bash, Node, Python, Go, PHP, TypeScript type checks, formatters, Postgres or ClickHouse tests, deployment CLIs. Most jobs.
   - **Becomes a cloud job** (`cloud:`): anything that needs Docker, a native binary with no WebAssembly build, Rust compilation, a GPU, or a real Linux machine. It runs on one of the organization's connected cloud accounts, which an admin has to opt in to CI first.
   - **Stays on GitHub Actions**: macOS and Windows jobs, and anything relying on an event Infrawrench CI does not have (see `references/limits.md`).

3. **Write one pipeline per workflow**, `.infrawrench/ci/<same-name>.yml`, starting with the schema comment so editors validate it:

   ```yaml
   # yaml-language-server: $schema=https://raw.githubusercontent.com/Infrawrench/Infrawrench/main/ci-runner/schema/ci.schema.json
   ```

   Translate the triggers, jobs, expressions and environment variables with `references/mapping.md`, and replace each action with `references/actions.md`.

4. **Move dependency installs to the workspace.** Delete `actions/setup-*`, `actions/checkout` and `npm ci` / `pnpm install` / `pip install -r` steps, and list the package managers under `workspace.deps` instead. Dependencies are installed once per commit and checked against the lockfile; install scripts do not run, so a `postinstall` that generates code (Prisma, protobuf) becomes an explicit line in the jobs that need it.

5. **Split big jobs.** A job that runs a whole monorepo's tests or type checks (`turbo run test`, `nx affected`, `pnpm -r test`) becomes a `packages:` job, one job per workspace package, with the task cache. Read `references/monorepos.md`. This is usually the largest speed-up of the migration.

6. **Check the limits.** Read `references/limits.md` and fix anything it flags: the 10-minute default timeout, the 2 GiB default memory, pipes in scripts, and the checkout having no `.git`.

7. **List what the user has to do in Infrawrench**, since an agent cannot do it:
   - Add every secret and variable the pipelines read under **CI → Secrets and variables** (names only: never write a secret's value into a file).
   - Turn on what jobs borrow under **CI → CI access**: connections that run cloud jobs, connections lent with `connections:`, SSH keys lent with `ssh-keys:`.
   - Tick **Run CI** for the repository's GitHub account if it is not on yet.

8. **Validate.** Push to a branch and open a pull request. A pipeline file that does not parse fails at once with a job named **Pipeline file** whose output gives every error with its path in the file (`jobs.test.timeout: ...`). With the Infrawrench MCP server connected, `list_ci_runs` and `get_ci_job_log` read the results without leaving the editor.

9. **Run both side by side, then switch.** Keep the GitHub Actions workflows until the Infrawrench runs pass on the same commits. Then delete the migrated workflows (or the migrated jobs, for a workflow that keeps some), and change branch protection to require **Infrawrench CI / pull request**, the check that covers every job of the run.

## Rules that catch people out

- **A job is one script.** `run:` is bash with `set -euo pipefail`. Join a GitHub job's `run` steps into one `run: |` block in order. Use `if:` on a job, not on a line; inside the script, use shell conditionals.
- **Secrets only in `env:`.** `${{ secrets.NAME }}` works only as an `env:` value. Map it to a variable and read the variable in the script.
- **Pick an environment.** Every job without `cloud:` names `using:`: `env:bash@5`, `env:bash-node@24`, `env:python@3.13`, `env:go@1.27`, `env:php@8.4`, `env:ruby@4.0`, or a tool such as `builtin:typescript@7.1`. Versions are pinned; a bare name is an error.
- **Jobs in `needs:` hand files on with `artifacts:`**, not with upload and download actions. Files for people to download from the run are `downloads:`.
- **Pull requests from forks** run only after a maintainer approves them, get no secrets, and never run cloud jobs. There is no `pull_request_target` equivalent.

## What to hand back

Finish with a short report: each workflow and job, where it went (runner, cloud job, stayed on GitHub Actions) and why, the secrets and variables to add, the CI access to turn on, and anything you were unsure of. Do not claim speed-ups you have not measured.
