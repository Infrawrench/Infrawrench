---
title: CircleCI
description: Track estimated CircleCI spend by project, resource class and executor, and manage projects, workflows, pipelines, contexts, variables, schedules, triggers and self-hosted runners.
sidebar_order: 51
---

## What you can manage

- **Organization**: credits used, estimated cost, workflow runs and success rate over the last 30 days, and a table of projects ranked by credits.
- **Projects**: repository, default branch, credits, estimated cost, runs, success rate and total build time over the last 30 days, every workflow with its success rate, p50 and p95 duration, credits and time to recover, and the project's flaky tests. The Metrics tab charts credits, job runs and failed job runs per day.
- **Workflows** (under their project): runs, success rate, failed runs, p50 and p95 duration, credits, mean time to recovery and runs per day over the last 30 days across all branches, a table of the workflow's jobs, and the 20 most recent runs with **Rerun** and **Rerun failed** buttons. The Metrics tab charts duration p50 and p95, success rate, credits and runs per day (per hour for windows up to two days).
- **Pipelines**: the 50 most recent pipelines in the organization, with project, branch or tag, commit, trigger and who started it. A pipeline's page lists its workflows with **Rerun**, **Rerun failed** and **Cancel**, and each workflow's jobs, with **Approve** on a job waiting for approval. **Create** a pipeline to trigger one: pick the project (or start from the project's page), a branch or tag, and optional pipeline parameters as JSON.
- **Contexts**: the variable names in each context (never the values: CircleCI does not return them) and its restrictions. **Create** or delete a context.
- **Context variables**: **Create** one with a value, replace the value with **Edit**, or delete it.
- **Project variables**: the masked value CircleCI shows (the last four characters). **Create**, replace the value with **Edit**, or delete.
- **Schedules** (GitHub OAuth and Bitbucket projects): when the pipeline runs (times per hour, hours of the day in UTC, days of the week or month, months), the branch and parameters, and who it runs as. **Create**, **Edit** or delete.
- **Triggers** (GitHub App and CircleCI projects): each trigger on the project's pipeline definitions, whether it is a repository event, a webhook or a cron schedule, and the refs it checks out. **Enable** or **Disable** it, **Edit** its cron schedule and refs, delete it, or **Create** a scheduled trigger.
- **Runner resource classes**: how many self-hosted runners are connected and how many tasks are waiting for one or running. **Create** a resource class, **Edit** its description, use **Get credentials** to mint a runner token for installing another runner, or delete the class (which also revokes its tokens).
- **Runners**: each connected runner agent with its version, whether it is running a job, and when it first and last connected.

## Credentials

1. In CircleCI, open **User Settings**, then **Personal API Tokens**, and create a token. It acts as your user, so it sees the organizations and projects you can. Cost reporting needs a user who can see the organization's plan usage, normally an organization admin. Project API tokens do not work.
2. In Infrawrench, paste the token. The **Organization** picker then lists every organization your user belongs to; pick one.

<insert [CircleCI Add-account form with the personal API token filled in and the Organization picker open on the list of organizations] here>

The remaining two fields set how credits become money (see below). You can change them at any time with **Edit credentials** on the account. Personal tokens can expire; CircleCI emails you beforehand, and **Edit credentials** takes the new one.

## Cost graphs

CircleCI accounts feed [cost graphs & budgets](../features/cloud-costs.md) with daily costs from CircleCI's Usage API, by kind of credit, each row tagged with the **project**, **resource class** and **executor** that used it:

| Service               | What it is                                |
| --------------------- | ----------------------------------------- |
| Compute               | Credits for job run time                  |
| Docker Layer Caching  | Credits for jobs that used DLC            |
| Storage               | Credits for workspaces, caches, artifacts |
| Network               | Credits for network egress                |
| IP Ranges             | Credits for jobs using IP ranges          |
| Leases, Lease Overage | Lease credits and lease overage credits   |
| Users                 | Credits for active user seats             |
| Other                 | Any credit kind CircleCI adds later       |

- **These amounts are estimates.** CircleCI reports credits, not money, so Infrawrench multiplies them by the **Price per Credit** on the account: $0.0006 by default, the published price of $15 for 25,000 credits. Enter your contract rate if it differs.
- On the Free plan, set **Credits Included per Month** to 30,000: credits are then priced at zero until the month's usage passes the allowance, so a month's rows add up to what it would cost beyond the free credits. Months are calendar months, which may not line up with your billing cycle.
- Each month of history is one usage export, which CircleCI runs in the background and limits to about ten an hour per organization. The first collection therefore reaches back six months, and later collections re-read the last five weeks each day. An export can take a few minutes, so new accounts show cost a little after they are added.
- Group or filter the cost views by the `project`, `resource_class` and `executor` tags to see which projects, machine sizes or executors use the most credits.

## Tips & limits

- Workflow and project figures come from CircleCI Insights, which CircleCI refreshes daily and keeps for 90 days. It is a guide to trends rather than a billing record; the cost graphs use the Usage API.
- Queue time is not in any CircleCI API response; for self-hosted runners, **Tasks waiting** on the resource class is the queue.
- CircleCI's API has no plan, credit balance or remaining-credit endpoint, so CircleCI accounts do not appear in [credit burndown](../features/credit-burndown.md). Check the plan's balance in CircleCI under **Plan Usage**.
- Resource classes are set in each project's `.circleci/config.yml`, which Infrawrench does not edit, so CircleCI jobs are not part of [right-sizing](../features/right-sizing.md).
- GitHub App and CircleCI projects have opaque slugs. Infrawrench learns them from the organization's recent pipelines, so a project that has never run a pipeline may not open until it does.
- Bastion egress for CircleCI accounts allows `circleci.com`, `runner.circleci.com` and Amazon S3 (where usage export files are downloaded from).
