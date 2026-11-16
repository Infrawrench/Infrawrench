# What changes, and what does not move

Check each migrated job against this list before handing back.

## Defaults that differ

- **Timeout: 10 minutes**, not 6 hours. Set `timeout:` (`30m`, `2h`, at most `6h`) on any job that can run longer. A job that prints nothing and uses no CPU for 5 minutes is stopped as stuck.
- **Memory: 2 GiB** per job, up to `16GiB` with `memory:`. Large test suites and bundlers usually want `4GiB` or more; a job over its limit fails and its report says so.
- **One environment per job.** There is no image with everything installed. Pick the `using:` environment for the job's language, and add other tools with `tools: [builtin:...]`.

## Scripts

- **Pipes do not fail the script.** A pipeline reports only its last command's status, even with `pipefail`: `npm test | tee log.txt` passes when the tests fail. Write `npm test > log.txt 2>&1` and print the file afterwards, or drop the pipe.
- **No terminal.** Standard input is empty and nothing is a TTY, so prompts fail and colour is usually off. Pass non-interactive flags (`--yes`, `-y`, `--ci`).
- **No `sudo` and no `apt-get`.** The job's file system is its own; install command-line tools with `npm i -g` or `pnpm add -g` (pinned) in `env:bash-node`, or `pip install` in `env:python`. A system package means a cloud job.
- **No hard links**; programs that fall back to copying work. Symbolic links work.

## The checkout

- **No `.git`.** Jobs get the commit's files, not a repository: `git log`, `git describe`, `git diff origin/main` and tools that read history (changelog generators, semantic-release) fail. Clone in the script when history is needed, with `github-token: { contents: read }` for a private repository: `git clone --depth=50 "https://github.com/$GH_REPO.git" /tmp/repo`.
- **No submodules** and **no Git LFS content** (a file kept in LFS is its pointer). Fetch them in the script if a job needs them.
- What changed in the push is still known: use `paths:` on a job or `changed('glob')` in `if:` instead of `git diff`.

## Languages and native code

- **Node 24 only** on the runner (`env:bash-node@24`). A matrix over older Node versions becomes one job on 24, or cloud jobs for the others.
- **Native Node addons** load only when the package ships a WebAssembly (`wasm32-wasi`) build: Vite 8, Vitest, Rolldown, tsdown, oxc and the Astro compiler do. A dependency with only native binaries (some image, database and crypto libraries) needs a cloud job.
- **npm and Yarn lockfiles** are not installed by `workspace.deps` (it supports pnpm, Bun, Go, Cargo, pip and Composer). Convert with `pnpm import` and commit `pnpm-lock.yaml`, or run `npm ci` in the job's script (slower: it downloads on every run and is not checked against the lockfile).
- **Bun**: dependencies install from `bun.lock`, but scripts run with Node; there is no `bun` command.
- **Rust, Java, .NET, Ruby, Swift**: no environment yet. Cloud jobs.

## Services and containers

- **Postgres** (`env:postgres@18`, PGlite: many connections, `pgcrypto`) and **ClickHouse** (`env:clickhouse@26.11`) run as `services:` inside the job. Postgres runs one transaction at a time and shares `SET`, advisory locks and `LISTEN` across connections, so tests that depend on concurrent transactions need a real Postgres in a cloud job.
- **Any other service image** (Redis, MySQL, Elasticsearch, a vendor emulator): start it in a cloud job (`cloud: { provider: docker, kind: container }` or a VM with Docker), or, when it is a Node or Python program, as a `services:` entry running that program.
- **No Docker on the runner.** `docker build`, `docker run` and `docker compose` go in a cloud job: `kind: build` for building and pushing images, `kind: vm` or `container` for running them.
- **No browsers.** Playwright, Cypress and Puppeteer tests run as cloud jobs.

## Events and features with no equivalent

Keep these on GitHub Actions, or say what the user could do instead:

- Triggers other than push, pull request, schedule and manual: tags, releases, `workflow_run`, `issues`, `issue_comment`, `pull_request_target`, `repository_dispatch`, `merge_group`.
- macOS and Windows runners.
- GitHub Pages deployment through `actions/deploy-pages` (deploying the built site with a CLI from a job works).
- Job-level `concurrency`, `continue-on-error`, `fail-fast`, matrix `include:`.
- `environment:` protection rules and required reviewers. CI access limits what each repository and branch may use, and a fork's pull request waits for a maintainer's approval.
- OIDC (`id-token: write`) to a cloud. Lend the cloud's connection instead (`connections:`), which needs no stored key either.
