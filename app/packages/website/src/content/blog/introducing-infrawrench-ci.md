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

The **task cache** skips a job whose inputs have not changed since it last passed, and hands on that run's log, outputs and artifacts as if it had run again. The key covers the job's definition, its tools, the lockfiles, the files its inputs match and every artifact it is handed. A change at the bottom of a monorepo reruns what depends on it, and nothing else.

With `split: true`, another runner can take some of a run's jobs when the runner that has it is short of slots or memory. The run is still billed once.

## Your languages, already built

Environments and tools are prebuilt for WebAssembly, pinned by version and kept warm on every runner:

- **Runtimes:** Node 24, Python 3.13, PHP 8.1 to 8.5, Go 1.23 to 1.27, Bash 5 and Git 2.56.
- **Dependencies:** pnpm, Bun, Go modules, Cargo crates, pip and Composer, installed from the lockfile and verified against it.
- **Services:** PostgreSQL 18.4 and ClickHouse 26.11.
- **Tools:** TypeScript 7.1 (tsc-rs), kubectl, OpenSSH, and the AWS, Azure, Google Cloud, Vercel, Wrangler and Neon CLIs.

![Languages and tools](/blog/infrawrench-ci/05-languages.png)

Anything that cannot run in WebAssembly, compiling Rust for example, runs as a cloud job instead.

## Run jobs on your own cloud

`cloud:` runs a job on one of your organisation's connected accounts instead of on our runners. 33 providers can run jobs: AWS, Google Cloud, Azure, Docker, Kubernetes, DigitalOcean, Hetzner, Oracle Cloud and 25 more. A job can be a fresh VM, a one-off container, a managed image build, an existing host over SSH, or a job on an existing cluster.

![33 providers](/blog/infrawrench-ci/06-clouds.png)

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

![Start containers in your own cloud](/blog/infrawrench-ci/07-containers.png)

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

![Lend an SSH key](/blog/infrawrench-ci/08-ssh.png)

![Lend a cluster](/blog/infrawrench-ci/09-kubernetes.png)

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

![Build and push images](/blog/infrawrench-ci/10-builds.png)

## Safe by default

- A pull request from a fork runs only once a maintainer approves it, never sees secrets, and is never lent anything.
- Secrets are read only into `env:` values and are masked everywhere a job's text leaves by: the live log, captured output, errors, outputs and text downloads.
- A job reaches the public internet and its own private loopback, never the runner's host, its private network or cloud metadata addresses.

## Try it

Infrawrench CI is available now. Open **CI** in the web or desktop app, connect a GitHub account, add a pipeline to `.infrawrench/ci/` and push. The [CI docs](/docs/features/ci) cover the pipeline file, the tools and cloud jobs in full.
