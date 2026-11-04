---
title: Delivery (DORA metrics)
description: Deployment frequency, lead time for changes, change failure rate and time to restore for production, measured from the deploys and incidents Infrawrench already sees, with performance bands, trends, a breakdown by environment, repository, owner or service, and the changes behind every number.
sidebar_order: 13
---

The four DORA metrics are the standard way to measure how well a team ships software: **how often** it deploys to production, **how long** a commit takes to get there, **how often** a change breaks something, and **how fast** it recovers. Most teams never measure them because the data is spread across a CI system, a hosting provider and an incident tool. Infrawrench already sees all three, so the **Delivery** page shows them with nothing new to install.

<insert [The Delivery tab: four metric tiles (Deployment frequency 3.4/day Elite, Lead time 6.5h Elite, Change failure rate 8.3% High, Time to restore 45m Elite) each with "Better than the previous period", above the three trend charts] here>

Open **Delivery** from the sidebar on the web or desktop app (cloud mode), or run [`infrawrench dora`](./cli.md). The mobile app has a read-only Delivery screen under Resources.

## Where the numbers come from

**Deploys** are collected from every source Infrawrench can see, without counting anything twice:

- **Infrawrench deploys**: every [Infrafile](./infrafile.md) run, from the web app, the CLI or deploy-on-push.
- **Provider deploys your accounts already sync**: Vercel deployments, Netlify deploys, Render deploys, Railway deployments, Koyeb deployments, Heroku releases that deploy code, Pulumi Deployments `update` operations, Spacelift tracked runs and HCP Terraform runs that applied. Deploys are kept for a year, so you build up a history even with providers that only list their last few deploys.
- **CI pipelines named as deploys**: Buildkite builds, CircleCI pipelines, GitLab pipelines and Bitbucket Pipelines runs count only when the pipeline's name matches one of your **deploy pipeline** patterns (by default `*deploy*` and `*release*`). A CI provider can't tell a deploy pipeline from a test pipeline, so you tell Infrawrench.
- **GitHub deployments**: through the [GitHub App](./workflows.md), deployments any tool created on your most recently pushed repositories, with their latest status. Deployments Infrawrench created itself are skipped, since they're already counted as Infrafile runs.
- **Anything else**: a deploy step in any CI can record itself with one API call (see below).

**Lead time** needs the time the deployed commit was written. Render reports it. For everything else that names a commit and a GitHub repository, Infrawrench looks it up through the GitHub App. Deploys with no known commit time are left out of the median, not counted as instant.

**Failures** come from two places:

- A [declared incident](./incident-mode.md) that starts within the **failure window** (24 hours by default) after a production change. Each incident is blamed on **one** change: the most recent production change in the window that touched one of the incident's affected resources or accounts, or the most recent change of all if the incident names none. One outage never counts against every deploy before it.
- A **rollback**: a deploy the provider flags as one (Render, Railway, Koyeb and Heroku do), or a deploy that re-ships a commit that was already shipped before the previous deploy on the same project and environment, whichever tool ran it. The deploy that was rolled back counts as failed.

**Time to restore** is the median time from an incident being declared to it being resolved, and from a bad deploy to the rollback that replaced it.

## What counts as production

Only production counts. An environment is production when its name matches one of the **production environment** patterns (by default `production`, `prod`, `prd`, `live` and `main`). `*` matches anything, so `prod*` covers `prod-eu`. Providers with no environments of their own (Render, Koyeb, Heroku services) count as production. Pulumi stacks, Spacelift stacks and HCP Terraform workspaces are matched by name.

## Performance bands

Each metric gets the standard performance band:

| Band   | Deployment frequency   | Lead time       | Change failure rate | Time to restore |
| ------ | ---------------------- | --------------- | ------------------- | --------------- |
| Elite  | at least once a day    | under a day     | at most 5%          | under an hour   |
| High   | at least once a week   | under a week    | at most 10%         | under a day     |
| Medium | at least once a month  | under a month   | at most 15%         | under a week    |
| Low    | less than once a month | a month or more | over 15%            | a week or more  |

The tiles compare against the period of the same length just before. The charts show the trend per day (or per week for ranges over 45 days).

## Break it down

The **Breakdown** table splits the four numbers by:

- **environment**
- **repository**
- **owner**: the [resource owner](../core-concepts/resource-ownership.md) of the project or service a deploy went to
- **service**: the [service](./services.md) whose resources the deploy or change touched

Click a row, or use the **Scope** picker, to see just that one. "Not known" collects deploys with no repository, owner or service recorded, which is usually where untracked services hide. A resource that belongs to several services counts toward the most critical one (the lowest tier number, then by name), so every change is counted once. Infrafile runs and deploys recorded through the API without a resource aren't placed in a service.

<insert [The Delivery tab's Breakdown table grouped by repository, three repositories with their deploys, frequency, lead time, failure rate and restore time, and below it the Changes list filtered to failed changes, one row showing "Incident: Checkout 500s" in red] here>

Below the breakdown, **Changes** lists every production change behind the numbers, newest first, with its commit, lead time and, for a failed one, what it was blamed on. **Recoveries** lists the incidents resolved and deploys rolled back.

## Settings

Open **Settings** on the Delivery tab. Editing needs permission to change organization settings.

- **Production environments**: the patterns described above.
- **Deploy pipelines**: CI pipeline names whose runs count as deploys.
- **Failure window**: how soon after a change an incident or rollback counts against it, from 1 to 720 hours.
- **Count a production deploy that itself failed** as a failed change. Off by default, since a deploy that never went live didn't change production.
- **Count resource changes**: also count changes the [change timeline](./change-timeline.md) saw (console edits, drift). One you reverted from the timeline counts as failed. Off by default, because most of that feed is providers restating values.
- **Weekly digest**: the Delivery line in the [weekly digest](./weekly-digest.md).

You can also manage these settings with the `infrawrench_dora_settings` resource in the [Terraform provider](./terraform-provider.md).

## Record a deploy from any CI

For a deploy tool no integration covers, add one call to the last step of your pipeline, using an [API key](../team-and-billing/api-keys.md) with `deployments:write`. Sending the same `externalId` again updates the deploy, so a retried step is harmless:

```
curl -X POST "https://app.infrawrench.com/api/org/$ORG_ID/dora/deployments" \
  -H "Authorization: Bearer $INFRAWRENCH_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"externalId":"build-1234","name":"checkout","environment":"production",
       "repository":"acme/checkout","commitSha":"'"$GIT_SHA"'",
       "deployedAt":"2026-10-12T14:03:00Z","status":"success"}'
```

## Permissions

- Viewing the metrics needs `deployments:read` (Members have it).
- Changing the settings needs `org:settings:write`.
- Recording a deploy over the API needs `deployments:write`.
