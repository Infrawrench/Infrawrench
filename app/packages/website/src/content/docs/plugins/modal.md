---
title: Modal
description: Track Modal spend per app and per resource type (each GPU type, CPU, memory) with credits and plan adjustments, watch environment spend limits and concurrency caps, and manage environments, apps, functions, schedules, volumes, secrets, dicts and queues.
sidebar_order: 51
---

Connect Modal to see what each app and GPU type costs, keep environments under their caps and spend limits, and manage apps and their storage.

## What you can manage

- **Workspace**: the Modal workspace your token belongs to. Its page shows this billing cycle's **metered** cost (what usage cost at Modal's rates) and **billed** cost (what Modal will invoice), the adjustments between them (credits, the plan allowance, reservations, the egress allowance), metered cost by product (deployed apps, ephemeral apps, volumes, notebooks and so on), and the workspace rate card. The Metrics tab charts cost per day, cost per resource type, GPU cost and GPU hours.
- **Environments**: every environment in the workspace, with running containers and GPUs in use, the concurrency caps, and spend this cycle against the environment's budget and spend limit. **Create** an environment (name, an optional web endpoint suffix and optional caps), **edit** its name, suffix and caps, or **delete** it. The Metrics tab charts the environment's cost per day by resource type.
- **Apps**: deployed, ephemeral and recently stopped apps across every environment, with their state, running containers, version and who deployed them. Each app's page lists its functions and servers with their GPUs and schedules, its tags and its deployment history. The Metrics tab charts its cost per day by resource type. **Stop app** ends a running app after you confirm. A stopped app can't be restarted, only deployed again, so this action is blocked during a [change freeze](../team-and-billing/change-freeze.md).
- **Functions**: every function, class and server of a deployed app.
  - The list shows each one's GPU (with any fallback GPUs) and schedule.
  - The page adds CPU, memory and disk, input concurrency, autoscaling (min, max and buffer containers, scale-up and scale-down windows), timeouts, the web endpoint URL, and live **queued inputs**, **running inputs** and **containers**.
  - The Metrics tab charts successful, failed and timed-out inputs, **cold starts** (containers started), container errors, execution time and end-to-end latency percentiles, and container CPU, memory and GPU utilization.
- **Scheduled functions**: the functions that run on a cron or fixed period, with their schedule and app, and the same charts as any function.
- **Volumes**, **secrets**, **dicts** and **queues**: listed per environment with who created them and when. Secrets show their key names and when they were last used. Values are never read. Queues show their partitions and how many items are waiting. You can delete each one from its page.

Functions are read-only here. Resources, scaling and schedules live in your app's code and change on the next `modal deploy`.

## Connect your account

You need both halves of a Modal API token:

- **Token ID**, starting with `ak-`.
- **Token secret**, starting with `as-`. Modal shows it once, when you create the token.

Create a token under **Settings > API Tokens** in the Modal dashboard, or run `modal token new` and copy `token_id` and `token_secret` from `~/.modal.toml`. A token belongs to one workspace and sees every environment in it.

<insert [Modal Add-account form with the Token ID and Token secret fields filled] here>

## Read your costs

Modal spend shows in [cost graphs and budgets](../features/cloud-costs.md), using the same data as `modal billing report`:

- **Daily, per object, per resource type.** Each row is one day of one Modal object (an app, a sandbox, a volume and so on) for one resource: `CPU`, `Memory`, or a specific GPU type. The resource is the **service**, the object id is the **resource**, and every row has the tags `environment`, `object` (the app's name), `objectType` (App, Sandbox, Volume and so on) plus every tag you put on the app. Group by service to see spend by GPU type, by resource to see it by app, or by a tag like `team` that you set on your deployments.
- **Credits and adjustments.** Rows show metered cost, before credits. Each billing cycle's adjustments (credits, plan allowance, reservations, the egress allowance) are added as their own rows on the first of the month with a charge type, so a month adds up to what Modal invoices. Switch the [cost basis or charge-type filter](../features/cloud-costs.md) to see usage alone.
- **History.** Up to a year is loaded when you first connect. The last 35 days keep updating, because billing data can arrive late and adjustments change until the cycle closes.

**Modal only offers billing data on the Team and Enterprise plans.** On the Starter plan you still see everything above, and a notice tells you spend is only visible in the Modal dashboard.

<insert [Cost graph grouped by service for a Modal account, showing H100 GPU, CPU and Memory stacked by day] here>

<insert [Modal workspace page showing metered and billed cost this cycle, the adjustments table and the rate card] here>

## Watch caps and spend limits

Each environment's concurrency caps and spend limit show on the [quota radar](../features/quota-radar.md): running containers against **Max concurrent containers**, GPUs in use against **Max concurrent GPUs**, and spend this cycle against the spend limit. Only caps you've set appear. Modal doesn't share workspace-wide plan limits.

## Run CI jobs

A Modal connection can run [Infrawrench CI](../features/ci.md) cloud jobs once an organization admin opts it in. Each job runs in a fresh Modal Sandbox, under an app named `infrawrench-ci` in the workspace's default environment:

| `cloud.kind` | Runs on         | Default `machine` | Default `image`             |
| ------------ | --------------- | ----------------- | --------------------------- |
| `container`  | A Modal Sandbox | `2vcpu-4gb`       | `buildpack-deps:noble-curl` |

`machine` is `<vCPUs>vcpu-<GB>gb`, such as `4vcpu-8gb` or `8vcpu-32gb`. Modal counts physical cores, each two vCPUs, so `2vcpu-4gb` asks for one core. `image` is any public registry image (`ubuntu:24.04`, `nvidia/cuda:12.8.0-runtime-ubuntu24.04`); the job installs `bash`, `curl` and `tar` into it when it lacks them. Modal prepares a new image once, which makes that image's first job slower.

`cloud.gpu` takes Modal's GPU names with an optional count: `T4`, `L4`, `A10`, `L40S`, `A100`, `A100-40GB`, `A100-80GB`, `RTX-PRO-6000`, `H100`, `H100!`, `H200`, `B200`, `B200+` or `B300`, such as `H100:2` (at most 8, or 4 for an A10). Spellings like `nvidia-h100` or `a100-80gb` work too. Pick a CUDA image for a GPU job when it needs the CUDA libraries.

`cloud.region` is optional and is one of Modal's region names, such as `us`, `eu`, `us-east` or `eu-west`. Modal charges 1.15 times as much in a broad region and 1.75 times in a narrow one, so leave it out unless the job needs it.

The Sandbox gets no Modal credentials: no secrets, no volumes and no identity token. It ends at the job's time limit, which Modal enforces, and Infrawrench stops it when the job ends. A Sandbox runs at most 24 hours, so longer jobs are refused. Modal bills Sandboxes by the second at its non-preemptible CPU and memory rates, and GPUs at the standard rate.

Modal tokens can't say what they're allowed to do, so opting a connection in reads the default environment, makes the empty `infrawrench-ci` app if it's missing (it costs nothing), and lists its Sandboxes. The token's user needs the **Contributor** role in the default environment; a Viewer is refused.

## Tips and limits

- **You can't remove a cap here.** You can raise or lower an environment's concurrency caps, but to remove one entirely, use the Modal dashboard.
- **GPU hours are estimated.** They're each GPU type's cost divided by the hourly rate on your workspace's rate card. A GPU the rate card doesn't name shows nothing.
- **Function charts are grouped into time slices.** A longer window means coarser points. Modal says its latency and utilization metrics may change, and a metric Modal stops reporting disappears from the chart.
- **Provider status** follows [status.modal.com](https://status.modal.com). Incidents show on the affected functions, apps, volumes, dicts, queues and secrets. See [Provider status](../features/provider-status.md).
