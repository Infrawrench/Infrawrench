---
title: Introducing Infrawrench CI
description: CI that runs every job in its own WebAssembly sandbox over an in-memory snapshot of the commit, on our runners or on the clouds you already use.
date: 2026-11-16
author: The Infrawrench team
---

Infrawrench CI runs the pipelines in a repository's `.infrawrench/ci/` folder on every push and pull request. It is built around one idea: most of the time a CI job spends is not the job. It is pulling a container, cloning the repository and installing dependencies, again, for every job in the run. Infrawrench CI does each of those once per commit, and then starts every job from the result.

## The numbers

Infrawrench's own test pipeline runs on Infrawrench CI. It is 897 jobs: every package's build, typecheck and tests, the desktop, mobile, website and edge Worker typechecks, the VS Code and Raycast extension packages, formatting, translation checks, migrations, and Postgres and ClickHouse suites. Measured on our own runners on 15 November:

- **64 jobs at once** on one runner, each in its own WebAssembly sandbox.
- **9.1 seconds** for the whole pipeline when nothing changed: 890 of the 897 jobs come back from the task cache.
- **About 130 ms** for a cached job to come back, at the median, with its log, outputs and artifacts.
- **5× faster** full cold runs, with nothing cached, after one day of tuning: 1,337 s down to 262 s.

![The numbers](/blog/infrawrench-ci/02-speed.png)

## Against GitHub Actions, on the same commits

Until 13 November this pipeline ran on GitHub Actions. We ran that GitHub Actions workflow next to Infrawrench CI on the same commits of today's repository, and Infrawrench CI came back 2–5× faster.

![2–5× faster than GitHub Actions](/blog/infrawrench-ci/03-versus.png)

## How it works

When a commit arrives, the runner clones it once, shallow, straight into memory. It installs the dependencies once, from the lockfile, checking every package against the lockfile's hashes. No package manager runs and no install script executes. The result is frozen as a snapshot.

Every job then starts in its own [Wasmer](https://wasmer.io) instance, over a copy-on-write view of that snapshot. A job starts in the time it takes to instantiate a WebAssembly module that is already compiled. What a job writes to the checkout stays in its own layer, so one job's changes never leak into another's.

![Clone once, install once, run every job](/blog/infrawrench-ci/04-how.png)

With `split: true`, another runner can take some of a run's jobs when the runner that has it is short of slots or memory. The run is still billed once.

## One job per package

Where every job pays for its own machine, clone and install, a monorepo's CI ends up as a few big jobs that each run a slice of everything. Ours did: the GitHub Actions workflow it replaced had six. A failure was somewhere in a long log, and a one-line change reran all of it.

In Infrawrench CI a job costs none of that, so give every package its own. `packages:` turns one job definition into a job per workspace package, and `needs: ["^build"]` makes each one wait for the packages it depends on:

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

- Filter which packages a job runs in by directory or name (`only:`), by the files a package has (`has:`) and by its scripts (`has-script:`, `scripts:`).
- Each package's job is its own row and log in the run, so a failure points at one package.
- A package with a long suite can split it further with `matrix:`, without splitting every package's.

Infrawrench's own test pipeline is 897 jobs from 23 definitions in one file.

![Hundreds of small jobs, not a few huge ones](/blog/infrawrench-ci/05-jobs.png)

## The task cache

`task-cache:` skips a job whose inputs have not changed since it last passed, and hands on that run's log, outputs and artifacts as if it had run again. With a job per package, it is what makes a monorepo's CI recheck only what a change can affect, and it is how our 897-job pipeline comes back in 9.1 seconds when nothing changed.

```yaml
jobs:
  test:
    packages: { has-script: [test] }
    needs: ["^build"]
    task-cache:
      inputs: [src/**, "!src/**/*.md"]
      root-inputs: [tsconfig.base.json]
```

- **The key** covers the job's definition, the exact version of every tool and environment it uses, the lockfiles, the files its `inputs:` and `root-inputs:` match, and the bytes of every artifact it is handed. A job downstream of a change reruns only when what it is handed actually changed.
- **A hit costs nothing.** The job doesn't start, wait for a slot or take memory, and it isn't billed. A run where every job hits never installs dependencies.
- **`artifacts: false`** leaves the artifacts a job is handed out of its key, for a job that only passes them on, so a change at the bottom of the graph doesn't rebuild everything above it.
- **Pull requests keep their own results.** Nothing a pull request saves is reused on your default branch.
- **Retry** after a flaky failure reruns only what needs to run.

![Only what a change can affect runs](/blog/infrawrench-ci/06-cache.png)

## Your languages, already built

Environments and tools are prebuilt for WebAssembly, pinned by version and kept warm on every runner:

- **Runtimes:** Node 24, Python 3.13, PHP 8.1 to 8.5, Go 1.23 to 1.27, Bash 5 and Git 2.56.
- **Dependencies:** pnpm, Bun, Go modules, Cargo crates, pip and Composer, installed from the lockfile and verified against it.
- **Services:** PostgreSQL 18.4 and ClickHouse 26.11.
- **Tools:** TypeScript 7.1 (tsc-rs), kubectl, OpenSSH, and the AWS, Azure, Google Cloud, Vercel, Wrangler and Neon CLIs.

![Languages and tools](/blog/infrawrench-ci/07-languages.png)

Anything that cannot run in WebAssembly, compiling Rust for example, runs as a cloud job instead.

## Run jobs on your own cloud

`cloud:` runs a job on one of your organisation's connected accounts instead of on our runners. 33 providers can run jobs: AWS, Google Cloud, Azure, Docker, Kubernetes, DigitalOcean, Hetzner, Oracle Cloud and 25 more. A job can be a fresh VM, a one-off container, a managed image build, an existing host over SSH, or a job on an existing cluster.

![33 providers](/blog/infrawrench-ci/08-clouds.png)

An admin turns a connection on for CI and chooses the kinds of job it may run, how many at once and for how long. A pipeline then names it:

```yaml
jobs:
  e2e:
    cloud:
      provider: boat
      kind: vm
      machine: large
    run: |
      docker run -d -p 5432:5432 postgres:18
      pnpm test:e2e
```

![Start containers in your own cloud](/blog/infrawrench-ci/09-containers.png)

The job stays in the pipeline graph like any other. It gets the artifacts of the jobs it needs and hands its own on. The machine gets the commit, the job's environment and what it is lent, but never the cloud account's credentials. A fresh machine is torn down when the job ends. Pull requests from forks never run cloud jobs.

## Lend SSH keys and clusters to your jobs

A job can be lent an SSH key or a connection without anyone copying a credential into the repository:

- **SSH keys.** The key's owner turns on **Use in CI jobs** under Settings, SSH keys. A job that lists it in `ssh-keys:` finds the private key in `~/.ssh`.
- **SSH hosts.** A host connection adds a `Host` entry to `~/.ssh/config`, with its pinned host key and its jump host.
- **Kubernetes.** A cluster connection writes a kubeconfig and sets `KUBECONFIG`. A service account token is swapped for a short-lived one where the cluster allows it.

```yaml
jobs:
  deploy:
    needs: [image]
    connections: [prod-eu]
    ssh-keys: [deploy]
    tools: [builtin:kubectl@1.37, builtin:ssh@10.6]
    run: |
      kubectl -n web rollout restart deploy/web
      ssh web-1 sudo systemctl restart worker
```

![Lend an SSH key](/blog/infrawrench-ci/10-ssh.png)

![Lend a cluster](/blog/infrawrench-ci/11-kubernetes.png)

What is lent is masked in every log line, including the token inside a kubeconfig. A job lent anything is never task-cached, and nothing is ever lent to a pull request from a fork.

## Build and push images

`kind: build` runs a job on a managed build service with Docker: CodeBuild on AWS, Cloud Build on Google Cloud, ACR Tasks on Azure, or a privileged container on a Docker host you own. The image's digest is an output like any other, so the deploy job can use exactly what was built.

```yaml
jobs:
  image:
    cloud: gcp/build
    needs: [typecheck, unit, e2e]
    run: |
      docker build -t $IMAGE:${{ commit.sha }} .
      docker push $IMAGE:${{ commit.sha }}
    outputs: [digest]
```

![Build and push images](/blog/infrawrench-ci/12-builds.png)

## Safe by default

- A pull request from a fork runs only once a maintainer approves it, never sees secrets, and is never lent anything.
- Secrets are read only into `env:` values and are masked everywhere a job's text leaves by: the live log, captured output, errors, outputs and text downloads.
- A job reaches the public internet and its own private loopback, never the runner's host, its private network or cloud metadata addresses.

## Pricing

CI is part of the paid plan (Pro, $20 per seat per month) and is billed by the second for what your jobs use, on the same invoice:

- **vCPU time:** $0.00008 per vCPU-second ($0.0048 per vCPU-minute). Four jobs share a vCPU, so a job is charged a quarter of one for as long as it runs.
- **Memory:** $0.000008 per GiB-second of the memory a job reserves.
- **Storage:** $0.0002 per GiB-hour of caches and downloads kept on the runners, about $0.14 per GiB for a 30-day month.

A job with `memory: 4GiB` that runs for 10 minutes comes to 150 vCPU-seconds ($0.012) and 2,400 GiB-seconds ($0.0192), about $0.03. A task cache hit doesn't run, so it costs nothing, and a cloud job is billed by your own provider. [Billing and plans](/docs/team-and-billing/billing-and-plans#ci) has the details.

## Try it

Infrawrench CI is available now. Open **CI** in the web or desktop app, connect a GitHub account, add a pipeline to `.infrawrench/ci/` and push. The [CI docs](/docs/features/ci) cover the pipeline file, the tools and cloud jobs in full.
