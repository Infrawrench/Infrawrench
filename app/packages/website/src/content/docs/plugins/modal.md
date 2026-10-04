---
title: Modal
description: Track Modal spend per app and per resource type (each GPU type, CPU, memory) with credits and plan adjustments, watch environment spend limits and concurrency caps, and manage environments, apps, functions, schedules, volumes, secrets, dicts and queues.
sidebar_order: 51
---

## What you can manage

- **Workspace**: the Modal workspace the token belongs to. Its page shows this billing cycle's **metered** cost (what usage cost at Modal's rates) and **billed** cost (what Modal will invoice), the adjustments between them (credits, the plan allowance, reservations, the egress allowance), metered cost by product (deployed apps, ephemeral apps, volumes, notebooks…), and the workspace rate card. The Metrics tab charts cost per day, cost per resource type, GPU cost and GPU hours.
- **Environments**: every environment in the workspace, with running containers and GPUs in use, the concurrency caps, and spend this cycle against the environment's budget and spend limit. **Create** an environment (name, an optional web endpoint suffix and optional caps), **edit** its name, suffix and caps, or **delete** it. The Metrics tab charts the environment's cost per day by resource type.
- **Apps**: deployed, ephemeral and recently stopped apps across every environment, with their state, running containers, version and who deployed them. Each app's page lists its functions and servers with their GPUs and schedules, its tags, and its deployment history, and the Metrics tab charts its cost per day by resource type. **Stop app** terminates a running app after a confirmation; a stopped app cannot be restarted, only deployed again, so the action is blocked during a [change freeze](../team-and-billing/change-freeze.md).
- **Functions**: every function, class and server of a deployed app. The list shows each one's GPU (with any fallback GPUs) and schedule; the page adds CPU, memory and disk, input concurrency, autoscaling (min, max and buffer containers, scale-up and scale-down windows), timeouts, the web endpoint URL, and live **queued inputs**, **running inputs** and **containers**. The Metrics tab charts successful, failed and timed-out inputs, **cold starts** (containers started), container errors, execution time and end-to-end latency percentiles, and container CPU, memory and GPU utilization.
- **Scheduled functions**: the functions that run on a cron or fixed period, with their schedule and app, and the same charts as any function.
- **Volumes**, **secrets**, **dicts** and **queues**: listed per environment with who created them and when. Secrets show their key names and when they were last used; values are never read. Queues show their partitions and how many items are waiting. Each can be deleted from its page.

Resources, scaling and schedules are defined in your app's code and change on the next `modal deploy`, so functions are read-only here.

## Credentials

Two fields, the halves of a Modal API token:

- **Token ID**, starting `ak-`.
- **Token secret**, starting `as-`. Modal shows it once, when the token is created.

Create a token under **Settings → API Tokens** in the Modal dashboard, or run `modal token new` and copy `token_id` and `token_secret` from `~/.modal.toml`. A token belongs to one workspace and sees every environment in it.

<insert [Modal Add-account form with the Token ID and Token secret fields filled] here>

## Cost graphs

Modal accounts feed [cost graphs & budgets](../features/cloud-costs.md) from Modal's billing report, the data behind `modal billing report`:

- **Daily, per object, per resource type.** Each row is one day of one Modal object (an app, a sandbox, a volume…) for one resource: `CPU`, `Memory`, or a specific GPU type. The resource is the **service**, the object id is the **resource**, and every row carries the tags `environment`, `object` (the app's name), `objectType` (App, Sandbox, Volume…) and every tag you have put on the app. Group by service to see spend by GPU type, by resource to see it by app, or by a tag such as `team` that you set on your deployments.
- **Credits and adjustments.** The report is metered cost, before credits. Each billing cycle's adjustments (credits, plan allowance, reservations, the egress allowance) are recorded as their own rows on the first of the month with a charge type, so a month adds up to what Modal invoices. Switch the [cost basis or charge-type filter](../features/cloud-costs.md) to see usage alone.
- **History.** Up to a year is backfilled on the first sync, and the last 35 days are re-read on every collection, because billing data can arrive late and the current cycle's adjustments keep changing until it closes.

**Modal offers the billing report API on the Team and Enterprise plans.** On the Starter plan the account still lists everything above, and the cost collection notice says that spend is only visible in the Modal dashboard.

<insert [Cost graph grouped by service for a Modal account, showing H100 GPU, CPU and Memory stacked by day] here>

<insert [Modal workspace page showing metered and billed cost this cycle, the adjustments table and the rate card] here>

## Limits

Each environment's concurrency caps and spend limit feed the [quota radar](../features/quota-radar.md): running containers against **Max concurrent containers**, GPUs in use against **Max concurrent GPUs**, and spend this cycle against the environment's spend limit. Only caps that are set appear; Modal does not expose workspace-wide plan limits.

## Tips & limits

- **A cap cannot be removed through the API.** You can raise or lower an environment's concurrency caps here; to remove one entirely, use the Modal dashboard.
- **GPU hours are derived.** The billing report states GPU cost, not hours; the chart divides each GPU type's cost by the hourly rate on your workspace's rate card, and shows nothing for a GPU the rate card does not name.
- **Function charts are bucketed.** Each point summarizes one slice of the selected window, so a longer window means coarser points. Modal says the latency and utilization metric names may change; a metric Modal stops reporting simply disappears from the chart.
- **Provider status** follows [status.modal.com](https://status.modal.com); incidents are matched to the affected functions, apps, volumes, dicts, queues and secrets. See [Provider status](../features/provider-status.md).
