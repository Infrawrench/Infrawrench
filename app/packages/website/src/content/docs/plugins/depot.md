---
title: Depot
description: Estimate Depot spend by project and product (container builds, GitHub Actions runners, cache and registry storage, agent sandboxes), track plan allowances, chart build minutes and cache hit rate, and manage projects, project tokens, OIDC trust relationships and registry images.
sidebar_order: 50
---

[Depot](https://depot.dev) runs remote container builds and GitHub Actions runners. Infrawrench connects with an organization token and reads Depot's API, so you do not have to open the Depot dashboard to see what your builds cost or to change a project.

## What you can manage

- **Projects**: name, region (`us-east-1` or `eu-central-1`), builder size, and the layer cache policy (size limit in GB and retention in days), plus builds, build minutes and cache used over the last 30 days. Create, edit and delete projects. **Reset cache** terminates the project's builders and deletes its cache; it asks for confirmation first and the next builds start cold. The Metrics tab charts build minutes, builds, cache hit rate, minutes saved by the cache and failed builds per day.
- **Builds**: the 25 most recent builds of each project, with status, timings, duration, cached steps and cache hit rate. Builds are created by `depot build`, so they are read-only here.
- **Project tokens**: tokens scoped to one project, for CI systems that cannot use OIDC. Create one by picking the project and a description; the secret is shown **once**, in the new token's outputs. Rename a token by editing its description, or delete it to revoke it. Depot only returns token metadata, never the secret again.
- **Trust relationships**: OIDC trust relationships that let a GitHub repository, CircleCI project, Buildkite pipeline or GitLab project build in a project without a stored token. Add one by picking the CI provider and filling in its fields, or remove one. Depot does not support editing them; remove and add instead.
- **Registry images**: image tags saved to each project's Depot registry by `depot build --save`, with digest, size and push time. Delete a tag to free storage.
- **GitHub Actions repositories**: every repository whose jobs ran on Depot runners this billing cycle, with jobs, elapsed and billed minutes, and a table by workflow and runner label. The Metrics tab charts billed minutes, elapsed minutes and jobs per day.

Each project exports `DEPOT_PROJECT_ID`, and a newly created project token exports `DEPOT_TOKEN`, through [secret export](../core-concepts/output-references.md).

## Credentials

- **Organization token**: in Depot, open **Organization Settings** and create one under **API Tokens**. Project tokens and user tokens cannot read usage, so cost data needs an organization token.
- **Depot plan**: Depot's API reports usage but not which plan you are on or what it costs, so pick your plan: **Developer**, **Startup**, **Business** (custom contract) or **Usage only** (every minute at list price). The plan's monthly fee and its included build minutes, GitHub Actions minutes and storage shape the cost estimate and the plan allowance readings.
- **Rate overrides** (optional): replace any published rate or allowance, one `key=value` per line. Use it for a Business contract or a price change.

| Key                      | Meaning                                                   | Default       |
| ------------------------ | --------------------------------------------------------- | ------------- |
| `planFee`                | Monthly plan fee, USD                                     | From the plan |
| `includedBuildMinutes`   | Docker build minutes included per cycle                   | From the plan |
| `includedActionsMinutes` | GitHub Actions minutes included per cycle                 | From the plan |
| `includedStorageGb`      | Cache and registry storage included                       | From the plan |
| `buildMinute`            | USD per container build minute beyond the allowance       | 0.04          |
| `actionsMinute`          | USD per billed GitHub Actions minute beyond the allowance | 0.006         |
| `macosMinute`            | USD per macOS runner minute                               | 0.08          |
| `sandboxMinute`          | USD per agent sandbox minute                              | 0.01          |
| `storageGbMonth`         | USD per GB-month of storage beyond the allowance          | 0.20          |
| `cycleStartDay`          | Day of the month your billing cycle starts (1 to 28)      | 1             |

Change the plan or the overrides at any time from the account's **Edit credentials**; the next cost pass uses the new values.

<insert [Depot Add-account form with the organization token filled, the plan picker open on Startup, and the rate overrides field showing two example lines] here>

## Costs

Depot accounts feed [cost graphs and budgets](../features/cloud-costs.md). The amounts are **estimated**: Depot reports usage (build minutes per project, billed runner minutes per repository, workflow and runner, storage, sandbox minutes) but no prices, so Infrawrench multiplies usage by your plan's rates. Each day is broken down by:

- **Service**: Container builds, GitHub Actions runners, GitHub Actions runners (macOS), Cache storage, Registry storage, Agent sandboxes, and Depot plan (the monthly fee spread across the days of the cycle).
- **Resource**: the project, for container build minutes.
- **Tags**: `project`, `repo`, `workflow`, `runner`, `storageType` and `agentType`, so you can filter or group runner spend by repository or workflow.

Included minutes are a pool per billing cycle: build and runner minutes cost nothing beyond the plan fee until the cycle's allowance runs out, and the days after that are priced at the overage rate. Usage inside the allowance still appears, with a zero amount, so you can see which projects and repositories use it up. Billed runner minutes already include Depot's runner-size multiplier (a 16-CPU runner bills 8 minutes per minute). macOS runners are priced at their flat per-minute rate and kept out of the included pool.

What the estimate cannot see: discounts, credits, tax, and any custom terms not entered as overrides. Up to 90 days of history are collected.

## Plan allowances

With a plan that includes minutes or storage, the [quota radar](../features/quota-radar.md) shows this cycle's included build minutes, GitHub Actions minutes and storage against what you have used.

## Status

Incidents from [status.depot.dev](https://status.depot.dev) appear on the account through [provider status](../features/provider-status.md). Incidents on a builder region are matched to the projects in that region.

## Quirks

- Depot's usage endpoint returns totals for a time window with no daily breakdown, so each day of cost history is one request. The first collection reads up to 90 days plus the start of that billing cycle.
- Storage is priced from the GB Depot reports for each day, spread across the days of the month.
- Build history beyond the 25 most recent builds per project is used for the Metrics tab only, and is read page by page for the selected time range.
