---
title: CircleCI
description: Track estimated CircleCI spend by project, resource class and executor, and manage projects, workflows, pipelines, contexts, variables, schedules, triggers and self-hosted runners.
sidebar_order: 51
---

Connect a CircleCI organization to see where your credits go and to manage its pipelines, contexts, variables, schedules and runners.

## What you can manage

- **Organization**: credits used, estimated cost, workflow runs and success rate over the last 30 days, and a table of projects ranked by credits.
- **Projects**: repository, default branch, credits, estimated cost, runs, success rate and total build time over the last 30 days. You also see every workflow with its success rate, p50 and p95 duration, credits and time to recover, and the project's flaky tests. The Metrics tab charts credits, job runs and failed job runs per day.
- **Workflows** (under their project): runs, success rate, failed runs, p50 and p95 duration, credits, mean time to recovery and runs per day over the last 30 days across all branches. There's a table of the workflow's jobs and the 20 most recent runs, with **Rerun** and **Rerun failed** buttons. The Metrics tab charts duration p50 and p95, success rate, credits and runs per day (per hour for windows up to two days).
- **Pipelines**: the 50 most recent pipelines in the organization, with project, branch or tag, commit, trigger and who started it. A pipeline's page lists its workflows with **Rerun**, **Rerun failed** and **Cancel**, and each workflow's jobs, with **Approve** on a job waiting for approval. To trigger a pipeline, click **Create**, then pick the project (or start from the project's page), a branch or tag, and optional pipeline parameters as JSON.
- **Contexts**: the variable names in each context and its restrictions. Values are never shown because CircleCI doesn't return them. **Create** or delete a context.
- **Context variables**: **Create** one with a value, replace the value with **Edit**, or delete it.
- **Project variables**: the masked value CircleCI shows (the last four characters). **Create**, replace the value with **Edit**, or delete.
- **Schedules** (GitHub OAuth and Bitbucket projects): when the pipeline runs (times per hour, hours of the day in UTC, days of the week or month, months), the branch and parameters, and who it runs as. **Create**, **Edit** or delete.
- **Triggers** (GitHub App and CircleCI projects): each trigger on the project's pipeline definitions, whether it's a repository event, a webhook or a cron schedule, and the refs it checks out. **Enable** or **Disable** it, **Edit** its cron schedule and refs, delete it, or **Create** a scheduled trigger.
- **Runner resource classes**: how many self-hosted runners are connected and how many tasks are waiting or running. **Create** a resource class, **Edit** its description, use **Get credentials** to create a runner token for installing another runner, or delete the class (which also revokes its tokens).
- **Runners**: each connected runner agent with its version, whether it's running a job, and when it first and last connected.

## Connect with CircleCI

In the desktop app, for accounts stored on your computer, **Connect with CircleCI** signs you in through your browser so you don't have to create a token by hand.

1. Click **Connect with CircleCI**.
2. On the consent screen, pick **Write** access. Read is enough to browse, but you need Write to edit projects, contexts, variables, schedules and runners.
3. Authorize each SSO organization you want to manage.

The access you pick is a ceiling: it never goes beyond your own CircleCI role. CircleCI then issues a personal API token for Infrawrench, just like one you'd create yourself. If you belong to a single organization it's picked for you, and the account is named after your CircleCI user.

The token lasts 90 days and can't be refreshed. When it expires, open **Edit credentials** and click **Reconnect** to sign in again (this also revokes the old token). You can delete the token any time in CircleCI under **User Settings > Personal API Tokens**.

The web app and the desktop app's cloud mode can't use this sign-in, so use a token there, as below.

<insert [CircleCI add-account form in the desktop app showing the Connect with CircleCI button above the Personal API Token field] here>

## Connect with a token

1. In CircleCI, open **User Settings > Personal API Tokens** and create a token. It acts as your user, so it sees the organizations and projects you can. Cost reporting needs a user who can see the organization's plan usage, normally an organization admin. Project API tokens don't work.
2. In Infrawrench, paste the token. The **Organization** picker lists every organization you belong to. Pick one.

<insert [CircleCI Add-account form with the personal API token filled in and the Organization picker open on the list of organizations] here>

The other two fields set how credits turn into money (see below). You can change them any time with **Edit credentials** on the account. Personal tokens can expire. CircleCI emails you beforehand, and you can paste the new one in **Edit credentials**.

## Cost graphs

CircleCI accounts feed [cost graphs & budgets](../features/cloud-costs.md) with daily costs by kind of credit. Each row is tagged with the **project**, **resource class** and **executor** that used it:

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

- **These amounts are estimates.** CircleCI reports credits, not money, so Infrawrench multiplies them by the account's **Price per Credit**. The default is $0.0006, the published price of $15 for 25,000 credits. Enter your contract rate if it differs.
- **On the Free plan**, set **Credits Included per Month** to 30,000. Credits are then priced at zero until the month's usage passes the allowance, so a month's total is what it would cost beyond the free credits. Months are calendar months, which may not line up with your billing cycle.
- **History**: you get six months of history after you connect, and the last five weeks are refreshed each day. CircleCI prepares usage data slowly, so a new account's costs can take a few minutes to appear.
- Group or filter the cost views by the `project`, `resource_class` and `executor` tags to see which projects, machine sizes or executors use the most credits.

## Tips & limits

- Workflow and project figures come from CircleCI Insights, which CircleCI refreshes daily and keeps for 90 days. Use them for trends, not billing. The cost graphs use CircleCI's usage data instead.
- CircleCI doesn't report queue time. For self-hosted runners, **Tasks waiting** on the resource class is the queue.
- CircleCI doesn't expose your plan or credit balance, so CircleCI accounts don't appear in [credit burndown](../features/credit-burndown.md). Check your balance in CircleCI under **Plan Usage**.
- Resource classes are set in each project's `.circleci/config.yml`, which Infrawrench doesn't edit, so CircleCI jobs aren't part of [right-sizing](../features/right-sizing.md).
- A GitHub App or CircleCI project that has never run a pipeline may not open until it does.
- Bastion egress for CircleCI accounts allows `circleci.com`, `runner.circleci.com` and Amazon S3 (where usage export files are downloaded from).
