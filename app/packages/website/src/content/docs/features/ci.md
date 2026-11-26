---
title: CI
description: Run your repositories' pipelines on every push and pull request, each job in its own WebAssembly sandbox, with results on GitHub, maintainer approval for pull requests from forks, secrets they never see, and usage billed by the second.
sidebar_order: 14
---

Infrawrench CI runs the pipelines in a repository's `.infrawrench/ci/` folder on every push and pull request. Each job runs in its own WebAssembly sandbox over a snapshot of the commit, so a job starts in the time it takes to load a program that is already compiled: there is no container to pull, no clone per job and no dependency install per job.

Moving from GitHub Actions? [Migrate from GitHub Actions](./ci-migrate-from-github-actions.md) has an agent skill that converts your workflows.

![The CI tab: the GitHub accounts card with two accounts (one with "Run CI" ticked), the usage card for this month, and the runs table with a passed push to main, a running pull request, and a pull request from a fork marked "Awaiting approval" with Approve and Reject buttons](https://agent-assets.infrawrench.com/docs-screenshots/features/ci/ci-tab-overview.png)

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

The next push runs it. Each run shows on the commit or pull request on GitHub as a check, **Infrawrench CI / push** or **Infrawrench CI / pull request**, so a branch with an open pull request shows both. The check's **Details** link opens the run in Infrawrench.

Repositories on git.infrawrench.com run the same pipelines with nothing to connect: every repository of your organization's namespace runs CI on a paid plan, and an administrator of a repository can switch CI off for it under **Settings > CI** on git.infrawrench.com (secrets, variables and approvals stay here in the app). Their runs are in the same list, link to the commit or branch page on git.infrawrench.com, and show there as commit statuses under the same names. In a list of chosen repositories under [CI access](#ci-access), one of these is written `git.infrawrench.com/namespace/name`; a plain `owner/name` is a GitHub repository. [GitHub tokens](#write-back-to-github) are for GitHub repositories only.

A push or pull request that no pipeline runs on (every pipeline's `on:` names other branches or events, or its `paths:` leave the change out) is not a run: nothing is sent to the runners, it is not billed, and the runs table leaves it out (pick **Nothing to run** under **Show** to list them). A push like that shows nothing on GitHub, so pushing to a branch with an open pull request leaves only the pull request's check. A pull request like that gets an **Infrawrench CI / pull request** check concluded as skipped, which a branch protection rule requiring that check accepts, so the pull request can still be merged.

Each job has its own check too, named after its pipeline and the event (**Test / build (pull request)**), which turns from waiting to running to passed or failed as the job does. A matrix's entries, or a `packages:` job's packages, share one check that lists each of them. Require the run's check (**Infrawrench CI / pull request**) in a branch protection rule: it covers every job, whichever jobs a change adds or removes.

Choosing accounts takes the `ci:write` permission; everyone in the organization can see runs (`ci:read`). See [Roles and permissions](../team-and-billing/roles-and-permissions.md).

## Environments

A job either runs a built-in tool (`using: builtin:typescript@7.1`) or runs a bash script (`run:`) in an environment:

| Environment                    | What it has                                                                      |
| ------------------------------ | -------------------------------------------------------------------------------- |
| `env:bash@5`                   | bash, coreutils, sed, grep and findutils                                         |
| `env:bash-node@24`             | the same, plus `node` (Node 24 compatible), `npm`, `pnpm` and `npx`              |
| `env:python@3.13`              | the same as `env:bash@5`, plus Python 3.13 with `pip`                            |
| `env:php@8.1` to `env:php@8.5` | the same as `env:bash@5`, plus PHP 8.1, 8.2, 8.3, 8.4 or 8.5 and Composer        |
| `env:go@1.23` to `env:go@1.27` | the same as `env:bash@5`, plus Go 1.23, 1.24, 1.25, 1.26 or 1.27 (`go`, `gofmt`) |
| `env:ruby@3.4`, `env:ruby@4.0` | the same as `env:bash@5`, plus Ruby 3.4 or 4.0 (`ruby`, `gem`, `bundle`, `rake`) |
| `env:postgres@18`              | the same as `env:bash@5`, plus PostgreSQL 18.4, for a job's `services:`          |
| `env:aws@1.46`                 | the same as `env:python@3.13`, plus the AWS CLI 1.46 (`aws`)                     |
| `env:az@2.92`                  | the same as `env:python@3.13`, plus the Azure CLI 2.92 (`az`)                    |
| `env:gcloud@593`               | the same as `env:python@3.13`, plus the Google Cloud CLI 593 (`gcloud`, `bq`)    |

`env:bash@5` and `env:bash-node@24` also have `tar`, `gzip` and `openssl` (OpenSSL 3.5.9, with Mozilla's CA certificates). `tar -z` works, and so does `openssl req -x509` for a test's self-signed certificate. Unix domain sockets on a path work between a job's processes (tsx's IPC, test runners' workers), and connecting to `::` or `0.0.0.0` reaches the job's own loopback, as on Linux.

In `env:python@3.13`, `pip install` works for pure Python packages and for packages with compiled code that have a WebAssembly build on Wasmer's wheel index, such as numpy, pandas, pydantic and cryptography. A package that has to be compiled while it installs does not. Packages install into the job's own copy of Python; `pip install --user` puts them in `/root/.local` with their commands on the `PATH`, and a virtual environment works when it copies the interpreter: `python -m venv --copies .venv` gives it its own pip, and after `source .venv/bin/activate`, `python` and `python -m pip` are the virtual environment's. pipx does not run. pip downloads while the job runs, so leave the job's network on (no `network: false`).

In the PHP environments, `composer install` and `vendor/bin/phpunit` work in the job's directory as they do on a developer's machine, and the common extensions are built in (intl, mbstring, PDO for SQLite, MySQL and PostgreSQL, curl, gd, sodium, zip and more). There is no Xdebug or PCOV, so no code coverage. Composer downloads while the job runs, too.

A Ruby project lists `bundler` under `workspace.deps` (`- bundler: { dir: api }` for a Gemfile below the root). Its gems are installed from `Gemfile.lock` into `vendor/bundle` before the jobs start, each checked against the lock's checksums, and a job runs `bundle exec rspec` (or `rails test`, `rake`) with no network. The lock needs a `CHECKSUMS` section, which Bundler 2.6 and later write (`bundle lock --add-checksums` adds one to an older lock), and the `ruby` platform, which a lock from `rails new` lacks: run `bundle lock --add-platform ruby` on its own and commit the result. Gems from a git repository are fetched by the commit the lock names. A job cannot compile C extensions, so gems that have one come with a build Infrawrench CI makes ahead of time: those of a `rails new` app (nokogiri, sqlite3, puma, bootsnap, msgpack and the rest) at the versions Rails 8.1 locks, and the PostgreSQL and MySQL drivers (pg 1.7.0, mysql2 0.5.7 and trilogy 2.13.3), for Ruby 3.4 and 4.0. pg talks to the [PostgreSQL service](#background-services); mysql2 and trilogy reach a MySQL server over the job's network, such as a [lent connection](#connections), since there is no MySQL service. A gem with a C extension and no build of the locked version stops the install before the jobs start, and the message names the versions that have one. If your jobs never load a gem's compiled part, list it to install it without one: `- bundler: { without-extensions: [redcarpet] }`.

A Rails app's tests run with `bin/rails test`:

```yaml
workspace:
  deps: [bundler]
jobs:
  test:
    using: env:ruby@4.0
    network: false
    run: bin/rails test
```

Tests run in one process: there is no `fork`, so Rails' parallel workers are turned off for you (`PARALLEL_WORKERS=1`), and a suite that wants them in threads can use `parallelize(with: :threads)` and set `PARALLEL_WORKERS` in the job's `env:`. Two lines of a `rails new` Gemfile need changing: `gem "tzinfo-data"` on every platform (drop its `platforms:`, then `bundle lock`), since a job has no system time zone files, and `gem "selenium-webdriver", require: false`, since Rails loads it with the other test gems and it refuses to load on a platform it does not know. System tests need a browser, which a job does not have; run them as a [cloud job](#cloud-jobs).

A project that installs with npm lists `npm` under `workspace.deps`. Its `node_modules` is installed from `package-lock.json` (or `npm-shrinkwrap.json`) before the jobs start, in the tree `npm ci` would make, workspaces linked and every package checked against the lockfile's hashes; the registry in your `.npmrc` is used, as npm uses it. Install scripts do not run, and the run's warnings name the packages that have one. A job runs `npm test` and `npm run` with npm itself. Commit a lockfile from npm 7 or later (`lockfileVersion` 2 or 3): an older one is refused with the command that updates it, as is a lockfile that is behind `package.json`. Do not run `npm ci` in a job: npm refuses packages that list the operating systems they run on, since a job's platform is none of them.

A project that installs with Bun lists `bun` under `workspace.deps` instead of `pnpm`. Its `node_modules` is installed from `bun.lock` before the jobs start, laid out the way `bun install` lays it out and checked against the lockfile's hashes, and the jobs run its scripts with `node`. For Bun itself (`bun test`, `bun run`, the `Bun` APIs), list `builtin:bun@1.4` under `tools:`: the official Bun 1.4 release runs natively in a gVisor sandbox beside the job's environment, with `bun` and `bunx` on the script's `PATH` and the environment's commands (`bash`, `node`, `git`) on Bun's. Such a job runs `bun install --frozen-lockfile` itself, which brings the Linux builds of native packages (turbo, oxlint, esbuild) that `workspace.deps` leaves out, and is best on `env:bash@5`: with no `node` there, Bun runs package scripts and install scripts itself, where the `node` of `env:bash-node` is a WebAssembly build that cannot load those packages. Commit the text lockfile: a repository with only the older binary `bun.lockb` is told to run `bun install --save-text-lockfile --frozen-lockfile --lockfile-only`.

With `pnpm`, `npm` or `bun`, each `node_modules` gets a `.bin` with your dependencies' commands, so `pnpm run lint` finds `eslint` and `pnpm test` finds `vitest`, as on your machine. Packages that ship native code use their WebAssembly build where they publish one, since a job cannot start native programs: most come with it as an optional dependency, and Rollup 4, esbuild and Lightning CSS, which publish theirs separately, are installed as `@rollup/wasm-node`, `esbuild-wasm` and `lightningcss-wasm` at the version your lockfile pins (checked against the hash the npm registry publishes for it), so Vite, Vitest and their builds work without any change to your repository. Tailwind CSS 4 builds too, on `env:bash-node@24` from 24.0.22.

```yaml
jobs:
  test:
    using: env:python@3.13
    run: |
      pip install -r requirements.txt
      pytest
```

`env:aws`, `env:az` and `env:gcloud` have a cloud provider's CLI ready to use, apart from whatever the job installs with pip. [Lend the job a connection](#connections) and the CLI is signed in: `aws` reads the lent session, `gcloud` the lent access token, and `az` signs in with the lent service principal on its first command. They run unattended: no pager, no prompts, no update checks, and no waiting on a cloud's instance metadata service, which a job cannot reach.

```yaml
jobs:
  deploy:
    using: env:aws@1.46
    connections: [Production AWS]
    run: |
      aws s3 sync dist/ s3://my-site --delete
      aws cloudfront create-invalidation --distribution-id E123EXAMPLE --paths '/*'
```

The AWS CLI is version 1, which AWS keeps in maintenance until July 2027: version 2 needs AWS's C runtime, which has no WebAssembly build yet. Its commands are the same for deploys (`s3`, `s3api`, `ecr get-login-password`, `cloudformation deploy`, `lambda update-function-code`, `eks update-kubeconfig`), but it gets no new services. In `env:gcloud` there is no `gsutil` (use `gcloud storage`) and no components, so `gke-gcloud-auth-plugin` is not available: a kubeconfig for GKE needs a token in it, such as `gcloud auth print-access-token`. A kubeconfig from `aws eks update-kubeconfig` runs `aws eks get-token` for its token, which `env:aws` has.

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

Rust compiles with `tools: [builtin:rust@1.100]`: the official Rust 1.100 toolchain (`cargo`, `rustc`, `rustdoc`, `rustfmt` and clippy) runs as a real Linux program in a sandbox beside the job's environment, with GCC 13 (`cc`) and binutils so it links, and so build scripts that compile C work (the `cc` crate, `ring`, `pcre2-sys`, bundled SQLite). List `cargo` under `workspace.deps` and your crates are installed from `Cargo.lock` before the job, each checked against the lock's checksum, so `cargo test` needs no network. The build goes to `target/` in the job's own files, which count against its `memory:`, so give build and test jobs 4 to 8 GiB.

```yaml
workspace:
  deps: [cargo]
jobs:
  test:
    using: env:bash@5
    tools: [builtin:rust@1.100]
    memory: 8GiB
    run: cargo test --locked --workspace
  lint:
    using: env:bash@5
    tools: [builtin:rust@1.100]
    memory: 4GiB
    run: |
      cargo fmt --all --check
      cargo clippy --locked --workspace --all-targets -- -D warnings
```

The toolchain is the builtin's: `rust-toolchain.toml` is not read and there is no `rustup`, so pick the builtin version your project needs. It has the runner's own target only, and no C++ compiler or system libraries beyond the C library, so a crate that links a system library (OpenSSL without its `vendored` feature, for example) needs a [cloud job](#cloud-jobs). A program your build produces runs as it would on Linux, from the script (`./target/release/app --version`) or from cargo. Rust jobs run only on runners with the native sandbox turned on; on a runner without it the job fails and says so.

Some npm packages ship their program as a Linux binary in a per-platform package, with a small script that starts it: Turborepo (`turbo`), sherif and others. To run them, add `native: true` to the install and run the job in the sandbox with `builtin:glibc@2.39`, the C library on its own:

```yaml
workspace:
  deps: [{ pnpm: { native: true } }]
jobs:
  lint:
    using: env:bash-node@24
    tools: [builtin:glibc@2.39]
    run: pnpm lint
```

`native: true` also installs the runner's Linux builds of your packages and makes the job's `node` report Linux as its platform, so the package's script finds its binary. Without the sandbox, the binary does not start, and the job's log says what it needs.

In `env:ruby`, `bundle install`, `gem install`, `rake` and `ruby` work as on a developer's machine, with the gems that ship with Ruby (minitest, test-unit, rake and the rest) already there. Gems install into the job's own `GEM_HOME`, with their commands on the `PATH`, and download while the job runs, so leave the job's network on. Threads, sockets, TLS and child processes (`system`, backticks, `Open3`) work, with real exit statuses; `fork` raises `NotImplementedError`, and a gem with a C extension that has to be compiled while it installs does not install: install those through `deps: [bundler]`, which brings a build of the common ones.

```yaml
jobs:
  test:
    using: env:ruby@4.0
    run: |
      bundle install
      bundle exec rake test
```

In `env:bash-node`, a job can install a command-line tool for itself with `npm i -g`, `pnpm add -g`, `npx` or `pnpm dlx`, and run it by name. These fetch from the npm registry while the job runs and, unlike your repository's dependencies, are not checked against a lockfile, so pin an exact version. The tool is gone when the job ends; to keep it between runs, cache `/root/.local/share/pnpm`, where global installs go:

```yaml
jobs:
  deploy:
    using: env:bash-node@24
    cache:
      key: global-clis-1
      paths: [/root/.local/share/pnpm]
    run: |
      npm i -g some-cli@4.2.1
      some-cli deploy
```

A job can also run the package manager itself (`deps: false` and `pnpm install`, `npm ci` or `pnpm add`). It installs as on any machine, including switching to the pnpm version your `packageManager` field names, but takes three to four and a half times as long as pnpm natively (under a minute to a minute and a half for a monorepo of 1,500 packages) and keeps both pnpm's store and a copy of every package in the job's memory (with `npm_config_package_import_method: hardlink` in the job's `env:`, pnpm links the packages out of its store instead, and each file's bytes are kept once). Install scripts that fetch a native binary, such as esbuild's, fail; `--ignore-scripts` skips them. `workspace.deps` installs once per run, natively, and is the faster way to install your repository's dependencies.

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

In `env:bash-node`, `node` runs TypeScript the way Node 24 does, by stripping the types: `node script.ts`, and `require` or `import` of `.ts`, `.mts` and `.cts` files, so an `eslint.config.ts` (with `--flag unstable_native_nodejs_ts_config`) or a Vite or Prettier config written in TypeScript loads as it does on your machine. As in Node, nothing is type checked, syntax that needs more than stripping (`enum`, `namespace`) needs `--experimental-transform-types`, `--no-experimental-strip-types` turns it off, and files under `node_modules` are never stripped. With `NODE_COMPILE_CACHE` set, the stripped source is cached too.

### Deployment CLIs

The Vercel CLI, Wrangler, Cloudflare's new `cf` and the Neon CLI are built in. List them under `tools:` in a job on `env:bash-node@24` and run them by name:

```yaml
jobs:
  deploy:
    using: env:bash-node@24
    tools: [builtin:vercel@65, builtin:wrangler@4, builtin:neon@9]
    env:
      VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
      CLOUDFLARE_ACCOUNT_ID: ${{ vars.CLOUDFLARE_ACCOUNT_ID }}
      NEON_API_KEY: ${{ secrets.NEON_API_KEY }}
    run: |
      vercel deploy --prebuilt --prod --yes
      wrangler deploy
      neon branches create --project-id my-project --name pr-${{ pull-request.number }}
```

| Tool                    | What it is                                                      |
| ----------------------- | --------------------------------------------------------------- |
| `builtin:vercel@65`     | The Vercel CLI 65.17                                            |
| `builtin:wrangler@4`    | Wrangler 4.163, for Workers and Pages                           |
| `builtin:cf@1.0.0-rc.0` | Cloudflare's `cf`, a release candidate (name the exact version) |
| `builtin:neon@9`        | The Neon CLI 9.5 (the successor to `neonctl`)                   |

Each one is pinned with every package under it, so nothing is downloaded while the job runs, and each reads its token from the environment (`VERCEL_TOKEN`, `CLOUDFLARE_API_TOKEN` with `CLOUDFLARE_ACCOUNT_ID`, `NEON_API_KEY`) and never prompts. Telemetry and update checks are off.

Jobs run in an isolate that cannot start native programs, so a few things work differently:

- `wrangler deploy` bundles your Worker with the WebAssembly build of esbuild. `wrangler deploy --no-bundle` uploads a Worker you built in an earlier job as it is.
- Anything that runs a Worker locally needs `workerd`, Cloudflare's local runtime, which cannot run here: `wrangler dev`, `--local`, `cf dev` and `@cloudflare/vitest-pool-workers` stop with a message that says so. Use `wrangler dev --remote`, or a [cloud job](#cloud-jobs).
- `cf deploy <dir>` deploys a folder of static files. For a Worker with server-side code, use `wrangler deploy`, as Cloudflare recommends until a project moves to `cloudflare.config.ts`.
- `vercel deploy` (which builds on Vercel) and `vercel deploy --prebuilt` both work. `vercel build` runs your framework's build inside the job.

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

## Linux machines

A job that needs a whole operating system, such as Docker or a native compiler, can run its script in a Linux virtual machine of its own instead of the WebAssembly sandbox, with `platform: linux`:

```yaml
jobs:
  test:
    platform: linux # Ubuntu 24.04
    run: |
      npm ci
      npm test
    artifacts: [dist]
```

`platform:` is `wasm` (the sandbox, the default) or `linux`. The machine is new for each job and is gone when it ends. Its tools are close to GitHub's hosted Ubuntu 24.04 runner, without its largest SDKs (Android, .NET); a job installs anything else in its script, and `cache:` keeps it between runs. It has Bun, `nvm`, `rbenv` (with ruby-build) and `goenv` too, and keeps the Node.js, Ruby and Go versions they install between runs of a job on its own: `nvm install 22`, `rbenv install 3.4.9` or `goenv install 1.24.11` downloads or compiles once, and the next run starts with it. A directory the job's own `cache:` keeps is left to that entry. `env-cache: false` turns that off. The script runs in `bash`; `shell:` picks `sh` or `pwsh` instead.

A machine job gets the same files a sandbox job would: the commit, the artifacts of the jobs it `needs:`, and its caches. Its own `artifacts:`, `downloads:`, `cache:`, outputs and `/tmp/workflow` work as for any job, so sandbox and machine jobs can hand files to each other. Its `memory:` is the whole machine's: 2 GiB unless it says, and at least 256 MiB. What the job writes is kept in that memory, and when its files and programs need more than that, the machine swaps to a disk of its own (up to 20 GiB) rather than running out. If it does run out, the job's output ends with what the machine's kernel said: the allocation that found no memory, the swap it had left and the process it stopped. Its network reaches the same places as any job's, and `network: false` turns it off. The machine's link to the runner never leaves the runner, so its `eth0` has a 65,000-byte MTU and downloads (image pulls, `apt-get`, package installs) run at about the speed the runner itself gets.

Google Chrome is installed (x86_64), as on GitHub's runner, so Playwright's `install --with-deps chrome` takes seconds. `apt-get install` uses Ubuntu's live archive. Docker runs, with its storage on the machine's disk.

A machine has no `using:`, `deps:`, `tools:`, `services:` or `task-cache:`: its script installs and starts what it needs (`npm ci`, `docker run -d postgres`).

`changes: fail` and `changes: { commit: ... }` count only what git would see: a new file that the repository's `.gitignore` ignores, such as `node_modules` or a build folder, is not a change, in a machine or in the sandbox.

### Install scripts

The install of a workspace's `deps:` runs no package's install script. With `install-scripts: true` at the top of the pipeline, a workspace with a pnpm, npm or Bun install also runs the scripts its package manager would have run (`postinstall`, native builds, the project's own `prepare`) in a Linux machine, and every job starts from what they wrote:

```yaml
install-scripts: true
workspace:
  deps: [pnpm]
```

Which packages' scripts run is your package manager's setting: pnpm's `allowBuilds` (or `onlyBuiltDependencies`), npm's `allowScripts`, and Bun's `trustedDependencies` or its built-in list of trusted packages. The run shows which were left out. When nothing is left to run, no machine starts. What the scripts wrote is kept for the same commit, so a retried run reuses it; a new commit runs them again.

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

The runs table lists the latest runs, newest first, with their status, where they came from (a branch, or a pull request and its branch) and how long they took. Filter it by status with **Show**. Pushes and pull requests no pipeline ran on are left out unless you pick **Nothing to run** there.

Open a run to see its jobs. The sidebar lists every job, with a matrix's entries and a `packages:` job's packages grouped under the job they were written as. **Summary** draws each pipeline as a graph: a box per job, below the jobs it needs, each with its status and how long it took. Drag to move around it, zoom with the buttons (or Ctrl and the scroll wheel), **Fit** to see all of it and **Expand** to fill the window. Click a job, in the graph or the sidebar, to read its output.

![The CI run page: the sidebar of jobs with a package group expanded, and the Summary graph of a running run with passed, running, failed and waiting jobs](https://agent-assets.infrawrench.com/docs-screenshots/features/ci/run-summary-graph-running.png)

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

![A failed CI run's page with the Retry and Retry without cache buttons beside "Open on GitHub", and below the header the "Retried as run 5e6f7a8b" link to its retry](https://agent-assets.infrawrench.com/docs-screenshots/features/ci/run-failed-retry.png)

A retry joins its pipelines' [concurrency groups](#concurrency-groups) like any other run, as the newest run of each.

### Re-run from GitHub

GitHub's own **Re-run** buttons retry a run too, for anyone GitHub lets use them (people with write access to the repository):

- **Re-run** on one of the checks retries the run behind it. On a job's check (**Test / build (pull request)**) that is still the whole run: a runner runs a commit's pipelines, not one job of them. Jobs with `task-cache:` whose inputs have not changed come back from the task cache, as with **Retry**, so a re-run after a flaky failure reruns little else. The new run's check says it is a retry.
- **Re-run all checks** on the commit retries the newest run of each push and pull request on that commit. **Re-run failed checks** retries the runs those checks belong to, once each.

A re-run is a retry like one from Infrawrench, with a few differences, because nobody signed in to Infrawrench asked for it:

- It is recorded in the audit log as a retry with the GitHub login of whoever clicked, and no Infrawrench user.
- A pull request from a fork waits as **Awaiting approval** again, for someone with `ci:approve` to approve it in Infrawrench. A GitHub login does not approve a fork's code.
- Scheduled and manual runs are only started again from Infrawrench; re-running their checks on GitHub says so on the check.
- A run that has not finished yet is left as it is, and its check says to re-run it once it has. A run waiting for approval or rejected is left as it is too.
- Each run is retried once, however many of its checks are re-run: re-running several checks of the same run, or GitHub sending a request twice, starts one run. Re-run again once the retry's own checks are on the commit.

Re-running checks through GitHub's API (`POST .../check-runs/{id}/rerequest` or `.../check-suites/{id}/rerequest`) is only open to the app that made the checks, so a personal token gets an error there: use the buttons, or [retry from Infrawrench](#retry-a-run) or through its API.

### Cancel a run

A run that has not finished (**Queued**, **Waiting** or **Running**) has a **Cancel** button, on its page and in the runs table. A run that has not started ends as **Cancelled** at once. A running one is stopped by its runner: running jobs are stopped as a timeout would stop them (their background services too), jobs that had not started never start, and the run shows **Cancelling…** until the runner has stopped it, a few seconds later. It then ends as **Cancelled**, and so does its check on GitHub. A job that failed before the cancel keeps the run **Failed**. Jobs are billed for the time they ran.

Cancelling takes the `ci:approve` permission, like retrying, and is recorded in the audit log. A run waiting for approval is rejected rather than cancelled.

![A running CI run's page with the Cancel button beside "Open on GitHub", and below the header the line "Concurrency groups: ci-main"](https://agent-assets.infrawrench.com/docs-screenshots/features/ci/run-running-cancel.png)

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

## Schedules

A pipeline can also run on a timer. List up to 16 cron expressions under `on.schedule`, always in UTC:

```yaml
name: Nightly

on:
  schedule:
    - cron: "0 3 * * *"
    - cron: "@weekly"
```

An expression has five fields (minute, hour, day of month, month, day of week) and takes `*`, numbers, ranges (`9-17`), steps (`*/15`), lists (`1,15`), month and weekday names (`jan`, `mon-fri`), Sunday as 0 or 7, and `@hourly`, `@daily`, `@weekly`, `@monthly` and `@yearly`. When both day fields are set, a day matching either one runs. A pipeline can have `schedule` beside `push` and `pull-request`; `${{ event }}` is `schedule` in a scheduled run.

When a cron is due, that one pipeline runs on the head of your default branch, as it was at the latest push Infrawrench saw, the way a push to it would: with your secrets, and reading and writing the default branch's caches. The other pipelines of the commit do not run. The runs table shows it as **Scheduled** with the pipeline file, and GitHub shows it on that commit as **Infrawrench CI / schedule**, a check of its own, so a branch protection rule that requires **Infrawrench CI / push** never waits on a scheduled run.

Schedules are read from the default branch each time you push to it, so the push that adds, changes or removes a schedule is what makes it take effect. A repository that already had scheduled pipelines when you turned CI on for it starts with its next push to the default branch. The **Schedules** card on the CI page lists each repository's scheduled pipelines, their crons and when each runs next, and says when a pipeline file could not be read.

![The CI page's Schedules card: one repository on main with a "Nightly" pipeline (0 3 * * *) and its next run time, and a second repository with a red "The last read failed" line](https://agent-assets.infrawrench.com/docs-screenshots/features/ci/schedules-card.png)

A scheduled run starts in the minute it is due. If runs could not be started for a few minutes, the ones missed in the last five start as soon as they can; older ones are skipped rather than run late. A scheduled run can use what [CI access](#ci-access) allows on your default branch, joins its pipeline's [concurrency group](#concurrency-groups) like any other run, and is billed like any other: your plan has to include CI. A repository the GitHub App can no longer read stops running its schedules after a day.

## Start a pipeline by hand

A pipeline with `on.manual` can be started from the CI page, on a branch you choose, with values you fill in. Declare what it asks for under `inputs`:

```yaml
name: Purge the CDN cache
on:
  manual:
    inputs:
      urls:
        description: URLs to purge, one per line. Empty purges everything.
      zone:
        type: choice
        options: [www, docs, app]
        default: www
      dry-run: { type: boolean }
jobs:
  purge:
    using: env:bash-node@24
    if: "!inputs.dry-run"
    env:
      URLS: ${{ inputs.urls }}
      ZONE: ${{ inputs.zone }}
    run: node scripts/purge.mjs --zone "$ZONE" --urls "$URLS"
```

An input is a `string` (the default), a `boolean`, a `choice` among its `options`, or a `number`, with an optional `description`, `default` and `required: true`. `manual:` on its own, with no inputs, works too, and a pipeline can have `manual` beside `push`, `pull-request` and `schedule`; in any other run an input reads as its default. `${{ event }}` is `manual` in a run started by hand.

**Inputs are data, never code.** Whoever starts a run types them, so `${{ inputs.<name> }}` is refused in a `run:` script (and in a service's `run:` and `ready.command`, and in a one-line `args:`), and the push that adds one there fails with the reason. Put the input in a variable with `env:`, as above, and quote the variable in the script: a value holding `$(...)`, quotes or new lines is then only ever those characters. Inputs also work in `name`, `cwd`, `if:`, `concurrency:` and as one element of a list `args:`.

The **Manual runs** card on the CI page lists each repository's pipelines with `on.manual`, as read from its default branch. **Run** opens a form built from the inputs: pick the branch (your default branch unless you change it), fill in the values and **Start run**. The values are checked against the inputs before the run starts (a missing required input, a number that is not one), and again by the runner against the pipeline file on the branch you chose, so a branch that changes the inputs gets its own checked. The run opens as soon as it is queued.

![The Run dialog for "Purge the CDN cache" open over the CI page's Manual runs card, with the branch field, a urls text box, a zone dropdown on "www" and a dry-run checkbox](https://agent-assets.infrawrench.com/docs-screenshots/features/ci/manual-run-dialog.png)

A run started by hand runs that one pipeline on the head of the branch, the way a push to that branch would: with your secrets, only what [CI access](#ci-access) allows on that branch, and that branch's caches. The runs table shows it as **Started by hand** with the pipeline file, its page lists the inputs it was started with and who started it, and GitHub shows it on the commit as **Infrawrench CI / manual**, a check of its own, so it never stands in for a branch protection rule's required check. It joins its pipeline's [concurrency group](#concurrency-groups) like any other run, can be retried and cancelled, and is billed like any other.

Starting a run takes the `ci:approve` permission, the same as retrying one, and each start is recorded in the audit log with the repository, pipeline, branch, commit and inputs. Inputs are not secret: they are in the run's page and the audit log, so put a secret in [secrets](#secrets-and-variables) instead. Only branches of the repository itself can be started, never a fork's.

Scripts start one with `POST /api/org/{orgId}/ci/runs` (`installationId`, `repoFullName`, `pipelineFile`, optional `branch` and `inputs`), and list what can be started with `GET /api/org/{orgId}/ci/manual`.

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

![The CI run page on Summary, below the graph: the Downloads list with app.tar.gz from the build job and junit.xml from the e2e job, each with its size, "Kept until" date and a Download button](https://agent-assets.infrawrench.com/docs-screenshots/features/ci/run-downloads.png)

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

## Write back to GitHub

A job that pushes a tag or a branch, opens or edits a pull request or an issue, or publishes a release asks for a GitHub token with `github-token:`, naming the permissions it needs:

```yaml
jobs:
  release:
    using: env:bash@5
    tools: [builtin:gh@2.104]
    github-token: { contents: write, pull-requests: write }
    run: |
      git tag "v$VERSION" && git push https://github.com/acme/web.git "v$VERSION"
      gh release create "v$VERSION" --notes-file CHANGELOG.md
```

- **For this repository only.** The token is minted when the run is sent, from the Infrawrench GitHub App's installation on the account, for the run's own repository and exactly the permissions the job names: `actions`, `checks`, `contents`, `deployments`, `discussions`, `issues`, `packages`, `pages`, `pull-requests` or `statuses`, each `read` or `write`, using GitHub Actions' names.
- **Ready to use.** The job gets it as `GH_TOKEN` and `GITHUB_TOKEN`, the repository as `GH_REPO` (so `gh` needs no checkout), and Git is set up to send it to the repository, so `git push`, `git fetch` and `git ls-remote` work with no credential helper. It is masked like a secret in every log and output.
- **An hour.** GitHub's tokens last an hour from when the run is sent. A job that starts after its token has expired fails before it starts; one that may run past it is told so in its report.
- **Only what the App has.** If the installation was not granted a permission the job asks for, the job fails before it starts and names the permission. An owner of the GitHub account grants it from the installation's settings on GitHub. Branch protection and rulesets apply to the token as they do to the App.
- **Never for a fork.** A pull request from a fork never gets a token; a job of it that asks for one fails. Jobs that do not ask get nothing.

Each token is recorded in the audit log, with the run, the repository and the permissions. `builtin:gh` is the GitHub CLI, which reads the token on its own.

## Secrets and variables

Under **Secrets and variables**, choose an account and a scope: **Every repository** for the account, or one repository, whose own values override the account's of the same name. Pipelines read them as:

- `${{ secrets.NAME }}` in a job's `env:` value. A secret's value is hidden once saved: you can replace or remove it, but nobody can read it back, and it is masked as `***` in every log and output.
- `${{ vars.NAME }}` anywhere an expression works. Variables are not secret.

Names are letters, digits and `_`, not starting with a digit. Managing them takes `ci:write`.

![The Secrets and variables card with the account picker on "acme", the scope on "Every repository", one secret NPM_TOKEN shown as Hidden and one variable REGION = eu-west-1, and the add form below](https://agent-assets.infrawrench.com/docs-screenshots/features/ci/secrets-and-variables.png)

## CI access

Jobs can use what your organization has connected to Infrawrench, once someone turns it on: run on a cloud connection, use a connection's credentials, read a resource's outputs, or use an SSH key. Everything is off until then, and each permission says which repositories and branches it holds for. A run from a fork's pull request gets none of it.

Everyone who can see runs can see the **CI access** card. It lists each connection that runs jobs or lends its credentials on one line, with what it does and for which repositories and branches; choose a line, or **Manage connections**, to open every connection that can do either, with the chosen one's settings beside the list. On a phone the list comes first, and choosing a connection opens its settings with a way back. Changes to a connection take effect when you **Save**; leaving with changes unsaved asks first. While a change could not be saved (running jobs with no kind chosen, say), **Save** stays off and the reason is shown beside it, as is anything the server refuses. Lending a connection, granting a resource and running cloud jobs on a connection take `ci-access:write`, which admins and owners hold; `ci:write` alone can only remove a grant or revoke a lent key. An SSH key is lent by its owner, with `ssh-keys:write`. None of this can be changed with an API key or by an agent: a person decides what CI jobs may use. Every change, and every time a run is lent something, is recorded in the [audit log](../team-and-billing/audit-log.md), with who allowed it.

![The CI access card: a Google Cloud connection "Infrawrench GCP" on one line with the chips "Runs jobs · Compute Engine instance, Cloud Run job" and "All repositories · main, release/*", a Kubernetes connection "Production cluster" with "Lends credentials" and "acme/web · main", the Manage connections button above them, the wide "Search for resources" field, and one granted resource and one lent SSH key as compact rows](https://agent-assets.infrawrench.com/docs-screenshots/features/ci/access-card.png)

![The Manage connections dialog: the connection list on the left with a search field and an on dot beside Infrawrench GCP and Production cluster, and Infrawrench GCP's settings on the right with "Run jobs on it" switched on, Compute Engine instance and Cloud Run job ticked and "Ready", 2 jobs at once and 60 minutes per job, the branches "main, release/*", and Cancel and Save at the bottom](https://agent-assets.infrawrench.com/docs-screenshots/features/ci/manage-connections.png)

### Repositories and branches

Each permission holds for **Every repository** CI runs for, or, with **Chosen repositories**, the ones you tick, and for every branch (the branch field left empty) or the branches matching a pattern: globs separated by commas, where `*` stops at `/` and `**` does not (`main, release/*`). A pattern of only commas or spaces is refused. A pull request is checked by its head branch, so `main` keeps a pull request from using a production cluster. A [scheduled run](#schedules) is checked by your default branch, which it runs on, so it gets what a push to the default branch gets, and a [run started by hand](#start-a-pipeline-by-hand) by the branch it was started on.

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

`cloud: aws/vm` is the short form. To let jobs run on a connection, open it under **Manage connections**, switch on **Run jobs on it**, then tick the kinds jobs may use. Ticking a kind checks its permissions first, and it stays ticked once the check passes; **Check permissions** beside a kind runs the check again. The check asks the provider without starting anything, and says exactly which permission the connection's credential lacks and where to grant it; a kind that fails it cannot be turned on. Then set how many of its jobs may run at once and how long one may take.

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

The check beside each kind names what that provider's credential needs, and links to where to grant it. A cloud job's machine needs `bash`, `curl`, `tar`, `gzip` and `base64`. Where one is missing and the job is root on a fresh machine or container, it is installed first with the image's package manager (apt, apk, dnf, yum, zypper or pacman). An image where that cannot be done fails the job at once and its log names what is missing.

The job starts from the commit as a source archive: the commit's files, without a `.git` directory, history or submodules, and with Git LFS pointers rather than the files they stand for. A job that needs any of those fetches it in its own script.

What a cloud job is lent works the way it does on the runner, on any provider and kind:

- **SSH keys and SSH hosts** are written to `~/.ssh` of the user the job runs as, and host keys are checked against the ones pinned in Infrawrench, which a lent host brings as a `known_hosts` line any OpenSSH reads. When the image has no `ssh`, OpenSSH's client is installed from the image's packages.
- **A cluster** is a kubeconfig with `KUBECONFIG` (and `KUBE_CONFIG_PATH`, for Terraform's providers) pointing at it. When the image has no `kubectl`, the job gets Kubernetes' own build of it on its `PATH`, checked against its published checksum. The kubeconfig always carries a token or a client certificate, never a sign-in helper such as `aws eks get-token`, so it works on a machine with no cloud CLI.
- **Resources** are environment variables, as on the runner.

A job that does not run as root (some images, every Heroku dyno) gets the same: the files go to that user's home directory, and if it cannot write `/app` it runs in a directory of its own with the clone inside (`$PWD` says where). The machine's own network decides what the job reaches, so a host on a private address is reachable without a jump host when the machine sits in the same network.

An SSH host is not created for the job and is not removed after it: the job runs as the connection's user in a work directory of its own under `~/.infrawrench-ci`, with its clone, `HOME` and anything lent to it inside, and the directory and everything the job started are removed when it ends. Two jobs on one host never share a directory. The host is reached the way the terminal reaches it, through its jump host and only with the host key pinned in Infrawrench. `ssh` reads its configuration from the user's real home directory, which is not the job's, so a job on an SSH host that is lent another SSH connection has its `ssh`, `scp` and `sftp` pointed at the lent configuration: `ssh web-1` works as written. Nothing is installed on the host: a job that is lent an SSH connection needs the host to have `ssh`.

![A cloud job selected on the run page: the "Cloud job" badge reading "Production · vm · t3.large · eu-west-1", the state "Running on its machine", the instance label "aws ec2 i-0abc… (eu-west-1)", and the job's log streaming below](https://agent-assets.infrawrench.com/docs-screenshots/features/ci/cloud-job-running.png)

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

Names are the connections' names in Infrawrench. To lend one, open it under **Manage connections** and switch on **Lend its credentials to jobs**. Only the providers below can be lent; for any other connection the dialog says it can't be lent to jobs.

- **Kubernetes:** a kubeconfig for the cluster in `/root/.kube`, with `KUBECONFIG` pointing at it, for one context (and the namespace a job asks for). `KUBE_CONFIG_PATH` names the same file, which is the variable Terraform's Kubernetes and Helm providers read. A service account's token is swapped for a short-lived one where the cluster allows it. The cluster must be served over TLS. A cluster on a private network is reached through a public SSH jump host: open a tunnel with `ssh -L` in the job.
- **SSH:** an entry in `/root/.ssh/config` named after the connection, with its key, user and port, the host key Infrawrench pinned for it as a `known_hosts` line, and the jump host it connects through, which must be lent too. A host with no pinned key is not lent: open a terminal to it from Infrawrench once first. Infrawrench reads the host's key when it lends the connection, so the host (and its jump host) must be reachable from Infrawrench then, and a host that now offers another key than the pinned one is not lent either.
- **AWS:** session credentials from STS, minted from the connection's access key for each run and expiring with it (seven hours), never the key itself: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_REGION` and `AWS_DEFAULT_REGION`, which the AWS CLI, every AWS SDK and Terraform read, and the same session as a profile named after the connection in `~/.aws/credentials` (`aws --profile production ...` when a job is lent two). A session has the IAM user's permissions, except that AWS lets it call no IAM operation and no STS operation but `AssumeRole` and `GetCallerIdentity`.
- **Google Cloud:** an access token for the connection's service account, never its key. `gcloud` reads it from the file `CLOUDSDK_AUTH_ACCESS_TOKEN_FILE` names, Terraform from `GOOGLE_OAUTH_ACCESS_TOKEN`, and `CLOUDSDK_CORE_PROJECT` and `GOOGLE_CLOUD_PROJECT` name the project. Google's client libraries have no variable for a token, so a script hands it to the library itself. A token lasts an hour from when the run is sent to the runner; where your organization allows longer ones for the account (the `iam.allowServiceAccountCredentialLifetimeExtension` policy) and the account may mint its own (`iam.serviceAccounts.getAccessToken` on itself), it lasts as long as the run may.
- **Azure:** the connection's service principal: `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_CLIENT_SECRET` and `AZURE_SUBSCRIPTION_ID`, which the Azure SDKs read, and the same as `ARM_*` for Terraform. This is the connection's own client secret, not a short-lived one: the Azure CLI accepts no token from outside. Sign the CLI in with `az login --service-principal --username "$AZURE_CLIENT_ID" --password="$AZURE_CLIENT_SECRET" --tenant "$AZURE_TENANT_ID"`.
- **Vercel:** the connection's access token as `VERCEL_TOKEN`, which the Vercel CLI reads, so `vercel deploy` needs no `--token`, and as `VERCEL_API_TOKEN`, which Vercel's Terraform provider reads. Say which project to deploy as usual: a committed `.vercel/project.json`, `VERCEL_ORG_ID` with `VERCEL_PROJECT_ID`, or `--scope`.
- **Cloudflare:** the connection's API token as `CLOUDFLARE_API_TOKEN` and its account as `CLOUDFLARE_ACCOUNT_ID`, which Wrangler and Cloudflare's `cf` read. The token has the scopes it was created with, so give the connection the Workers and Pages scopes a deploy needs.
- **Neon:** the connection's API key as `NEON_API_KEY`, which the Neon CLI reads, for a job that creates a branch per pull request and deletes it after.
- **PostgreSQL:** the connection string as `DATABASE_URL`, its parts as `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` and `PGSSLMODE`, so `psql` connects with no arguments, and a section named after the connection in `~/.pg_service.conf`, so a job lent two picks one with `psql service=<name>`. A CA certificate the connection holds is written beside it and named by `PGSSLROOTCERT`.
- **MySQL:** the connection string as `DATABASE_URL`, its password as `MYSQL_PASSWORD`, and an option group named after the connection in `~/.my.cnf` that `MYSQL_GROUP_SUFFIX` selects, so `mysql` connects with no arguments (`mysql --defaults-group-suffix=_<name>` picks another when a job is lent two). A password with both kinds of quote in it cannot be written there, so it is left out of the file and the job passes `MYSQL_PASSWORD` itself. `MYSQL_ENDPOINT` (`host:port`) and `MYSQL_USERNAME` are set too, which with `MYSQL_PASSWORD` are what the MySQL Terraform provider reads; a CA certificate the connection holds is named by `MYSQL_TLS_CA_CERT`.
- **Redis:** the URL as `REDIS_URL` (`redis-cli -u "$REDIS_URL"`) and its password as `REDISCLI_AUTH`, which `redis-cli` reads. An ACL user's name comes as `REDIS_USERNAME`: `redis-cli` reads no user from the environment, so pass `--user "$REDIS_USERNAME"`.
- **MongoDB:** the connection string as `MONGODB_URI` (`mongosh "$MONGODB_URI"`), and its user and password as `MONGODB_USERNAME` and `MONGODB_PASSWORD`.

A connection Infrawrench reaches through an SSH tunnel of its own is not lent when the tunnel changes its credentials (a connection string, or a kubeconfig's cluster): they would point at Infrawrench's end of the tunnel, which a job cannot reach, and the private address behind it is usually out of a job's reach too. Connect it without the tunnel to lend it. A cluster or database in a cloud account whose tunnel goes somewhere else keeps its own address, and is lent as usual.

Two databases lent to one job share the plain variable names (`DATABASE_URL`, `PGHOST`, ...), and the one named last wins; the per-connection files above tell them apart.

Vercel, Cloudflare and Neon lend the connection's own token or key, not a short-lived one, and the databases lend the password their connection string holds; each is masked in the job's log like a secret. A job installs the CLIs itself, or names them as builtins (`builtin:vercel`, `builtin:wrangler`, `builtin:cf`, `builtin:neon`) once those are published.

![A deploy job's page listing what it was lent: Connections "Production cluster, web-1" and SSH keys "deploy"](https://agent-assets.infrawrench.com/docs-screenshots/features/ci/deploy-job-lent.png)

#### A cluster or database in a cloud account

A managed cluster (GKE, EKS, AKS) or a managed database (Cloud SQL, RDS and Aurora, DigitalOcean's databases) can be used as if it were a Kubernetes, PostgreSQL, MySQL, Redis or MongoDB connection of its own, without connecting it separately. Grant it under **Resources jobs may read** and choose **As a Kubernetes connection** (or the database's engine) in **Use it in CI as a connection**. The choices are the resource's own tabs in Infrawrench that its provider declares for CI, so a Cloud SQL instance running MySQL is offered as MySQL only.

The form then says exactly what a job would get, before anything is switched on: the credential, what it reaches beyond the resource, and how long it lasts. Two switches are separate, and both start off:

- **Lend it to jobs:** jobs name it in `connections:` by its name in pipelines, exactly like a connection, and are lent what the matching connection would be.
- **Run cloud jobs on it:** `cloud:` jobs of the ticked kinds run there. This lends the jobs nothing: a grant that only runs jobs on a cluster never hands its credential to a pipeline.

```yaml
jobs:
  deploy:
    tools: [builtin:kubectl@1.37]
    connections: [{ name: gke-prod, namespace: web }, orders-db]
    run: |
      kubectl rollout status deploy/web
      psql -c 'select 1'
  migrate:
    cloud: { provider: kubernetes, kind: cluster, connection: gke-prod }
    run: ./migrate.sh
```

What each is lent, read fresh for every run through the cloud connection that holds it, and never a credential plugin:

- **GKE:** a kubeconfig with a Google access token minted for the run, scoped to `userinfo.email` only, the one scope GKE needs, so it calls no other Google API. In the cluster it can do what the Google Cloud connection's service account may. It lasts seven hours where your organization allows longer tokens for the account (`iam.allowServiceAccountCredentialLifetimeExtension`) and the account may mint its own (`iam.serviceAccounts.getAccessToken` on itself), and one hour otherwise.
- **EKS:** a kubeconfig with a token presigned with the AWS connection's key. It reaches only the cluster, as that IAM user, and EKS accepts it for 15 minutes from when the run starts, so a job that waits longer behind others gets a refused token.
- **AKS:** a kubeconfig with a Microsoft Entra ID token for the Azure connection's service principal, about an hour. Only clusters that sign in with Entra ID are offered: a cluster with only local accounts would lend a long-lived client certificate, often with admin rights, which cannot be revoked without rotating the cluster's certificates.
- **Databases:** the connection string, with the user and password Infrawrench reads it with, as a connection of that engine would lend it. It reaches what that user may do, and lasts until the password is changed.

A grant holds for the resource it was made for: if the resource is deleted and one is created again under the same name, the grant no longer lends it or runs jobs on it until it is saved again. A name in pipelines that is also a connection's name is refused rather than guessed: rename one.

Ticking a job kind checks, through the cluster, that it can run there, and refuses the grant with what is missing when it cannot. Jobs run where the kind was checked (a cluster's own namespace) unless the grant lists other places in **Other places jobs may run**; each one is checked when it is added, and a job that names anywhere else in `cloud.region` is refused.

![The grant form for the GKE cluster "prod-cluster": no outputs ticked, Use it in CI as a connection set to "As a Kubernetes connection", the Credential, Reach and Lifetime lines, Lend it to jobs unticked, Run cloud jobs on it with Kubernetes Job ticked, Jobs at once 2, Minutes per job 60, Other places jobs may run empty, and the branch pattern "main"](https://agent-assets.infrawrench.com/docs-screenshots/features/ci/grant-gke-cluster.png)

### SSH keys

`ssh-keys: [deploy]` writes one of your SSH keys to `/root/.ssh/id_deploy`, used for every host. Only a key's owner can lend it: under **Settings**, **SSH keys**, choose **Use in CI jobs** on your key, give it its name in pipelines, and say which repositories and branches may use it. Only keys Infrawrench generated can be lent, since an imported key's private half is not stored. Admins can revoke a lent key from the CI access card.

![The SSH keys settings page with the "Use in CI jobs" dialog open for the caller's own generated key "deploy", with its name in pipelines "deploy" and branches "main"](https://agent-assets.infrawrench.com/docs-screenshots/features/ci/ssh-key-use-in-ci.png)

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

![The grant form under Resources jobs may read, opened from the "Search for resources" results: the DigitalOcean database "prod-db" with its provider logo and "Choose another", connectionString ticked, the sensitive password unticked, its name in pipelines "prod-db", Every repository, the branch pattern "main", and Grant and Cancel](https://agent-assets.infrawrench.com/docs-screenshots/features/ci/grant-database.png)

### Environment files

A job can take its variables from a [`.infraenv` file](./env-files.md) in the repository, the same file `infrawrench env pull` turns into a `.env`:

```yaml
jobs:
  test:
    using: env:bash-node@24
    env-file: .infraenv
    run: pnpm test
  e2e:
    using: env:bash-node@24
    env-file: { path: apps/web/.infraenv, environment: staging, vars: { stage: ci } }
    env:
      LOG_LEVEL: debug # the job's own env: wins over the file
    run: pnpm e2e
```

`path` is relative to the repository's root. `environment` picks the file's `[env.<name>]` section, laid over `[env]`, and `vars` sets `${name}` substitutions over the file's own `[vars]`. Everything in `env-file:` is written out literally: `${{ }}` is not read there.

Anyone who can push a branch can edit the file, so the file decides nothing about what a job gets. When the run is sent, Infrawrench reads the file at the run's commit and checks each variable with the same permissions as everything else under CI access:

- **Plain values** become variables as written.
- **`resource(...)`**, by id or by name, is read only when that resource is [granted](#resources) for the repository and branch and the output it reads is ticked on the grant. The file names the resource, not the grant's name in pipelines, so any grant of it that covers the run will do. Otherwise every job that uses the file fails before it starts, naming the variable and what to grant, for example "`DATABASE_URL` in .infraenv reads connectionString of storefront / dev (neon/neon-branch), which is not granted to CI; grant storefront / dev to CI with the output connectionString for acme/web".
- **`secret("NAME")` reads the repository's CI secrets**, the ones under [Secrets and variables](#secrets-and-variables) that `${{ secrets.NAME }}` reads, not your organization's secrets that the app and `infrawrench env pull` use. Organization secrets are never given to CI jobs, so set the ones your pipelines need as CI secrets under the same name. A secret the run does not have fails the job, where `${{ secrets.NAME }}` would read as empty.

More about how the variables reach a job:

- **The job's own `env:` wins.** The file's variables come after a connection's, an SSH key's, a GitHub token's and `env-from:`'s. Background services do not get them.
- **Masked.** Resource values and secrets are masked in every log and output; plain values are not.
- **All or nothing.** If one variable cannot be given, every job using the file fails with that variable's reason, and so does a file that does not parse, is missing at the commit, has no section for the `environment`, or is pinned to another organization.
- **Never for a fork.** A pull request from a fork gets nothing from the file, and a job of it with `env-file:` fails.
- **Audited.** Each run that is given a file is recorded in the [audit log](../team-and-billing/audit-log.md) with the variable names and where each came from, never the values, along with a record per granted resource naming who granted it.
- A job with `env-file:` cannot use `task-cache:`.

### When a job is refused

A job that names something it may not have fails before it starts, saying why: "connection `staging` is not lent to CI for acme/web on feature/x", "resource `gke-prod` is not lent to CI for acme/web on feature/x", "prod-db is not granted to CI", which variable of an [environment file](#environment-files) is not granted, or, for a cloud job, which connection to opt in. It never runs with an empty value.

## Caches

The **Caches** card lists what each repository's jobs have saved, with `cache:` and `task-cache:`, across every branch and pull request: how many entries and how much space, largest first, under each GitHub account with its total against its storage quota.

To start a repository from nothing, for example after a cache that keeps restoring something broken, choose **Clear cache** on its row. The dialog says how many entries and how much space go before anything is deleted. Clearing deletes that repository's entries for every branch and pull request, and the card then says what was removed. The next run of each job starts cold and saves its caches again. Other repositories keep theirs, and so does the runners' own copy of your dependencies, which is not counted as your storage. The repository's [downloads](#downloads) are not caches and stay until they expire.

Everyone who can see runs can see the card; clearing a cache takes `ci:write` and is recorded in the [audit log](../team-and-billing/audit-log.md).

![The "Clear the cache of acme/web?" dialog open over the CI page's Caches card, saying it deletes 214 cache entries (6.00 GiB)](https://agent-assets.infrawrench.com/docs-screenshots/features/ci/caches-clear-dialog.png)

### Turborepo's remote cache

A repository built with Turborepo gets a remote cache with nothing to set up. Every job with a network is given `TURBO_API`, `TURBO_TOKEN` and `TURBO_TEAM`, which point `turbo` at a cache the runner keeps for you, so a task an earlier run already built with the same inputs is restored instead of run again, on whichever runner picks the run up.

The cache follows the same rules as the rest of your caches: a pull request reads what the default branch saved and saves its own, which nothing on the default branch ever reads; what it keeps counts against your storage quota, shows on the **Caches** card and goes when you clear the repository's cache. The token is masked in logs and stops working when its run ends. Artifacts over 200 MiB are not kept (`turbo` says so and carries on), and signed artifacts (`remoteCache.signature` in `turbo.json`) keep their signature.

To keep a remote cache of your own, set any of `TURBO_API`, `TURBO_TOKEN`, `TURBO_TEAM` or `TURBO_TEAMID` in the job's `env:` (from a secret for the token) and the job is given none of these. A job with `network: false` cannot reach the cache and is not given them either.

### Runs shared between runners

A run goes to the runner where it is expected to finish soonest, which is usually the largest one free, and stays there while that runner has room. When it has more ready jobs than it can start, another runner takes the ones that have waited. There is nothing to turn on; a pipeline that still says `split:` is read as if it did not.

Each job still runs once, and the run page shows every job as before; a job another runner ran says so in its notes, and its output appears when it finishes rather than line by line. A job's `artifacts:` reach the jobs that need them on either runner: through the task cache for a job with `task-cache:`, and otherwise when they come to 64 MiB or less (4 MiB for a pull request from a fork). Larger ones stay where the job ran, and so do the jobs that need them.

A job that reads secrets can run on another runner, which gets the run's secrets sealed to a key only it holds, as long as the job keeps no `artifacts:`. Jobs that use [CI access](#ci-access), commit their changes, keep [downloads](#downloads), run on a cloud account or run in a [machine](#linux-machines) always stay on the runner that has the run. The shared `/tmp/workflow` directory works across runners: a file one job closes shows on the other runner straight away and its contents follow in the background, and a job starts only once everything the jobs it `needs:` wrote there is listed. A file written by a job that reads secrets stays on the runner that has the run, and a job that wants it runs there.

A job another runner ran is billed like any other job of the run.

## Whole vCPUs for a job

A job shares a vCPU with other jobs unless it says otherwise. A job that compiles or runs a test suite in parallel can ask for whole vCPUs of its own with `cpus:`:

```yaml
jobs:
  test:
    using: env:go@1.27
    run: go test -p "$IWCI_CPUS" ./...
    cpus: 4
```

- **What it holds:** that many vCPUs of the runner, from 1 to 64. It waits until they are free, and no job sharing a vCPU starts ahead of it meanwhile. A runner with fewer vCPUs than it asks for gives it all of its own.
- **What it is told:** `$IWCI_CPUS` is the number it holds, and so is the CPU count its programs read (`nproc`, Python's `os.cpu_count()`, Node's `os.availableParallelism()`, `/proc/cpuinfo`). Without `cpus:`, `$IWCI_CPUS` is not set and that count is 1, so a tool that starts a worker per CPU (`pytest -n auto`, Vitest, Jest, cargo) starts one; give the job `cpus:` to run more. Either way the count is all that changes: a job still uses CPU time no other job wants.
- **What it costs:** its running time at that many vCPUs, rather than at its share of one (see [Usage and billing](#usage-and-billing)).
- A [Linux machine](#linux-machines) holds that many vCPUs. Without `cpus:`, it holds the runner's default for a machine. It is told more, so it can use CPUs no other job wants: up to four times what it holds and one per GiB of its `memory:` (so `nproc` in a 2-CPU, 6 GiB machine says 6). When every job wants more than there is, each gets the share it holds, and it is charged for what it holds either way.
- A [cloud job](#cloud-jobs) is sized by its `cloud.machine`, so `cpus:` there is an error.

## Usage and billing

CI is part of paid plans (from $20 per seat per month). The usage card shows this month's runs, compute and storage. It is billed on your plan's invoice, by what you use:

- **vCPU time**, $0.00008 per vCPU-second ($0.0048 per vCPU-minute): each job's running time, at its share of a vCPU. Four jobs share a vCPU on the runners, so a job is charged a quarter of a vCPU for as long as it runs. A job with [`cpus:`](#whole-vcpus-for-a-job) is charged the whole vCPUs it holds instead.
- **Memory**, $0.000008 per GiB-second: the memory each job reserves (its `memory:`, 2 GiB unless it says), for as long as it runs.
- **Storage**, $0.0002 per GiB-hour (about $0.14 per GiB for a 30-day month): the space your caches and [downloads](#downloads) take on the runners, measured every hour. Task cache results count here too, and a download stops counting when it expires.

For example, a job with `memory: 4GiB` that runs for 10 minutes is charged 150 vCPU-seconds (a quarter of a vCPU for 600 seconds, $0.012) and 2,400 GiB-seconds ($0.0192), about $0.03 in all. With `cpus: 2` as well it is charged 1,200 vCPU-seconds ($0.096) instead of 150.

A job the task cache stood in for did not run, so it uses no vCPU time or memory. A [cloud job](#cloud-jobs) runs on your own account, so the provider bills you for the machine and it uses no vCPU time or memory here either.

Complimentary organizations are never billed. See [Billing and plans](../team-and-billing/billing-and-plans.md#ci).

## From an AI client

The in-app chat and any client connected to the [MCP server](./mcp.md) can work with CI too, with your permissions:

- **Find runs:** `list_ci_runs` lists runs newest first, filtered by repository, branch, status, event or pull request. Runs with nothing to run are left out unless asked for, as in the **Show** filter. Each run counts its jobs by status and names the ones that failed.
- **Read a run:** `get_ci_run` has the run's jobs, with their status, reason, duration, what they were lent (by name) and their downloads. `get_ci_job_log` reads one job's output a page at a time, the last 200 lines by default: from the finished run's report, or from a running run's live log. It is the output the run page shows, with your secrets masked by the runner. Download links are not handed out; open the run in Infrawrench for those.
- **Act on a run:** `start_ci_run` starts a [pipeline by hand](#start-a-pipeline-by-hand) with its inputs, `retry_ci_run` [retries a run](#retry-a-run) (with or without the task cache), `cancel_ci_run` [cancels one](#cancel-a-run), and `approve_ci_run` and `reject_ci_run` decide a [fork's pull request](#pull-requests-from-forks). Each takes `ci:approve`, like the buttons. The chat asks you to approve every one of them first, and each is recorded in the audit log.
- **See the setup:** `list_ci_repositories`, `list_ci_pipelines` (the scheduled and manual pipelines on each default branch), `list_ci_values` (the names of secrets and variables, never their values; it takes `ci:write`, as the card does), `get_ci_access` (what [CI access](#ci-access) allows) and `get_ci_usage`. These only read: change them here, in the CI tab.

## Limits

- CI runs for GitHub repositories, through the Infrawrench GitHub App.
- The mobile app does not show CI.
- Cloud jobs run on the providers in the [table above](#cloud-jobs); more follow.
- [Linux machines](#linux-machines) run only on runners set up for them. A run is placed on one when one is available; otherwise its machine jobs fail, saying the runner has none, and the rest of the run goes on.
- A job runs for at most 6 hours (`timeout:`, 10 minutes unless it says). No plan sets a lower limit: a job is billed for the time it runs. Credentials lent to a job are minted for 4 hours from when its run is sent to a runner, or less where the provider caps them, so a job that runs longer should not need them near its end.
- The pipeline format, the builtin tools and the limits on each job are described in the runner's reference (`ci-runner/README.md` in the Infrawrench repository).
