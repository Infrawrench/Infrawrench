# ci-runner

A CI runner that runs every job in a WebAssembly isolate. On each commit it
clones the repository once, installs its dependencies once, freezes the
result in memory, and then starts each job in its own [Wasmer] instance over
a copy-on-write view of that snapshot. A job starts in the time it takes to
instantiate a module that is already compiled: there is no container to
pull, no clone per job and no `pnpm install` per job.

It is not wired into the rest of Infrawrench yet. It is a standalone Rust
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
   package manager runs and no install script executes. This is the only
   step with network access, and both its results are cached: see
   [Caching](#caching).
4. **Resolve tools** (`iwci-store`). Each `using:` resolves to a manifest
   and content-addressed blobs in R2, verified by sha256.
5. **Run** (`iwci-runtime`). Jobs run in parallel as soon as their `needs`
   finish and their `paths:` and `if:` allow it, each in a fresh Wasmer instance with no network and no host file
   system, under a timeout and a memory limit. Compiled modules are cached
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

| Key         | Meaning                                                                                             |
| ----------- | --------------------------------------------------------------------------------------------------- |
| `name`      | Required.                                                                                           |
| `on`        | `push` and/or `pull-request`, each with optional `branches` and `paths` globs. Omitted: every push. |
| `workspace` | `clone` and `deps` shared by every job unless it overrides them.                                    |
| `jobs`      | Map of job key (lowercase, digits, `-`, `_`) to job.                                                |

`workspace.clone`: `depth` (`1` by default, more commits, or `full`), `into`
(default `/app`), `submodules` (default `false`).

`workspace.deps`: a list of `pnpm`, `go` or `cargo`, or `- go: { dir: tools }`
to read a lockfile below the root. pnpm also takes `only: [app/packages/web]`
to install just those importers' closure.

### Jobs

| Key       | Meaning                                                                                                                                                                        |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `using`   | Required. `builtin:<name>@<version>`, `repo:<name>@<version>` or `env:<name>@<version>`. See below.                                                                            |
| `args`    | For a tool: a list, or one line split like a shell splits words (quotes group, nothing expands).                                                                               |
| `run`     | For an environment: a bash script, run with `set -euo pipefail`.                                                                                                               |
| `name`    | Display name. Defaults to the key plus the matrix values.                                                                                                                      |
| `matrix`  | `[a, b]` (read as `${{ matrix }}`) or named axes `{ os: [a, b], mode: [x] }` (read as `${{ matrix.os }}`), with an optional `exclude:` list of combinations. Up to 64 entries. |
| `cwd`     | Working directory in the isolate. Defaults to the clone.                                                                                                                       |
| `env`     | Extra environment variables. `IWCI_*` is reserved for the runner.                                                                                                              |
| `clone`   | Override `workspace.clone`, or `false` for an empty file system.                                                                                                               |
| `deps`    | Override `workspace.deps`, or `false` to install nothing.                                                                                                                      |
| `changes` | `ignore` (default), `fail`, or `{ commit: "<message>" }`.                                                                                                                      |
| `needs`   | Jobs that must finish first. Naming a matrix job waits for all of its entries.                                                                                                 |
| `if`      | When the job runs, given how its `needs` went. See below.                                                                                                                      |
| `outputs` | Names the job writes to `$IWCI_OUTPUT` for later jobs to read. Not allowed on a matrix job.                                                                                    |
| `paths`   | Skip the job unless the commit touches one of these globs. A skipped job does not block its dependents.                                                                        |
| `timeout` | `90s`, `10m`, `1h`. Default `10m`, at most `60m`.                                                                                                                              |
| `memory`  | `512MiB`, `4GiB`. Default `2GiB`, between `16MiB` and `16GiB`.                                                                                                                 |

Expressions in `name`, `cwd`, `args`, `run` and `env`: `${{ matrix }}`,
`${{ matrix.<axis> }}`, `${{ needs.<job>.outputs.<name> }}`,
`${{ needs.<job>.result }}`, `${{ commit.sha }}`, `${{ commit.short-sha }}`,
`${{ commit.branch }}`, `${{ repo.id }}`, `${{ event }}`. Each is one name;
operators belong in `if:`. Every name is checked when the file is parsed:
reading a job that is not in `needs:`, or an output that job does not
declare, is an error at push time rather than an empty string at run time.

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
| `bash-node@24` | the above plus `wasmer/edgejs` 0.2.5 (Node 24 compatible; `node`, `npm`, `pnpm`)                                                    |

Scripts run with `set -euo pipefail`, but see the known limitations: under
WASIX a pipeline currently reports only its last command's status.

Edge.js's WASIX package has no JavaScript engine inside it: it imports
N-API from the host, and the runner provides it with V8 through
[`wasmer-napi`]. That is the runtime crate's `node` feature, off by default
because it links V8.

`builtins/*/build.sh` builds each into `dist/`, and `iwci publish` uploads
it. Every package and source is pinned to a tag or a content hash.

[tsc-rs]: https://github.com/pingdotgg/ts-rust
[`wasmer-napi`]: https://crates.io/crates/wasmer-napi

### Go and Rust

Go and Rust are supported the way every language is here: their dependency
installers make a commit's modules and crates available offline, and any
tool compiled to `wasm32-wasip1` or WASIX runs as a builtin or a `repo:`
tool. What does not run yet is the compilers themselves. `go build` and
`go test` need `cmd/compile` and `cmd/link` as subprocesses of the `go`
command, and `cargo test` needs rustc, which has no WebAssembly build that
can host itself. WASIX's process spawning is the path to the Go toolchain;
for now, jobs that must compile Go or Rust belong on a conventional runner.

## The `iwci` command

```sh
iwci validate .infrawrench/ci/*.yml [--json]      # check files, all errors at once
iwci plan .infrawrench/ci/tests.yml [--json]      # the expanded jobs
iwci run --repo https://github.com/org/repo --sha <commit> --repo-id <id> \
         [--branch main] [--event push|pull-request] [--base <sha>] \
         [--pipeline <file>] [--cpus <n>] [--memory <size>] [--json] [--store <dir>]
iwci publish dist/builtin/gofmt/1.27.3 ...        # upload builtins/*/build.sh output
```

`--store <dir>` uses a local directory laid out like the bucket; without
it, R2 comes from `IWCI_R2_ACCOUNT_ID`, `IWCI_R2_BUCKET`,
`IWCI_R2_ACCESS_KEY_ID` and `IWCI_R2_SECRET_ACCESS_KEY`, with a disk cache
in front. A private repository's token is `IWCI_GIT_TOKEN`. Credentials come
from the environment only. `--base` gives the changed paths that `paths:`
and `changed()` read. Caches (git, fetched packages, compiled modules,
objects) live under `--cache`, `$IWCI_CACHE_DIR` or `~/.cache/iwci`.

Jobs see `CI=true`, `IWCI_COMMIT`, `IWCI_BRANCH`, `IWCI_REPO_ID`, `IWCI_JOB`
and `IWCI_OUTPUT`, plus `PWD` set to their `cwd` (Go's `wasip1` port reads
its working directory from it). Installers add their own: Go jobs get
`GOMODCACHE`, `GOPROXY=off`, `GOFLAGS=-mod=readonly` and friends, Cargo jobs
`CARGO_NET_OFFLINE=true`.

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

`iwci run --cpus <n> --memory <size>` (or `IWCI_CPUS` and `IWCI_MEMORY`)
limits the whole runner:

- **`--cpus`** is how many jobs run at once, and also sizes the runtime's
  threads, the pool Wasmer compiles modules on, and the installers'
  download and unpack threads. A WASIX program's own threads and
  subprocesses (bash running `sed`) are not capped, because a script waiting
  on its child would deadlock if they were. Default: the machine's cores.
- **`--memory`** is a hard budget across running jobs. A job reserves its
  `memory:` for its program before it starts and only starts when that
  fits, and every byte it then writes to its in-memory file system is
  charged as it is written. Jobs that do not fit together wait their turn,
  and a job asking for more than the whole budget is an error rather than a
  hang. The frozen workspace snapshots are not counted: they are built once
  and shared. Default: no budget.

A job's `memory:` holds both its program memory and what it writes. The
files a job writes live in memory, so without that a job could write past
any limit. A write over either limit is refused before any of it lands; the
job's report says which limit it hit.

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
- **A refused write reads as an I/O error** to the program (`EIO`), not
  "no space left", because Wasmer does not carry the error kind through.
  The job's report names the limit.
- **Not run end to end yet:** the real TypeScript module (the runtime's
  `tsc-host` tests use a module written to the same ABI), oxfmt for WASIX,
  the `node` feature (implemented, never compiled here), real R2 and a real
  HTTPS git remote with a token.
- **The in-memory file system has no mode bits**, so executables are
  checked out as plain files; a commit keeps the original mode.
- **Submodules** are skipped with a warning, and Cargo `git` dependencies
  are reported rather than vendored.
- **Pushing** the commit a `changes: commit` job makes is left to the
  integration: the commit is written to the git cache, and
  `RemoteCache::export_objects` lists its objects for the forge's API.

## Storage layout (R2)

The `iwci-store` crate documents the exact key layout and manifest formats;
the short version is that everything executable is content-addressed under
`blobs/sha256/`, manifests name blobs by hash, builtins and environments
live under their own prefixes, and a repository's uploaded tools live under
`repos/<repo-id>/tools/`, which is the only place a `repo:` reference looks.
Uploading is not implemented: the layout is the contract the upload API
will write to.

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

Tests never reach the network. The ones that need real artifacts (a built
TypeScript module, Wasmer packages, a live registry) are `#[ignore]`d and say
which environment variable points them at the files.
