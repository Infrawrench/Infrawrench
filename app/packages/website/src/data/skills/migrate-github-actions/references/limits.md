# What changes, and what does not move

Check each migrated job against this list before handing back.

## Defaults that differ

- **Timeout: 10 minutes**, not 6 hours. Set `timeout:` (`30m`, `2h`, at most `6h`) on any job that can run longer. A job that prints nothing and uses no CPU for 5 minutes is stopped as stuck.
- **Memory: 2 GiB** per job, up to `16GiB` with `memory:`. Large test suites and bundlers usually want `4GiB` or more; a job over its limit fails and its report says so.
- **CPU: a share of one vCPU** per job, not a machine of its own, and its programs are told 1 CPU (`nproc`, `os.cpu_count()`, `os.availableParallelism()`), so anything that sizes its workers from the CPU count (`pytest -n auto`, Vitest, Jest, `cargo`, `make -j$(nproc)`) runs one. A job that builds or tests in parallel (`make -j`, `go test -p`, `cargo`, a test runner's workers) gets `cpus:` (1 to 64), whether or not it ran on a larger runner, and is then told that many: `-n auto` and `nproc` follow it, and a hard-coded count becomes `$IWCI_CPUS`. Billing follows: a job with `cpus: 4` is charged four vCPUs for as long as it runs.
- **One environment per job.** There is no image with everything installed. Pick the `using:` environment for the job's language, and add other tools with `tools: [builtin:...]`.

## Scripts

- **Pipes do not fail the script.** A pipeline reports only its last command's status, even with `pipefail`: `npm test | tee log.txt` passes when the tests fail. Write `npm test > log.txt 2>&1` and print the file afterwards, or drop the pipe.
- **No terminal.** Standard input is empty and nothing is a TTY, so prompts fail and colour is usually off. Pass non-interactive flags (`--yes`, `-y`, `--ci`).
- **No `sudo` and no `apt-get`.** The job's file system is its own; install command-line tools with `npm i -g` or `pnpm add -g` (pinned) in `env:bash-node`, or `pip install` in `env:python`. A system package means a cloud job.
- **Hard links work within the job's own files** (`ln`, `fs.linkSync`, `os.link`): the names are one file, with one inode number and a link count. A link to or from another mount (`/usr/local/bin`, the run's scratch directory) fails with `EXDEV`, which programs that link fall back to copying on, and caches, artifacts and `changes:` keep each name as a file of its own. Symbolic links work.

## The checkout

- **No `.git`.** Jobs get the commit's files, not a repository: `git log`, `git describe`, `git diff origin/main` and tools that read history (changelog generators, semantic-release) fail. Clone in the script when history is needed, with `github-token: { contents: read }` for a private repository: `git clone --depth=50 "https://github.com/$GH_REPO.git" /tmp/repo`.
- **No submodules** and **no Git LFS content** (a file kept in LFS is its pointer). Fetch them in the script if a job needs them.
- What changed in the push is still known: use `paths:` on a job or `changed('glob')` in `if:` instead of `git diff`.

## Languages and native code

- **Node 24 only** on the runner (`env:bash-node@24`). A matrix over older Node versions becomes one job on 24, or cloud jobs for the others.
- **Native Node addons** load only when the package ships a WebAssembly (`wasm32-wasi`) build: Vite 8, Vitest, Rolldown, tsdown, oxc and the Astro compiler do. A dependency with only native binaries (some image, database and crypto libraries) needs a cloud job.
- **npm**: `deps: [npm]` installs from `package-lock.json` (lockfile version 2 or 3; a version 1 lockfile needs `npm install --lockfile-version 3` with npm 7 or later). Do not keep `npm ci` in a job: npm refuses packages whose `os` list leaves out the job's platform. `npm run` scripts find their dependencies' commands in `node_modules/.bin`, as on a developer's machine.
- **Yarn lockfiles** are not installed by `workspace.deps` (it supports pnpm, npm, Bun, Go, Cargo, pip, Composer and Bundler). Convert with `pnpm import` and commit `pnpm-lock.yaml`.
- **Bun** is `tools: [builtin:bun@1]` (Bun 1.4.4, whose newest build `@1`, `@1.4` and `@1.4.4` all pick; `@1.3` and other versions do not exist), the real Bun run natively in a sandbox. Use it with `using: env:bash@5`, which has no `node`, so Bun runs package scripts, `#!/usr/bin/env node` bins and install scripts itself, and install in the job with `bun install --frozen-lockfile`, which gets the Linux builds of turbo, oxlint, esbuild and the like. `deps: [{ bun: { native: true } }]` instead installs once per lockfile, cached and checked against its hashes, with `node_modules/.bin` and the Linux builds of turbo and oxlint, so `bunx turbo` and `bun run lint` work over it; it runs no install scripts, and esbuild, Rollup and Lightning CSS are their slower WebAssembly builds there. Without `native: true` it has no native packages, and Bun fails over it. In `env:bash-node@24`, `node` is a WebAssembly Node (`process.platform` is `wasi`), and Bun runs install scripts with it, so a `postinstall` that loads a native package fails there. In `env:bash@5`, a file run with `bun run ./script.mts` that spawns `node` finds no `node`: link one, `ln -s "$(command -v bun)" /tmp/bin/node`, with `/tmp/bin` first on `PATH`. `env:bash@5` has no `npm`; use `bunx npm@11`. `cache:` `/root/.bun/install/cache`, keyed on `hashFiles('bun.lock')`, saves the downloads.
- **Ruby** (`env:ruby@3.4`, `@4.0`): gems with C extensions install only through `deps: [bundler]`, which has builds of the ones a `rails new` app locks (nokogiri, sqlite3, puma, bootsnap and the rest) at those versions; another one, or another version, fails the install naming the versions that have a build, and `- bundler: { without-extensions: [name] }` installs a gem the jobs never load without it. A Rails app needs `gem "tzinfo-data"` on every platform (no zoneinfo here; drop `platforms:`, then `bundle lock`) and `gem "selenium-webdriver", require: false` (it refuses to load here). No `fork`: Rails tests run in one process (`PARALLEL_WORKERS=1` is set), and system tests need a browser, so a cloud job. `bundle exec ruby` loses the bundle's settings; use `bin/rails`, `bundle exec rake` or `ruby -rbundler/setup`.
- **Rust**: `using: env:bash@5` with `tools: [builtin:rust@1.100]` (rustc, cargo, rustdoc, rustfmt, clippy, and GCC 13 with binutils for linking and for build scripts that compile C), and `workspace: { deps: [cargo] }` so crates come from `Cargo.lock` with no network. Give build and test jobs `memory: 4GiB` to `8GiB` (the `target/` directory counts). The builtin's version is the toolchain: `rust-toolchain.toml` is ignored and there is no `rustup`, so `rustup target add` and cross builds need a cloud job, as do crates that link a system library (OpenSSL without `vendored`) or need a C++ compiler. A built binary runs from the script as on Linux. It needs a runner with the native sandbox; a job on one without fails saying so.
- **Native binaries from npm packages** (Turborepo's `turbo`, sherif, and others that pick a per-platform optional dependency): `workspace: { deps: [{ pnpm: { native: true } }] }` (or `bun`) and `tools: [builtin:glibc@2.39]` on the `env:bash-node@24` job that runs them. Without both, the binary is missing or does not start. TypeScript 7 (`tsc` from `typescript@7`) works the same way. A tool that loads a native Node addon in-process with no WebAssembly build (oxlint) runs under Bun instead: `tools: [builtin:bun@1.4, builtin:glibc@2.39]` and `bun node_modules/oxlint/bin/oxlint`. A project that pins pnpm 12 (`packageManager` or `engines.pnpm`) switches to it in a job with `native: true` on its pnpm dep and `tools: [builtin:glibc@2.39]`.
- **Java, .NET, Swift**: no environment yet. Cloud jobs.

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
