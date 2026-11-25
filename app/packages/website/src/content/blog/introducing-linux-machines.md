---
title: "Linux machines in Infrawrench CI"
description: "Add platform: linux and a CI job runs in an Ubuntu 24.04 machine of its own, with Docker and Chrome, in the same pipeline as the WebAssembly sandbox jobs it hands artifacts to. On cicdbench.com's repos it ran 1.4× faster than the fastest runner they measured."
date: 2026-11-25
author: The Infrawrench team
---

Infrawrench CI runs most jobs in a WebAssembly sandbox over an in-memory snapshot of the commit. That is what makes a pipeline of hundreds of small jobs cheap. Some jobs need a whole operating system, though: Docker, a real browser, a native compiler, a test suite that shells out to system tools. Those can now run in a Linux machine of their own, in the same pipeline as everything else.

## One line

Add `platform: linux` to a job:

```yaml
jobs:
  e2e:
    platform: linux
    memory: 8GiB
    run: |
      docker compose up -d
      npx playwright install --with-deps chrome
      npm run test:e2e
```

- **Ubuntu 24.04**, in a virtual machine started for the job and thrown away when it ends.
- **It boots in under a second.**
- **Its `memory:` is the whole machine's** (2 GiB unless the job says), and past that it swaps to a disk of its own, up to 20 GiB, rather than running out. If it does run out, the job's log ends with what the machine's kernel said.
- **Its network reaches the same places as any job's**, and `network: false` turns it off.
- **The script runs in `bash`**, or `sh` or `pwsh` with `shell:`.

![A Linux machine job and what every machine ships with](/blog/linux-machines/01-linux-machine.png)

## What's inside

The image is close to GitHub's hosted Ubuntu 24.04 runner, without its largest SDKs (Android, .NET):

| Area       | What ships                                       |
| ---------- | ------------------------------------------------ |
| System     | Ubuntu 24.04, apt, sudo                          |
| Containers | Docker with buildx and Compose                   |
| Browser    | Google Chrome, so Playwright installs in seconds |
| JavaScript | Node.js with nvm, Bun, pnpm and Yarn             |
| Python     | Python 3, pip, venv and uv                       |
| Go         | Go with goenv                                    |
| Rust       | Rust with rustup                                 |
| Ruby       | Ruby with rbenv and ruby-build                   |
| Java       | OpenJDK 21                                       |
| Build      | GCC, Clang, LLVM, CMake, Ninja, make             |
| CLIs       | git, git-lfs, gh, kubectl, jq, yq, PowerShell    |

`apt-get install` uses Ubuntu's live archive, and `cache:` keeps whatever a job installs between runs. Node.js, Ruby and Go versions that `nvm`, `rbenv` and `goenv` install are kept between runs of the job too: `nvm install 22` downloads once, and the next run starts with it.

## Wasm and Linux in one pipeline

A machine job is a job like any other. It gets the commit, the artifacts of the jobs it `needs:`, and its caches, and its own `artifacts:`, `outputs`, `cache:` and `/tmp/workflow` work as they do in the sandbox. So the jobs that need a kernel get a machine, everything else stays in the sandbox, and they hand files to each other:

```yaml
jobs:
  build:
    using: env:bash-node@24
    run: npm run build
    artifacts: [dist]

  e2e:
    platform: linux
    needs: [build]
    run: npx playwright test
    artifacts: [report]

  summary:
    using: env:bash-node@24
    needs: [e2e]
    run: node summarize.js report
```

![build in the WebAssembly sandbox hands dist/ to e2e in a Linux machine, which hands report/ back](/blog/linux-machines/02-wasm-and-linux.png)

Docker runs in every machine, with its storage on the machine's own disk. Here is ripgrep's own CI on Infrawrench CI: 19 jobs, 10 of them cross-compiling in Docker containers, in 2 minutes 25 seconds on a rerun.

![The run page for ripgrep's CI, with a cross-compile job's log showing its Docker image pull](/blog/linux-machines/03-run-view.png)

## The benchmark

[cicdbench.com](https://cicdbench.com) is an independent benchmark of CI runners. It ran eight open-source repositories' own CI on five runner providers, with GitHub's hosted runner as a reference, and publishes each provider's time for every repository: on a clean start (a new branch and pull request) and on a rerun of the same commit with the cache from the run before.

We ran the same eight repositories' CI, as Infrawrench pipelines, on our own runners on 25 November, one run at a time, and compared them with the runner cicdbench.com ranks fastest on both reruns and clean starts. These are our runs, not cicdbench.com's: they did not run, review or endorse them. Each number is a single run, as on cicdbench.com, so small differences are noise.

| Repository      | Rerun  | Fastest runner | Result       | Clean start | Fastest runner | Result       |
| --------------- | ------ | -------------- | ------------ | ----------- | -------------- | ------------ |
| create-t3-turbo | 18.5 s | 36.6 s         | 1.98× faster | 19.3 s      | 39.6 s         | 2.05× faster |
| documenso       | 43.8 s | 163.8 s        | 3.74× faster | n/a         | 192.6 s        | n/a          |
| shadcn/ui       | 356 s  | 381 s          | 1.07× faster | 335 s       | 443 s          | 1.33× faster |
| fastapi         | 63.7 s | 133.8 s        | 2.10× faster | 63.4 s      | 133.8 s        | 2.11× faster |
| ripgrep         | 145 s  | 201 s          | 1.39× faster | 142 s       | 200 s          | 1.41× faster |
| tRPC            | 153 s  | 172 s          | 1.12× faster | 154 s       | 183 s          | 1.19× faster |
| vercel/ai       | 227 s  | 327 s          | 1.44× faster | 235 s       | 345 s          | 1.47× faster |
| email-sdk       | 113 s  | 106 s          | 1.07× slower | 112 s       | 109 s          | 1.03× slower |

documenso's pipeline runs only on its main branch, so it has no clean start of ours to compare.

- **Median, rerun:** 1.4× faster than the fastest runner cicdbench.com measured, across the eight repositories.
- **Median, clean start:** 1.4× faster, across the seven with one.
- **Against GitHub's hosted runner**, using the times cicdbench.com published for it: 2.6× faster on a rerun and 2.5× faster on a clean start, at the median.

![Seven of cicdbench.com's repositories, rerun on Infrawrench CI and on the fastest runner cicdbench.com measured](/blog/linux-machines/04-benchmark.png)

## What a run costs

At list price, a job is billed $0.00008 per vCPU-second and $0.000008 per GiB-second of the memory it reserves, for the time it runs. A rerun of create-t3-turbo's CI (lint, format and typecheck) cost under 1¢, and the median rerun across the eight repositories cost about $0.10. CI is part of every paid plan; [CI pricing](/docs/features/ci#usage-and-billing) has the details.

![1.4× faster on a rerun and from a clean start, and what a run costs](/blog/linux-machines/05-numbers.png)

## What changed on the runners this week

Running this benchmark found a lot to fix. All of it is live:

- **New runner hosts.** The same jobs finish between 2% and 37% sooner than they did a day earlier.
- **Runs are recorded the moment they finish.** The runner tells the app when a run changes, so the run page and the GitHub check update within a second instead of on the next poll.
- **Cache saves happen after the job.** A job is reported done before its caches upload, so the jobs that need it start straight away. The run still waits for every save.
- **Machines download faster.** About 60% more throughput for image pulls, apt and package installs, for less CPU.
- **The built-in Turborepo remote cache answers every request.** A lookup could sit unanswered until the client gave up, and the task was rebuilt.
- **Many connections at once no longer cross.** A job that opened more than 64 connections at once, as `bun install` does, could lose one mid-handshake and wait out a 300 second timeout.
- **Machines have room to swap.** 20 GiB past their memory, and they reclaim memory earlier under pressure.

## Try it

Add `platform: linux` to any job in `.infrawrench/ci/`. The [CI docs](/docs/features/ci#linux-machines) cover machines in full.
