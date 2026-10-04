---
title: Anyscale
description: Track Anyscale spend by project, workload type, user and workload, follow credit balances, chart cluster node counts and utilization per cloud, find idle workspaces, and manage workspaces, jobs, services, projects, compute configs and budgets.
sidebar_order: 50
---

[Anyscale](https://www.anyscale.com) is the managed platform for Ray. The plugin connects to your Anyscale organization with one API key.

## What you can manage

- **Organization**: your role, the default cloud, Anyscale spend this month broken down by workload type, project and user, and every credit grant and prepaid commit with its balance, amount granted and validity. The Metrics tab charts daily spend by workload type.
- **Clouds**: each cloud's provider, region, compute stack (virtual machines or Kubernetes), state and hosting model: **Customer cloud** (your AWS account, Google Cloud project or Kubernetes cluster) or **Anyscale-hosted**. The dashboard card shows running clusters and node hours over the last 24 hours. The Metrics tab charts node count split into on-demand and spot, CPU and GPU count, CPU, memory, GPU and GPU memory utilization, and spot preemptions across every cluster in the cloud, for up to 90 days.
- **Projects**: name, cloud, owners and description. Create a project by picking its cloud from a list, or delete one. The Metrics tab charts the same utilization series as the cloud, filtered to the project. Anyscale has no API to rename a project or change its description.
- **Workspaces**: state, project, compute config, Ray version, who created it and when it last started, plus what Anyscale reports about its activity (a Ray workload, a running command, the editor in use, or idle) and its idle-termination timeout. **Start** and **Terminate** ask for confirmation first. The page shows the workspace's Anyscale spend over the last 30 days. Workspaces can also be put on [sleep/wake schedules](../features/sleep-schedules.md).
- **Jobs**: batch jobs with their state, goal state, last run, entrypoint, image, compute config, retries, timeout, and the schedule or job queue that launched them. **Terminate** stops a running job after confirmation. The page shows the job's spend over the last 30 days.
- **Services**: Ray Serve deployments with their state, endpoint and rollout progress: the primary and canary versions and the share of traffic each is getting. **Roll back** (during a rollout) and **Terminate** both ask for confirmation. The page shows the service's spend over the last 30 days.
- **Compute configs**: the latest version of each named config, with its head node, worker node groups and their autoscaling bounds, spot usage, idle termination and maximum uptime. Deleting a compute config archives it in Anyscale: it can no longer launch clusters, and clusters already using it keep running.
- **Budgets**: Anyscale's own daily or monthly spend alerts. Create one by choosing what it applies to (the whole organization, a cloud, or a project) from a list, an amount in US dollars or Anyscale credits, and a period. Edit the amount, unit and period afterwards, **Enable** or **Disable** it, or delete it. Anyscale does not let a budget's scope change; create a new one instead.

<insert [Anyscale organization page showing month-to-date spend, the by-workload-type, by-project and by-user tables, and the credit grants table] here>

## Credentials

One field: an **API key**.

- A **service account key** is the best choice: it does not expire. In the Anyscale console, open **Organization settings → Service accounts**, create a service account, then create an API key for it. See [Anyscale service accounts](https://docs.anyscale.com/auth/service-accounts).
- A **user key** works too (**API keys** under your user menu), but it expires after the organization's maximum lifetime, 30 days by default, and the account stops syncing until you paste a new one.

<insert [Anyscale Add-account form with the API key field filled] here>

### Permissions

Spend, credits and budgets are visible to **organization owners only**. Give the service account the **Owner** role to collect cost. With a non-owner key, clouds, projects and workloads still list; cost collection reports that it needs an owner, the credit balance explains the same, and budgets list empty.

## Cost graphs

Anyscale accounts feed [cost graphs & budgets](../features/cloud-costs.md) from the data behind Anyscale's usage dashboard, per cluster per day:

- **Service** is the workload type: Workspace, Job, Service, or Cluster for anything else.
- **Region** is the region of the cloud the cluster ran in.
- **Resource** is the workspace, job or service, so you can see the cost of one workload.
- **Tags**: `project`, `user`, `cloud`, `workload` (the workload's name), `jobQueue`, `clusterType`, and `hosting` (`customer-cloud` or `anyscale-hosted`).
- The amount is Anyscale's estimate in US dollars at your contracted rate; the Anyscale credits behind it are recorded as the usage quantity.

Up to a year is backfilled on the first sync, and the last five days are re-read on every collection while Anyscale's estimate settles.

### What is and is not included

Only Anyscale's own charges are recorded, so connecting Anyscale alongside your AWS, Google Cloud or Azure accounts never counts the same machine twice:

- On a **customer cloud** the machines run in your own account and your cloud provider bills them. They already appear under that provider's account in Infrawrench. Anyscale's figure for these clusters is its platform fee only; Anyscale's [price list](https://www.anyscale.com/pricing-detail) states that it does not include your cloud compute costs.
- On an **Anyscale-hosted** cloud there is no other bill: Anyscale's charge covers the compute, and this is the only place it appears.

Filter or group by the `hosting` tag to see the two apart.

<insert [Cost graph for an Anyscale account grouped by service, showing Workspace, Job and Service spend stacked by day] here>

## Credits

The [credit balance](../features/credit-burndown.md) tracks each credit grant and prepaid commit that is in use separately, with its expiry date, so a trial grant that lapses next month and a contract commit running to year end each get their own runway. An organization that pays as it goes has no balance to show.

## Idle workspaces

A workspace that is running while Anyscale reports it idle (no Ray workload, no running command, no editor activity) is listed on [Potential savings](../features/orphan-finder.md) and by `infrawrench orphans`. Terminate it from its page, or lower its idle-termination timeout in its compute config.

## Tips & limits

- **Jobs list the most recent 1,000** unarchived batch jobs. Archived jobs are not shown.
- **Utilization charts are per cloud.** Anyscale reports utilization for a whole cloud, optionally narrowed to one project; there is no per-workspace or per-job series. Each workload's page shows its spend instead.
- **Spend breakdowns are estimates.** Anyscale's usage dashboard is an estimate that can differ slightly from the invoice.
