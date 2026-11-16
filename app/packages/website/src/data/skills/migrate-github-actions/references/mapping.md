# GitHub Actions to Infrawrench CI: key by key

Unknown keys are an error, so leave out anything without a row here rather than carrying it over.

## Workflow level

| GitHub Actions                                          | Infrawrench CI                                                                                                      |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `name:`                                                 | `name:` (required)                                                                                                  |
| `on: push` with `branches`, `paths`                     | `on: { push: { branches, paths } }`                                                                                 |
| `branches-ignore`, `paths-ignore`                       | The same list with each pattern quoted and prefixed with `!`: `paths: ["!docs/**"]`                                 |
| `on: pull_request` with `branches`, `paths`             | `on: { pull-request: { branches, paths } }`. `types:` has no equivalent; every opened or updated pull request runs. |
| `on: schedule` with `cron`                              | `on: { schedule: [{ cron: "0 3 * * *" }] }`, UTC, runs the default branch's head                                    |
| `on: workflow_dispatch` with `inputs`                   | `on: { manual: { inputs } }`: types `string`, `boolean`, `choice` (with `options`), `number`                        |
| `on: push: tags`, `release`, `workflow_run`, and others | No equivalent: tag pushes start nothing. Keep the workflow on GitHub Actions, or start it by hand.                  |
| `env:` at the top                                       | No top-level `env`. Repeat it on each job, or share it with a YAML anchor (`env: &env {...}`, then `env: *env`).    |
| `concurrency:`                                          | `concurrency:` at the top only, `{ group, cancel-in-progress }`. A job-level `concurrency` has no equivalent.       |
| `permissions:`                                          | Per job, `github-token: { contents: write, pull-requests: write }`. No token at all unless a job asks.              |
| `defaults.run.working-directory`                        | `cwd:` on each job, absolute: `/app/<dir>`                                                                          |
| `defaults.run.shell`                                    | Always bash. A Python or Node step becomes `python - <<'EOF'` or `node -e` in the script, or a script file it runs. |

## Job level

| GitHub Actions                    | Infrawrench CI                                                                                                                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `runs-on: ubuntu-*`               | Nothing: the job runs on the runners. Choose `using:` for the language instead.                                                                                                                        |
| `runs-on: self-hosted` or a label | `cloud:` on a connected account (`aws/vm`, `gcp/container`, `docker/container`, `kind: host` for an existing machine over SSH).                                                                        |
| `steps:`                          | One `run: \|` script, the `run` steps joined in order. Each `uses:` step is replaced as in `actions.md`.                                                                                               |
| `needs:`                          | `needs:`                                                                                                                                                                                               |
| `if:`                             | `if:` on the job. Functions: `success()`, `failure()`, `always()`, `contains`, `startsWith`, `endsWith`, `changed('glob')`. No `cancelled()`, `format`, `toJSON`, `fromJSON` or `hashFiles` here.      |
| step-level `if:`                  | A shell `if` in the script, or a separate job with its own `if:`.                                                                                                                                      |
| `strategy.matrix`                 | `matrix: [a, b]` (read as `${{ matrix }}`) or named axes `{ node: [22, 24], os: [x] }` (read as `${{ matrix.node }}`), with `exclude:`. Up to 64 entries. No `include:`: write those as separate jobs. |
| `fail-fast`, `max-parallel`       | Leave out. Every entry runs; the runner schedules them.                                                                                                                                                |
| `continue-on-error`               | Leave out. Let the dependents run anyway with `if: always()`, and read `${{ needs.<job>.result }}`.                                                                                                    |
| `timeout-minutes: 30`             | `timeout: 30m`. The default is 10 minutes (GitHub's is 6 hours), the most 6 hours. Set it on anything that can take longer than 10 minutes.                                                            |
| `env:`                            | `env:`. `${{ secrets.X }}` works only here.                                                                                                                                                            |
| `outputs:` + `$GITHUB_OUTPUT`     | `outputs: [name]` and `echo "name=value" >> "$IWCI_OUTPUT"`. Writing an undeclared name fails the job. A matrix job cannot have outputs.                                                               |
| `services:` (Docker images)       | `services:` with `env:postgres@18` (`run: pglite-server`) or `env:clickhouse@26.11`, reached as `postgres:5432`. Other images: see `limits.md`.                                                        |
| `container:`                      | No equivalent on the runner. Choose the matching `using:` environment, or make it a cloud job with `image:`.                                                                                           |
| `environment:`                    | No equivalent. What a branch may use is set in **CI access** (connections, SSH keys and resources per repository and branch).                                                                          |
| `uses: ./.github/workflows/x.yml` | Inline the called workflow's jobs into this pipeline.                                                                                                                                                  |

## Expressions

| GitHub Actions                                      | Infrawrench CI                                                        |
| --------------------------------------------------- | --------------------------------------------------------------------- |
| `${{ github.sha }}`                                 | `${{ commit.sha }}` (`${{ commit.short-sha }}` for the short form)    |
| `${{ github.ref_name }}`, `github.head_ref`         | `${{ commit.branch }}`                                                |
| `${{ github.event_name }}`                          | `${{ event }}`: `push`, `pull-request`, `schedule` or `manual`        |
| `${{ github.event.pull_request.number }}`           | `${{ pull-request.number }}` (empty unless a pull request)            |
| `${{ github.workflow }}`                            | `${{ pipeline.name }}`                                                |
| `${{ github.repository }}`                          | `$GH_REPO` in a job with `github-token:`; otherwise write it out      |
| `${{ inputs.x }}` / `${{ github.event.inputs.x }}`  | `${{ inputs.x }}`, never inside `run:`: map it in `env:` and quote it |
| `${{ vars.X }}`                                     | `${{ vars.X }}`                                                       |
| `${{ secrets.X }}`                                  | `${{ secrets.X }}`, in `env:` values only                             |
| `${{ needs.a.outputs.b }}`, `${{ needs.a.result }}` | The same                                                              |
| `${{ matrix.x }}`                                   | The same; a one-axis list is `${{ matrix }}`                          |
| `${{ env.X }}`                                      | `$X` in the script                                                    |
| `${{ runner.os }}`, `${{ runner.temp }}`            | Always Linux-like; use `/tmp`                                         |
| `${{ hashFiles('x') }}`                             | Only in a `cache:` `key` or `restore-keys`                            |

## Environment variables in scripts

| GitHub Actions              | Infrawrench CI                                                                     |
| --------------------------- | ---------------------------------------------------------------------------------- |
| `GITHUB_SHA`                | `IWCI_COMMIT`                                                                      |
| `GITHUB_REF_NAME`           | `IWCI_BRANCH`                                                                      |
| `GITHUB_WORKSPACE`          | `/app` (the clone, and every job's default working directory)                      |
| `GITHUB_OUTPUT`             | `IWCI_OUTPUT`                                                                      |
| `GITHUB_ENV`, `GITHUB_PATH` | Not needed: the job is one script, so `export` and `PATH=...` carry to later lines |
| `GITHUB_STEP_SUMMARY`       | No equivalent; keep a report with `downloads:`                                     |
| `GITHUB_TOKEN`              | Set only in a job with `github-token:` (also `GH_TOKEN`)                           |
| `RUNNER_TEMP`               | `/tmp`. Files shared by the run's jobs go in `/tmp/workflow` (`$IWCI_SCRATCH`)     |
| `CI`                        | `CI=true`                                                                          |
