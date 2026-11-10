# ci-runner

A CI runner that runs every job in a WebAssembly isolate. On each commit it
clones the repository once, installs its dependencies once, freezes the
result in memory, and then starts each job in its own [Wasmer] instance over
a copy-on-write view of that snapshot. A job starts in the time it takes to
instantiate a module that is already compiled: there is no container to
pull, no clone per job and no `pnpm install` per job.

The app reaches it through the proxy (`app/packages/ci-proxy`): the GitHub
App's push and pull request webhooks become runs (`server-core/src/ci/`),
shown on the **CI** tab of the web and desktop apps. It is a standalone Rust
workspace, outside the pnpm workspace and `turbo.json`, with its own CI
(`.github/workflows/ci-runner.yml`).

[Wasmer]: https://wasmer.io

## How a run works

1. **Plan.** Read every `.infrawrench/ci/*.yml` at the commit, parse and
   validate it (`iwci-spec`), expand matrices, substitute `${{ }}`
   expressions, and drop pipelines whose `on:` does not match. A job whose
   matrix or fields read another job's outputs stays a template until that
   job finishes.
2. **Clone** (`iwci-git`). Fetch just the commit, shallow, into a persistent
   bare repository per remote, then write its tree straight from the object
   database into an in-memory file system. A commit already in the cache
   costs no network at all.
3. **Install** (`iwci-deps`). Read the lockfiles from the snapshot and fetch
   exactly what they pin, verified against the lockfile's hashes and cached
   by content: pnpm (laid out like pnpm's isolated `node_modules`), Go
   modules (a `GOMODCACHE`) and Cargo crates (a `vendor/` directory). No
   package manager runs and no install script executes. Both its results
   are cached: see [Caching](#caching).
4. **Resolve tools** (`iwci-store`). Each `using:` resolves to a manifest
   and content-addressed blobs in R2, verified by sha256.
5. **Run** (`iwci-runtime`). Jobs run in parallel as soon as their `needs`
   finish and their `paths:` and `if:` allow it, each in a fresh Wasmer instance with no host file system and
   a private loopback plus the public internet for a network (see [Networking](#networking)), under a timeout and a memory limit. Compiled modules are cached
   on disk, so a tool is compiled once per runner, not once per job.
6. **Changes.** What a job wrote is read back from its overlay layer.
   `changes: fail` fails the job if it changed anything; `changes: commit`
   turns the changes into a commit on top of the run's commit (written to
   the git cache; pushing it is left to the integration).

Workspaces are deduplicated and built on first use: jobs whose clone and
dependency settings are the same share one snapshot, so a 10-entry matrix
installs once, and a workspace only skipped jobs would use is never built.

## The pipeline file

```yaml
name: Tests

on:
  push:
    branches: [main]
  pull-request: {}

workspace:
  clone:
    depth: 1
    into: /app
  deps:
    - pnpm

jobs:
  typescript:
    name: TypeScript (${{ matrix }})
    matrix: [web, mobile]
    using: builtin:typescript@7.1
    cwd: /app/app/packages/${{ matrix }}
    args: [--noEmit]

  format:
    using: builtin:oxfmt@0.69
    args: [--write, .]
    deps: false
    changes:
      commit: "style: format"

  lint:
    using: env:bash-node@24
    run: pnpm run lint
    needs: [typescript]
```

`examples/tests.yml` is a longer one, and `schema/ci.schema.json` is the
JSON Schema for editors (`# yaml-language-server: $schema=...`).

### Top level

| Key         | Meaning                                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------------------------- |
| `name`      | Required.                                                                                                                   |
| `on`        | `push` and/or `pull-request`, each with optional `branches` and `paths` globs, and `schedule` (below). Omitted: every push. |
| `workspace` | `clone` and `deps` shared by every job unless it overrides them.                                                            |
| `scratch`   | The most the run's shared `/tmp/workflow` may hold, such as `2GiB`. Default `1GiB`, between `16MiB` and `16GiB`.            |
| `jobs`      | Map of job key (lowercase, digits, `-`, `_`) to job.                                                                        |

`on.schedule` is a list of up to 16 `- cron: "0 3 * * *"` entries, always
in UTC: five fields (minute, hour, day of month, month, day of week) taking
`*`, numbers, ranges, steps and lists, month and weekday names, Sunday as 0
or 7, and `@hourly`, `@daily`, `@weekly`, `@monthly` and `@yearly`. When both
day fields are restricted, a day matching either runs, as in classic cron. A
scheduled run checks out the default branch's head, its event is
`schedule`, and it reads and writes the same caches as a push to that
branch. Runners do not keep time: something outside them has to fire the
schedule, which in this repository is the proxy Worker (see
[Scheduled runs](#scheduled-runs)).

`workspace.clone`: `depth` (`1` by default, more commits, or `full`), `into`
(default `/app`), `submodules` (default `false`).

`workspace.deps`: a list of `pnpm`, `go` or `cargo`, or `- go: { dir: tools }`
to read a lockfile below the root. pnpm also takes `only: [app/packages/web]`
to install just those importers' closure.

### Filters

`branches` and `paths` (under `on.push`, `on.pull-request`, and on a job)
are globs: `*` stops at `/`, `**` crosses it. A pattern starting with `!`
excludes. Patterns are read in order and the last one that matches
decides, so a later pattern can include again; a list that starts with an
exclusion begins from everything. A run or job goes ahead when any changed
path gets through.

```yaml
on:
  push:
    branches: ["**", "!dependabot/**"] # every branch but Dependabot's
    paths: [app/**, "!app/docs/**", app/docs/openapi.json]
jobs:
  test:
    paths: ["!**/*.md"] # anything but Markdown
```

Quote exclusions: YAML reads an unquoted leading `!` as a tag, and the
parser then reports an empty pattern. When the changed paths are not known
(a first push or a force push without `--base`), path filters let
everything through.

### Jobs

| Key          | Meaning                                                                                                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `using`      | Required. `builtin:<name>@<version>`, `repo:<name>@<version>` or `env:<name>@<version>`. See below.                                                                            |
| `args`       | For a tool: a list, or one line split like a shell splits words (quotes group, nothing expands).                                                                               |
| `run`        | For an environment: a bash script, run with `set -euo pipefail`.                                                                                                               |
| `name`       | Display name. Defaults to the key plus the matrix values.                                                                                                                      |
| `matrix`     | `[a, b]` (read as `${{ matrix }}`) or named axes `{ os: [a, b], mode: [x] }` (read as `${{ matrix.os }}`), with an optional `exclude:` list of combinations. Up to 64 entries. |
| `cwd`        | Working directory in the isolate. Defaults to the clone. Plain WASI tools see it only as `$PWD` (see [Known limitations](#known-limitations)).                                 |
| `env`        | Extra environment variables. `IWCI_*` is reserved for the runner.                                                                                                              |
| `clone`      | Override `workspace.clone`, or `false` for an empty file system.                                                                                                               |
| `deps`       | Override `workspace.deps`, or `false` to install nothing.                                                                                                                      |
| `changes`    | `ignore` (default), `fail`, or `{ commit: "<message>" }`.                                                                                                                      |
| `needs`      | Jobs that must finish first. Naming a matrix job waits for all of its entries; `^<job>` in a `packages:` job waits for that job in the packages this one depends on.           |
| `if`         | When the job runs, given how its `needs` went. See below.                                                                                                                      |
| `outputs`    | Names the job writes to `$IWCI_OUTPUT` for later jobs to read. Not allowed on a matrix job.                                                                                    |
| `paths`      | Skip the job unless the commit touches a path these globs let through (see [Filters](#filters)). A skipped job does not block its dependents.                                  |
| `timeout`    | `90s`, `10m`, `1h`. Default `10m`, at most `60m`.                                                                                                                              |
| `memory`     | `512MiB`, `4GiB`. Default `2GiB`, between `16MiB` and `16GiB`.                                                                                                                 |
| `cache`      | Files kept between runs: `{ key, restore-keys, paths }`, or a list of up to 16. See [Job caches](#job-caches).                                                                 |
| `tools`      | For an environment: up to 16 `builtin:` or `repo:` tools its script runs by name. See [Tools in a script](#tools-in-a-script).                                                 |
| `network`    | `false` to keep the job off the internet (default on). See [Networking](#networking).                                                                                          |
| `artifacts`  | Files handed on to the jobs that need this one. See [Artifacts](#artifacts).                                                                                                   |
| `packages`   | One job per workspace package, ordered by their dependencies. See [Workspace packages](#workspace-packages).                                                                   |
| `task-cache` | Skip the job when nothing it reads has changed since a run that passed. See [The task cache](#the-task-cache).                                                                 |

Expressions in `name`, `cwd`, `args`, `run` and `env`: `${{ matrix }}`,
`${{ matrix.<axis> }}`, `${{ needs.<job>.outputs.<name> }}`,
`${{ needs.<job>.result }}`, `${{ commit.sha }}`, `${{ commit.short-sha }}`,
`${{ commit.branch }}`, `${{ repo.id }}`, `${{ event }}`, `${{ vars.<name> }}`,
and, in `env:` values only, `${{ secrets.<name> }}` (see
[Secrets and variables](#secrets-and-variables)). Each is one name;
operators belong in `if:`. Every name is checked when the file is parsed:
reading a job that is not in `needs:`, or an output that job does not
declare, is an error at push time rather than an empty string at run time.

### Secrets and variables

Variables and secrets are set per organisation or per repository through
the proxy (`app/packages/ci-proxy`, "Secrets and variables"), the
repository's overriding the organisation's of the same name, and arrive
with each run.

- `${{ vars.<name> }}` works anywhere an expression does and is filled in
  when the file is parsed. A variable that is not set reads as empty.
  Variables are not secret.
- `${{ secrets.<name> }}` only works in an `env:` value
  (`TOKEN: ${{ secrets.NPM_TOKEN }}`, or inside text, `AUTH: "Bearer
${{ secrets.API_KEY }}"`). The parser keeps it as a name, so a secret is
  never part of a plan or a report; it is read when the job starts. One the
  run does not have is empty, and the job's report says so.
- Every secret's value is replaced with `***` in the live log, the job's
  captured output, its error messages and its outputs (`$IWCI_OUTPUT`),
  including each line of a multi-line secret. Values shorter than three
  characters are not masked.
- A pull request gets variables but no secrets, unless whoever starts the
  run says it comes from the repository itself rather than a fork
  (`"trusted": true` on the proxy).
- `iwci run` reads secrets from `IWCI_SECRET_<NAME>` environment variables
  and variables from `--var NAME=value`.

### The run's scratch directory

Every job of a run sees the same writable `/tmp/workflow`
(`$IWCI_SCRATCH`), whatever its tool: one job can leave a build there and a
later job (`needs:`) pick it up without a cache or an output. It starts
empty, it is gone when the run ends, it is held in memory and capped by the
top-level `scratch:` (default 1 GiB), and nothing under it counts as a
change to the repository. Jobs running at the same time share it as they
would share a disk, so give them different paths.

### Artifacts

A job's `artifacts:` lists paths, relative to the clone or absolute, whose
files are handed on once the job passes. Every job that needs it, directly
or through other jobs, starts with those files in its own file system,
where the producing job left them. That is how one job's build becomes
another's input, as a monorepo's build order needs:

```yaml
jobs:
  core:
    using: builtin:typescript@7.1
    cwd: /app/packages/core
    args: [-p, ., --emitDeclarationOnly]
    artifacts: [packages/core/dist]

  web:
    needs: [core] # starts with packages/core/dist
    using: builtin:typescript@7.1
    cwd: /app/packages/web
    args: [--noEmit]
```

- Paths may use `${{ matrix }}` (quote them inside `[ ]`); a matrix job's
  entries hand on all of their files together.
- A job that fails, or is skipped, hands on nothing. A job keeps only the
  files it added or changed under its paths: not the checkout's own files
  there, and not the files it was handed.
- Handed-on files are not the receiving job's changes, so `changes: fail`
  and `changes: commit` ignore them. They count toward the receiving job's
  `memory:`.
- Everything kept lives in memory until the run ends and counts toward the
  run's `scratch:` limit; a job whose artifacts would pass it fails.

### Workspace packages

`packages:` makes one job per package of the repository's JavaScript
workspace, the way Turborepo runs a task in every package:

```yaml
jobs:
  build:
    packages: { scripts: { build: "tsdown*" } }
    needs: ["^build"] # each package's dependencies first
    using: builtin:typescript@7.1
    args: [--emitDeclarationOnly, --outDir, dist]
    artifacts: [dist] # relative to the package
    task-cache: true

  check:
    packages: { has: [tsconfig.json], scripts: { build: "!tsdown*" } }
    needs: ["^build"]
    using: builtin:typescript@7.1
    args: [--noEmit]
```

- The packages are the directories `pnpm-workspace.yaml` lists, or, without
  it, the root `package.json`'s `workspaces` (npm, Yarn, Bun); never the
  root package or anything under `node_modules` or a hidden directory. A
  dependency is a workspace dependency when its name is another package's
  (`dependencies`, `devDependencies`, `optionalDependencies`,
  `peerDependencies`), whatever version it asks for.
- `packages: true` is every package. A filter narrows it: `only:` globs
  over each package's directory or name (`app/*`, `@scope/*`, `!` excludes,
  read in order), `has:` names that must be directly in its directory,
  `has-script:` scripts it must define, and `scripts:` a glob its command
  must match (`*` crosses `/`; `!` selects a script that does not match or
  is missing).
- Each package's job is keyed `<job>[<package dir>]`, runs in the
  package's directory, reads `${{ package.dir }}` (relative to the clone)
  and `${{ package.name }}`, and resolves relative `artifacts`, `cache`
  paths and `task-cache` inputs against the package. `paths:` globs stay
  relative to the clone, since they filter the commit's changed paths.
- In a `packages:` job, `needs: ["^build"]` waits for `build` in each
  package this one depends on; a dependency without one (filtered out) is
  looked through to its own dependencies. `needs: [build]` there means the
  same package's `build`. Any other job naming a `packages:` job waits for
  all of its packages, so `needs: [build]` on a plain job gets every
  package's artifacts. A dependency cycle among packages is an error.
- A `packages:` job cannot have a `matrix:`, `outputs:` or
  `changes: commit`, and `${{ needs.<job> }}` cannot read one (it has a
  result per package). `iwci plan` expands it over the workspace of the
  checkout the file is in; outside one, `iwci validate` checks it against a
  placeholder package.

### The task cache

`task-cache:` skips a job whose inputs have not changed since a run of it
passed, handing on that run's artifacts, outputs and log as if it had run
again. With `packages:` and `^` needs it is what makes a monorepo's CI only
recheck what a change can affect:

```yaml
task-cache: true # every file of the package (or the clone)
task-cache:
  inputs: [src/**, tsconfig.json, "!src/**/*.test.ts"]
  root-inputs: [tsconfig.base.json] # relative to the clone
```

- **The key** is a hash of the job's definition (tool and version,
  arguments or script, `env:`, `cwd`, `tools:`, `artifacts:`, `outputs:`,
  `network:`, `changes:`), its workspace's settings and lockfiles
  (`pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.npmrc`, `go.mod`, `go.sum`,
  `Cargo.lock`), the files its inputs match as the commit has them, and the
  bytes of every artifact it is handed. A job downstream of one that
  changed is handed different files, so its key changes too; one whose
  upstream rebuilt the same files is not.
- **Inputs** are filter globs (`!` excludes, read in order), relative to
  the package or, for a job without `packages:`, the clone. The default is
  every file there. `node_modules` and `.git` are never read; the lockfile
  stands for what was installed. Files a job reads that its inputs leave
  out are not in the key: name them, or the job can be skipped when they
  change.
- **On a hit** the job does not run, start a tool, wait for a job slot or
  take memory: it passes, its report says `cached` and replays the log of
  the run it stands for, its `outputs:` read as that run wrote them, and
  its artifacts reach the jobs that need it. It is not billed. Keys read
  the bare checkout, so a run whose jobs all hit never installs its
  workspace's dependencies.
- **The lookup comes before the queue.** As soon as a job's `needs` have
  finished, its key is computed and its entry read from the object store,
  up to 64 jobs of a run at a time, whatever `--cpus` and `--memory` are
  and whatever else the runner is doing. So a hit costs one read of the
  store (two at once for a pull request, see [Job caches](#job-caches)),
  and its `duration_ms` is that read.
- **On a miss** it joins the queue and runs as usual, taking a slot and
  its `memory:` only then, and after it passes its kept artifacts, outputs
  and log are saved under the key it was looked up by. Its `duration_ms`
  is the run's, without the lookup. Failures are never cached.
- Entries are kept with the [job caches](#job-caches), scoped and counted
  the same way: a pull request's entries are never read by a push to the
  default branch.
- A job that reads secrets or commits its changes cannot be task-cached:
  its result could depend on what the key cannot hold. Nor should one that
  reads the run's shared `/tmp/workflow`, which is not part of its key.

### Outputs, dynamic matrices and `if:`

A job can decide what later jobs do:

```yaml
jobs:
  affected:
    using: env:bash@5
    outputs: [packages, docs]
    run: |
      echo 'packages=["web","mobile"]' >> "$IWCI_OUTPUT"
      echo "docs=true" >> "$IWCI_OUTPUT"

  typecheck:
    needs: [affected]
    matrix: ${{ needs.affected.outputs.packages }}
    using: builtin:typescript@7.1
    cwd: /app/app/packages/${{ matrix }}

  docs:
    needs: [affected]
    if: needs.affected.outputs.docs == 'true' && changed('app/packages/website/**')
    using: env:bash-node@24
    run: pnpm run build

  report:
    needs: [typecheck, docs]
    if: always()
    using: env:bash@5
    run: echo "${{ needs.typecheck.result }}"
```

- **Outputs.** A job declares `outputs:` and writes `name=value` lines, or
  `name<<EOF` ... `EOF` blocks for multi-line values, to the file at
  `$IWCI_OUTPUT`. Writing an undeclared name fails the job, so a typo cannot
  leave a later job reading an empty string. A matrix job cannot declare
  outputs, because every entry would write the same names.
- **Dynamic matrices.** `matrix:` can be `${{ needs.<job>.outputs.<name> }}`
  holding a JSON list (read as `${{ matrix }}`) or an object of axes, and a
  single axis can be an output holding a JSON list. The job expands when its
  needs finish. An empty list runs nothing and is not a failure.
- **`if:`** takes `==`, `!=`, `&&`, `||`, `!`, parentheses, `'strings'`,
  `true` and `false`; the functions `success()`, `failure()`, `always()`,
  `contains(a, b)` (a JSON list is searched by element), `startsWith`,
  `endsWith` and `changed('glob', ...)`; and the names above. An `if:` that
  calls none of `success()`, `failure()` or
  `always()` means `success() && (...)`, so it never runs after a failure
  unless it says so. A surrounding `${{ }}` is optional. A string is false
  when it is empty or `false`, so an output of `false` reads as false.
- **What blocks what.** A job that fails, or is skipped because something it
  needs failed, holds back its dependents. A job skipped by its own `if:`,
  its `paths:`, or an empty matrix does not: jobs that need it still run.
  `needs.<job>.result` is `success`, `failure` or `skipped`.

Every tool is pinned. `@7.1` takes the newest `7.1.x`, `@7` the newest `7.x`,
`@7.1.3` exactly that; a bare name is an error, so a new release can never
change what an old commit runs.

### What changed from the first sketch

- `git-clone` and `download-deps-with` moved to a top-level `workspace`
  (overridable per job as `clone` and `deps`): a clone and install shared
  across jobs is what makes jobs start instantly, so it is the default.
- `method: shallow` became `depth`, which also says how shallow.
- `builtin:typescript-7.1` became `builtin:typescript@7.1`, so a version is
  always separable from a name.
- A matrix can have named axes; the plain list still reads as `${{ matrix }}`.
- The TODO about committing a formatter's output is `changes: { commit: ... }`.
- `builtin:prettier` is `builtin:oxfmt`: Prettier is JavaScript, and builtins
  do not embed a JavaScript engine. oxfmt is Oxc's Rust formatter, which
  reports full conformance with Prettier's JS and TS tests and also formats
  JSON, CSS, GraphQL and YAML.
- `env:` jobs and `run:` scripts are new, and so are `outputs:`, matrices
  set by another job, and `if:`.

## Tools and environments

| Kind      | Example                  | What it is                                                                                                                   |
| --------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `builtin` | `builtin:typescript@7.1` | A tool we build and publish (`builtins/`).                                                                                   |
| `repo`    | `repo:licence-check@2`   | A wasm tool uploaded for one repository. Found in R2 under that repository's prefix only.                                    |
| `env`     | `env:bash-node@24`       | A set of Wasmer packages a `run:` script executes in. bash spawns the other commands as WASIX processes in the same isolate. |

Builtins:

| Builtin          | ABI        | Built from                                                                                                                                   |
| ---------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `typescript@7.1` | `tsc-host` | [tsc-rs] v0.8.0 (TypeScript 7.1) for `wasm32-wasip1`. Reads files through two host imports the runner serves from the in-memory file system. |
| `gofmt@1.27`     | `wasi`     | Go 1.27.3's `cmd/gofmt`, `GOOS=wasip1`.                                                                                                      |
| `oxfmt@0.69`     | `wasix`    | Oxc `apps_v1.84.0`'s pure-Rust CLI for WASIX (it needs threads).                                                                             |

Environments:

| Environment    | Packages                                                                                                                            |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `bash@5`       | `wasmer/bash` 1.0.25 (GNU bash 5.1), `wasmer/coreutils` 1.0.27, `wasmer/sed` 4.9.0, `wasmer/grep` 3.12.0, `wasmer/findutils` 0.10.1 |
| `bash-node@24` | the above plus `wasmer/edgejs` 0.2.5, rebuilt on a fixed C library (Node 24 compatible; `node`, `npm`, `pnpm`)                      |

Scripts run with `set -euo pipefail`, but see the known limitations: under
WASIX a pipeline currently reports only its last command's status.

Edge.js's WASIX package has no JavaScript engine inside it: it imports
N-API from the host, and the runner provides it with V8 through
[`wasmer-napi`]. That is the `node` feature (`cargo build -p iwci --features
node`), off by default because it links V8. Three things make it work, each
commented where it lives: jobs with Node run without WASIX's asynchronous
threading (V8 must run on a real thread stack; wasmer-napi's own runner does
the same), a package command's `wasi.env` is applied as defaults rather than
appended (otherwise pnpm sees `PATH` twice), and `vendor/wasmer-napi` is
patched so a job timeout can stop a script that never yields, so Node jobs
run at the same time without crashing the runner, and so worker threads work
(see `vendor/README.md`). Every `node` is an isolate in the runner's own
process, so a fault in that bridge is a crash of every run on the runner;
#947 was one (shared registries left unlocked once jobs stopped taking
turns). On Linux it builds for x86_64 and ARM64: the vendored bridge takes
ARM64's V8 from a later `wasmerio/v8-custom-builds` release (the same V8)
and links libatomic there, and the release channel carries both
(`x86_64-linux` and `aarch64-linux`); a runner installs its own
architecture's build.

`worker_threads` work: each Worker is a WASIX thread of its `node` with an
isolate of its own, charged against the job's `memory:` like the main one,
so a job that starts more workers than its memory holds gets
`ERR_WORKER_INIT_FAILED` ("Failed to create worker env") for the rest, not
a hang. A later isolate starts small (64 MiB old generation) and grows as
it allocates; a 2 GiB job fits about fifteen idle workers.

`node:wasi` works. Edge.js 0.2.5 ships the module but not the binding behind
it, so the runner gives every environment job `/usr/local/lib/iwci/node`
and puts `--require /usr/local/lib/iwci/node/preload.cjs` first in
`NODE_OPTIONS` (anything the job sets is kept after it). The preload answers
`node:wasi` with a WASI written in JavaScript ([`@tybys/wasm-util`], vendored
in `crates/iwci-runtime/node/`), for `require` and `import` alike and in
worker threads, and steps aside for a built-in one that works. That is what
packages whose native addon falls back to a `wasm32-wasi` build need:
rolldown, and with it Vite 8, Vitest and tsdown; oxc; the Astro compiler.
The pnpm installer installs those `wasm32` builds: it treats a job as a
platform with cpu `wasm32` and no operating system, so they are the
optional dependencies it keeps and native ones the ones it leaves out. A
package that leaves its WASI build out of its own optional dependencies, as
rolldown does, needs it listed in the repository: an `optionalDependencies`
entry pnpm records in the lockfile but installs on no real machine.

The same preload covers one more place where Edge.js and Node differ, until
a pinned Edge.js fixes it: a blob's stream reads past empty parts, because
Edge.js's stopped at the first one and never ended (#940). A pending async
WebAssembly compile keeps `node` alive and its result is picked up as soon
as it lands, as in Node: the runner's V8 platform waits for an isolate's
background work at the end of each event-loop turn (#943,
`vendor/README.md`).

Edge.js is the one package not taken as Wasmer published it. wasix-libc,
the C library linked into its module, makes a relative path absolute in one
buffer that every thread shares, so concurrent `fs` calls by relative path
could trade paths: a read opened the working directory (EISDIR) or another
file (#937). The fix is open upstream (wasix-org/wasix-libc#145) and in no
Edge.js release, so `builtins/environments/edgejs/build.sh` builds 0.2.5's
module from its source, with its toolchain, on its sysroot with that one
object of the C library rebuilt from #145, and puts it in the published
package in place of Wasmer's. The build is reproducible, and without the
patch it gives back Wasmer's module bit for bit (`EDGEJS_VERIFY=1`), so the
C library object is the whole difference. That is `bash-node` 24.0.1;
24.0.0 was Wasmer's package with the runner making `fs` paths absolute in a
preload instead. Go back to pinning Wasmer's package once a release is
built on a sysroot with the fix.

`builtins/*/build.sh` builds each into `dist/`, and `iwci publish` uploads
it. Every package and source is pinned to a tag or a content hash. On
`main`, each builtin's CI job publishes what it just tested to the runner
pool's bucket (`builtins/publish.sh`, with the `IWCI_R2_*` secrets). A
version already published with other bytes stays as it is and the run
shows a warning: a changed build needs a new version.

[tsc-rs]: https://github.com/pingdotgg/ts-rust
[`wasmer-napi`]: https://crates.io/crates/wasmer-napi
[`@tybys/wasm-util`]: https://github.com/toyobayashi/wasm-util

### Tools in a script

`tools:` makes builtins and repository tools commands an `env:` script can
run by name:

```yaml
lint:
  using: env:bash@5
  tools: [builtin:gofmt@1.27, repo:licence-check@2]
  run: |
    test -z "$(gofmt -l .)"
    licence-check --strict
```

Each tool's module is written to `/usr/local/bin/<name>`, first on the
default `PATH`, and runs as a WASI or WASIX process inside the job, sharing
its compiled code with jobs that use the tool directly. A tool's data files
and default environment come with it. Two kinds cannot be commands and are
refused when the job starts: tools that use the tsc-host ABI
(`builtin:typescript`, which reads files through its own host interface;
run it as a job of its own) and tools whose manifest has default arguments.

### Go and Rust

Go and Rust are supported the way every language is here: their dependency
installers make a commit's modules and crates available offline, and any
tool compiled to `wasm32-wasip1` or WASIX runs as a builtin or a `repo:`
tool. What does not run yet is the compilers themselves. `go build` and
`go test` need `cmd/compile` and `cmd/link` as subprocesses of the `go`
command, and `cargo test` needs rustc, which has no WebAssembly build that
can host itself. WASIX's process spawning is the path to the Go toolchain;
for now, jobs that must compile Go or Rust belong on a conventional runner.

## Job caches

A job can keep files between runs, for what the dependency installers do
not cover (`.tsbuildinfo`, `.turbo`, Go's build cache, a downloaded fixture):

```yaml
jobs:
  typecheck:
    cache:
      key: tsc-${{ matrix }}-${{ hashFiles('pnpm-lock.yaml', 'app/packages/web/**/*.ts') }}
      restore-keys: ["tsc-${{ matrix }}-"]
      paths: [app/packages/web/.tsbuildinfo, /root/.cache/go-build]
```

- Before the job runs, the exact `key` is restored, or else the newest
  cache saved under the first `restore-keys` prefix that has one.
- After the job passes, `paths` are saved under `key`, unless it started
  from an exact hit. A failed job saves nothing.
- `hashFiles('glob', ...)` hashes the matching files (relative to the
  clone) as the commit has them, by path and content. It only works in
  `key` and `restore-keys`. In a `[...]` list, quote anything with `${{`.
- `paths` are relative to the clone or absolute. Restored files belong to
  the cache, not the repository: they never count as changes for
  `changes: fail` or `changes: commit`.
- Restored files count against the job's `memory:` like any other write.
- **Scoped by branch, so a pull request cannot poison the default
  branch.** A push saves into its branch's scope and reads that, then the
  default branch's (`--default-branch`, default `main`). A pull request
  saves into a scope of its own, which nothing on the default branch reads.
  The exact `key` is read in both scopes at once, and the run's own scope
  wins when both have it; `restore-keys` are read one scope after another.
- **Counted against the owner's storage quota** (see below). A save that
  would pass the quota evicts the owner's oldest caches first; one larger
  than the whole quota is refused.

Caches live in the object store beside the tools, so on R2 every runner
shares them.

## Networking

Each job has a loopback of its own, in memory, shared by that job's
processes and nothing else. A test suite can start a server on `127.0.0.1`
(or `0.0.0.0`, which means the same here) and connect to it; `localhost`
resolves to it, a closed port refuses rather than reaching some other
listener, and two jobs never see each other's ports. A listener on `::`,
which is where Node listens when it is given no host, takes connections to
`127.0.0.1` as well as `::1`, as a dual-stack socket does. Nothing a job
listens on appears on the host.

Jobs also reach the **public internet** by default: names resolve through
the host and connections to public addresses go out over host sockets, so a
job can fetch from a registry or call an API. Only public unicast addresses
qualify, checked on the address actually connected to: never the runner's
own loopback (where its API listens), private ranges, link-local addresses
(including cloud metadata at `169.254.169.254`), shared, multicast,
documentation or reserved ranges, in IPv4, IPv6 or IPv4 inside IPv6, nor the host's own addresses, which from the host itself would skip any outside firewall. DNS
answers that point inside are dropped. UDP is not offered.

`network: false` on a job keeps it off the internet, leaving only its
loopback. The `iwci` command turns the internet on for its jobs; the
runtime's own tests never use it.

## The `iwci` command

```sh
iwci validate .infrawrench/ci/*.yml [--json]      # check files, all errors at once
iwci plan .infrawrench/ci/tests.yml [--json]      # the expanded jobs
iwci run --repo https://github.com/org/repo (--sha <commit> | --branch <name>) \
         [--repo-id <id>] [--owner <owner>] [--event push|pull-request] [--base <sha>] \
         [--default-branch main] [--pipeline <file>] [--cpus <n>] [--jobs-per-cpu 4] \
         [--memory <size>] [--storage-quota <size>] [--json] [--store <dir>]
IWCI_SERVER_KEY=... iwci serve [--listen 127.0.0.1:8547] [same limits as run]
iwci publish dist/builtin/gofmt/1.27.3 ...        # upload builtins/*/build.sh output
```

Without `--sha`, `--branch` runs that branch's head as it is now. The owner
(who storage and usage count against) defaults to the GitHub organisation
or user in the URL, as `github.com-<org>`; the repository id to its name.

`--store <dir>` uses a local directory laid out like the bucket; without
it, R2 comes from `IWCI_R2_ACCOUNT_ID`, `IWCI_R2_BUCKET`,
`IWCI_R2_ACCESS_KEY_ID` and `IWCI_R2_SECRET_ACCESS_KEY`, with a disk cache
in front. A private repository's token is `IWCI_GIT_TOKEN`. Credentials come
from the environment only. `--base` gives the changed paths that `paths:`
and `changed()` read. Caches (git, fetched packages, compiled modules,
objects) live under `--cache`, `$IWCI_CACHE_DIR` or `~/.cache/iwci`.

Jobs see `CI=true`, `HOME=/root` (unless they set their own), `IWCI_COMMIT`,
`IWCI_BRANCH`, `IWCI_REPO_ID`, `IWCI_JOB` and `IWCI_OUTPUT`, plus `PWD` set
to their `cwd`. That is the only way a plain WASI tool learns its working
directory: Go's `wasip1` port reads it, and a wasi-libc tool must (see
[Known limitations](#known-limitations)). Installers add their own: Go
jobs get `GOMODCACHE`, `GOPROXY=off`, `GOFLAGS=-mod=readonly` and friends,
Cargo jobs `CARGO_NET_OFFLINE=true`.

On a warm cache, a five-job pipeline (bash, a dynamic matrix, gofmt with a
commit) runs in about 0.35 s.

## Caching

Everything a run builds is cached under `--cache`, so the second run of a
commit, and of most commits after it, does almost nothing:

| What             | Kept under  | Keyed by                                                                                                                                    |
| ---------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| git objects      | `git/`      | One repository per remote. A commit already there costs no network.                                                                         |
| downloads        | `deps/`     | The lockfile's hash: npm `integrity`, Cargo `checksum`, Go's `h1:` from `go.sum` (checked over the zip's files). Re-verified on every read. |
| installs         | `installs/` | What the install read. See below.                                                                                                           |
| compiled modules | `modules/`  | The module's sha256 and the Wasmer version, compiler and CPU features.                                                                      |
| tools from R2    | `objects/`  | sha256.                                                                                                                                     |

**Installs** (`node_modules`, the `GOMODCACHE`, `vendor/`) are cached
whole. An install runs in a layer over the checkout that records every read
reaching the checkout, including files it looked for and did not find, and
keeps every write to itself. Both are stored, and a later run reuses the
result only when every recorded read still sees the same thing. So a bumped
lockfile, an edited patch file or a newly added `.npmrc` is a miss, without
any installer having to list its inputs. A runner process keeps recent
installs in memory and replays them by sharing buffers; on disk each is one
zstd stream with a checksum, so a damaged file is a miss. In the end-to-end
run above, pnpm and Go together took 4.3 s cold (downloads, unpacking and
first compilation) and came from the cache in 0.25 s for the whole pipeline.

## Limits

`--cpus <n> --jobs-per-cpu <k> --memory <size>` (or `IWCI_CPUS`,
`IWCI_JOBS_PER_CPU` and `IWCI_MEMORY`; flags win) limit the whole runner:

- **Slots.** The runner has `cpus × jobs-per-cpu` job slots, shared by
  every run it is doing, whatever repository or owner each is for. Four
  jobs share a vCPU by default: CI work waits on its subprocesses and its
  files often enough that a core interleaves several jobs better than it
  runs one, and the operating system time-slices them. `--cpus` also sizes
  the runtime's threads, the pool Wasmer compiles on and the installers'
  threads. A WASIX program's own threads and subprocesses (bash running
  `sed`) are not capped, because a script waiting on its child would
  deadlock. Default: the machine's cores.
- **`--memory`** is a budget across running jobs. A job reserves its
  `memory:` before it starts and waits until that fits; a job asking for
  more than the whole budget is an error, not a hang. The reservation
  stands for the job's program and its files together. The frozen workspace
  snapshots are not counted: they are built once and shared. Default: no
  budget.
- **A task cache lookup takes neither.** A `task-cache:` job holds a slot
  and its `memory:` only if it misses and runs (see
  [The task cache](#the-task-cache)).

Inside a job, `memory:` holds its program memory (Wasmer's linear-memory
limit) and, separately, the files it writes, which live in memory: without
that a job could write past any limit. A write over it is refused before
any of it lands, and the job's report says so.

### A job that dies of a signal

A program killed by a signal says only which one: wasix-libc prints
`Program recieved fatal signal: Bad system call` and exits with 127 (or the
host ends it with 128 plus the signal), and by then nothing shows who sent
it (#955). The runner keeps, for every job, the last signals its processes
sent (`raise`, `kill`, `abort`) with the syscalls the sending thread made
just before and how its task began, the signals delivered to a handler,
and the syscalls that returned `ENOSYS` or `ENOTSUP`, and when a job ends
that way it adds them to the end of the job's stderr:

```text
Program recieved fatal signal: Bad system call
iwci: the job exited with 127 after a signal. What the runner saw of it (#955):
  0ms before the end, a guest called proc_signal(pid=1 sig=Signal::Sigsys)
    its thread's syscalls before that: proc_id x2 proc_parent stack_checkpoint x2 fd_filestat_get stack_checkpoint x6
    its thread's task had started 48 syscalls before
  0ms before the end, delivered to a handler: pid=1 signal=Signal::Sigsys
  0ms before the end, a guest called thread_signal(tid=1073741823 sig=Signal::Sigabrt)
    its thread's syscalls before that: proc_parent stack_checkpoint x2 fd_filestat_get stack_checkpoint x6 callback_signal fd_write
    its thread's task had started 50 syscalls before
  no syscall returned ENOSYS or ENOTSUP
```

The `thread_signal` with `Sigabrt` is `abort()`, which is how wasix-libc
ends a process after a fatal signal. A thread's task is the process or
guest thread it runs: it either `started` there or `resumed from a deep
sleep`, a wait long enough that wasmer-wasix unwound its stack, gave the
host thread back and later rebuilt it on another. `[task start]` among
the syscalls is where that happened, and `[deep sleep]` where a thread
went into one. A signal that was delivered
without a guest having sent it came from the host runtime, and one that
libc names but that was never delivered was raised inside the guest; the
lines say which. A job that fails any other way gets nothing added.

A crash is added the same way. When a command the script runs, or one
thread of a process, traps, the script may carry on and fail somewhere
else, and wasmer-wasix prints the trap only on the runner's own stderr;
the job's stderr gets `iwci: a process or thread of the job crashed, which
its exit status (1) does not say:` and the trap.

The lines are part of the job's stderr, so they are in the live log and
the report and are masked like the rest of it. The signal lines hold
syscall names, ids, signal names and error names, never the job's own
text; a trap's lines can name functions of the job's module.
`iwci-runtime/src/signals.rs` is the recorder, a `tracing` subscriber over
what wasmer-wasix already traces. It reads every syscall's return value;
`IWCI_SIGNAL_LOG=0` turns it off.

## HTTP API (`iwci serve`)

`iwci serve` runs the same runner as a service. Every route but `/healthz`
needs `Authorization: Bearer <key>`, with the key from `IWCI_SERVER_KEY`
(at least 32 characters). It listens on loopback unless `--listen` says
otherwise. Runners are meant to sit behind a plain load balancer: reports,
billing records and caches go to the shared object store, so any runner can
answer for any owner, and a full runner says so instead of queueing.

| Route                                   | Does                                                                                                                                                                    |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /healthz`                          | `200 ok`, unauthenticated.                                                                                                                                              |
| `GET /v1/capacity`                      | Slots (total, free), active runs, memory reserved.                                                                                                                      |
| `POST /v1/runs[?wait=true]`             | Runs a request (below): `202` with an id, or with `wait=true` the result when done.                                                                                     |
| `GET /v1/runs/{id}[?owner=]`            | A run's state and report, and while it runs its `progress` (each pipeline's jobs and their states so far); `?owner=` reads it from the store when this runner lacks it. |
| `GET /v1/runs/{id}/logs`                | The run's log as Server-Sent Events: everything so far, then live until it ends.                                                                                        |
| `POST /v1/prepare`                      | Warms a request's clone, dependency installs and tools without running a job.                                                                                           |
| `GET /v1/storage/{owner}[?quota=]`      | The owner's cache storage, total and per repository, against its quota.                                                                                                 |
| `GET /v1/usage/{owner}[?month=YYYY-MM]` | The owner's billed usage for a month, total and per repository.                                                                                                         |
| `POST /v1/schedules/read`               | A repository's scheduled pipelines on a branch: file, name, crons and the file's text.                                                                                  |
| `POST /v1/drain`                        | Stops taking runs; running ones finish. `/v1/capacity` shows `draining`.                                                                                                |

A request body (for `runs` and `prepare`):

```json
{
  "repo": "https://github.com/acme/web",
  "branch": "main",
  "sha": "optional: a commit; without it, the branch's head",
  "event": "push, pull-request or schedule",
  "base": "optional: commit to diff against for paths: and changed()",
  "owner": "optional: defaults to github.com-acme",
  "repo-id": "optional: defaults to web",
  "default-branch": "main",
  "storage-quota": "10GiB, or bytes; overrides the server's --storage-quota",
  "pipeline": "optional: a pipeline file's text, run instead of the repository's",
  "ref": "optional: the ref the commit is reachable from, such as refs/pull/12/head; default refs/heads/<branch>",
  "token": "optional: for a private repository; never stored or echoed",
  "secrets": { "NPM_TOKEN": "optional: never stored or echoed, masked in output" },
  "vars": { "REGION": "optional: for ${{ vars.<name> }}" }
}
```

- **Capacity.** A run is admitted when a slot is free and fewer runs are
  active than there are slots; otherwise `429` with `Retry-After` and the
  current capacity, so the balancer can try another runner. `prepare` takes
  a slot while it works and is refused the same way.
- **Logs.** For each pipeline, `pipeline-started` (its jobs: `key`, `name`,
  `needs` and the `ids` their entries report under, or `null` while a matrix
  waits on another job), then `job-started`, `output` (one line, with its
  stream) and `job-finished` events; then `run-finished`. A finished job's
  report carries its `needs` too. A client that connects late
  gets the backlog first. Up to 8 MiB of output is kept per run; past that a
  `truncated` event says so and job events still flow. A comment every 15 s
  keeps idle connections open through proxies.
- **Billing.** Each run writes a record to
  `usage/<owner>/<yyyy>/<mm>/<started>-<id>.json`: the run, its jobs, and
  its usage. A job is charged its wall time at `1 / jobs-per-cpu` of a vCPU
  (`vcpu_seconds`) and the memory it reserved over that time
  (`memory_gib_seconds`). Failed and errored runs are recorded too, with no
  usage. Storage is read from `GET /v1/storage/{owner}`, for billing by
  GB-month.
- **Quotas.** An owner's caches across all its repositories are held to its
  storage quota: the request's `storage-quota`, else the server's
  `--storage-quota` (default 10 GiB).

### Warm builtins

`iwci serve` downloads and compiles every published builtin and environment
when it starts, then again every `--warm-every` (default `10m`), so a job
never waits on a cold tool: the newest release of each `major.minor`,
which covers every pin a pipeline can write. Blobs stay in the disk cache
in front of R2 (`<cache>/objects`) and compiled code in the module cache
(`<cache>/modules-*`, and in memory); neither is ever evicted, so give the
cache directory a persistent disk. Repository tools warm on first use.
`/v1/capacity` reports the last round under `warm`. `--no-warm` turns it
off.

## Scheduled runs

`app/packages/ci-proxy` is a Cloudflare Worker that sits in front of the
runners and owns schedules, because a Cron Trigger fires once for a whole
Worker, where every runner in a pool keeping its own clock would fire each
schedule once per runner. Its README has the routes; the short version:

1. `PUT /v1/schedules` on the proxy registers a repository. The proxy asks a
   runner (`POST /v1/schedules/read`) which pipelines on the default branch
   have `on.schedule`, and stores their crons and text in D1. Tokens are
   refused: a scheduled run of a private repository uses the runners'
   `IWCI_GIT_TOKEN`.
2. Once a minute the proxy re-reads registrations older than ten minutes
   (twenty per minute at most), then matches every stored cron against the
   minute. A due pipeline is claimed in D1 for that minute first, so a
   repeated trigger fires nothing twice, and then sent as a normal run with
   `event: schedule` and the stored text as `pipeline`.
3. A minute that finds every runner full is recorded as `no-capacity` and
   not retried. Billing is the runners' own usage record, as for any run.

## Known limitations

- **Pipelines in `env:` scripts.** WASIX bash reports only the last
  command's exit status: `false | cat` succeeds even under `pipefail`, and
  `PIPESTATUS` holds one entry. A plain failing command, or one inside
  `$(...)`, does stop the script. This is in Wasmer's bash/WASIX process
  handling, not in the runner.
- **Coreutils `dd` cannot create a new output file** under WASIX ("No
  such file or directory"); it writes into one that exists, and
  `head -c N /dev/zero > file` creates one. Writing to stdout fails too,
  because it tries to truncate it.
- **Plain WASI tools resolve relative paths from `/`.** A `wasm32-wasip1`
  tool built on wasi-libc (Rust, C, TinyGo) starts in `/` whatever the
  job's `cwd`, so `.` is the root of the job's file system. The `cwd`
  reaches it only as `$PWD`: a `repo:` tool joins relative paths onto
  `$PWD`, or the job passes absolute paths. WASIX tools (oxfmt) ask the
  runtime for their working directory and Go's `wasip1` port reads `$PWD`,
  so neither is affected. Preopening the `cwd` as `.` cannot fix this, so
  do not retry it
  ([#906](https://github.com/Infrawrench/Infrawrench/issues/906)):
  wasi-libc strips `/` and `.` from preopen names, so both become the
  empty prefix; it makes a relative path
  absolute against its own cwd, which is always `/`, before looking it up,
  so `foo` and `/foo` arrive as the same path; and of equal matches it
  takes the preopen registered last. With `.` before `/` nothing changes;
  with `.` after `/` relative paths work but every absolute path
  (`/tmp/workflow`, a tool's data files) resolves inside the `cwd`. The
  runtime test `a_command_sees_only_the_root_preopen_and_its_cwd_as_pwd`
  pins the layout.
- **A refused write reads as an I/O error** to the program (`EIO`), not
  "no space left", because Wasmer does not carry the error kind through.
  The job's report names the limit.
- **Not run end to end yet:** the real TypeScript module (the runtime's
  `tsc-host` tests use a module written to the same ABI), oxfmt for WASIX,
  the `node` feature (implemented, never compiled here), real R2 (including
  its `DELETE` and listed sizes, which quota eviction uses) and a real
  HTTPS git remote with a token.
- **Quotas are enforced per save**, by listing the owner's caches; two
  runners saving for one owner at the same moment can overshoot by one
  entry until the next save.
- **The server keeps live state in memory**: active runs and log hubs. A
  restarted runner forgets them; finished reports and records are in the
  store.
- **Runner-local caches** (git, downloads, installs, compiled modules)
  are not evicted yet and count against no owner; give the cache directory
  its own disk.
- **The in-memory file system has no mode bits**, so executables are
  checked out as plain files; a commit keeps the original mode.
- **Submodules** are skipped with a warning, and Cargo `git` dependencies
  are reported rather than vendored.
- **Pushing** the commit a `changes: commit` job makes is left to the
  integration: the commit is written to the git cache, and
  `RemoteCache::export_objects` lists its objects for the forge's API.

### Deploying, draining and updating

`infra/ci-runners` (Terraform) provisions runner hosts over SSH and tells
the proxy about them; its README has the steps. Two things in `iwci serve`
make that safe to do while jobs run:

- **Draining.** SIGTERM, SIGINT and `POST /v1/drain` stop new runs from
  being admitted (`429`, and `draining` in `/v1/capacity`, which the proxy
  reads to place work elsewhere) and let the running ones finish; on a
  signal the server then exits 0. A systemd unit's stop timeout therefore
  has to cover the longest job (60 minutes).
- **Updating itself.** With `--update-channel stable`, the server reads
  `releases/iwci/channels/stable.json` every `--update-every` (default 5m).
  It only believes a manifest signed by the release key
  (`IWCI_RELEASE_PUBLIC_KEY`): every host's store credentials can write to
  the bucket, and an unsigned channel would let one host push a native
  binary to all of them. When the channel names another version, the server
  downloads that version's binary for its platform, checks the signed size
  and sha256 and that it reports the right version, drains, and `exec`s it
  with the same arguments. The process id stays the same, nothing is
  killed, and pointing the channel back at an older version rolls back.

Releases are published with `iwci release <binary> --version <v>
[--target x86_64-linux] [--channel stable]` (signing key from
`IWCI_RELEASE_SIGNING_KEY`), normally by `.github/workflows/ci-runner-release.yml`
when `ci-runner/VERSION` changes. `iwci release-keygen` makes a key pair,
and `iwci version` prints the build's version (`IWCI_VERSION` at build
time). A version's binary is uploaded once and never replaced.

## Storage layout (R2)

The `iwci-store` crate documents the exact key layout and manifest formats;
the short version is that everything executable is content-addressed under
`blobs/sha256/`, manifests name blobs by hash, builtins and environments
live under their own prefixes, and a repository's uploaded tools live under
`repos/<repo-id>/tools/`, which is the only place a `repo:` reference looks.
Uploading is not implemented: the layout is the contract the upload API
will write to. Job caches are under `caches/<owner>/<repo-id>/<scope>/`,
billing records under `usage/<owner>/`, run reports under
`runs/<owner>/`, and releases of `iwci` itself under
`releases/iwci/<version>/<target>` (immutable) with signed channel
manifests at `releases/iwci/channels/<channel>.json`.

## Crates

| Crate          | Does                                                                                |
| -------------- | ----------------------------------------------------------------------------------- |
| `iwci-spec`    | The pipeline file: parse, validate, expand, interpolate.                            |
| `iwci-vfs`     | Snapshots and per-job overlays over Wasmer's `virtual-fs`.                          |
| `iwci-git`     | Shallow fetch with a persistent cache, checkout into a snapshot, commits.           |
| `iwci-deps`    | pnpm, Go and Cargo installers over a verifying, caching fetcher.                    |
| `iwci-store`   | R2 and local object stores, manifests, tool resolution.                             |
| `iwci-runtime` | Wasmer: compiled-module cache, WASI/WASIX commands, the tsc-host ABI, environments. |
| `iwci`         | The scheduler and the `iwci` command.                                               |

## Development

```sh
cd ci-runner
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

Tests never reach the network. The ones that need real artifacts say which
environment variable points them at the files: gofmt (`IWCI_TEST_GOFMT_WASM`)
and the bash environment (`IWCI_TEST_WEBC_DIR`, an environment's `dist/`
directory) skip without one, and the TypeScript module and live registries
are `#[ignore]`d. `IWCI_REQUIRE_FIXTURES=1` turns those skips into failures,
which is how CI runs them.

### Testing the builtins

`builtins/test.sh` tests builtins the way a user meets them: it builds each
with its own `build.sh`, publishes it to a throwaway store with `iwci
publish`, and runs pipelines through `iwci run` against a fixture
repository that has something to pass and something to fail for each tool.

```sh
cargo build -p iwci
bash builtins/test.sh                        # gofmt and bash
bash builtins/test.sh typescript oxfmt       # needs their toolchains
cargo build -p iwci --features node && bash builtins/test.sh bash-node
```

A job whose key ends in `-passes` must pass and one ending in `-fails` must
fail; a tool that will not resolve or start is an error and fails the test.
`SKIP_BUILD=1` reuses what is already in `dist/`.

In CI, `ci-runner.yml` builds and tests gofmt and bash on every change.
`ci-runner-builtins.yml` builds and tests typescript, oxfmt and bash-node,
which each need a large toolchain, on changes to the builtins, the runtime
or the store, and nightly, because those builds resolve crates and a WASIX
toolchain that this repository does not pin byte for byte. The Node job
runs on x86_64; `ci-runner.yml`'s "Build with Node on ARM64" job builds the
`node` feature on ARM64 on every change, so the second architecture cannot
break unnoticed.
