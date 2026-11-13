---
title: Depot
description: Estimate Depot spend by project and product (container builds, GitHub Actions runners, cache and registry storage, agent sandboxes), track plan allowances, chart build minutes and cache hit rate, and manage projects, project tokens, OIDC trust relationships and registry images.
sidebar_order: 50
---

[Depot](https://depot.dev) runs remote container builds and GitHub Actions runners. Connect it with an organization token to see what your builds cost and change projects without opening the Depot dashboard.

## What you can manage

- **Projects**: name, region (`us-east-1` or `eu-central-1`), builder size, and the layer cache policy (size limit in GB and retention in days), plus builds, build minutes and cache used over the last 30 days. Create, edit and delete projects. **Reset cache** terminates the project's builders and deletes its cache. It asks for confirmation first, and the next builds start cold. The Metrics tab charts build minutes, builds, cache hit rate, minutes saved by the cache and failed builds per day.
- **Builds**: the 25 most recent builds of each project, with status, timings, duration, cached steps and cache hit rate. Builds come from `depot build`, so they're read-only here.
- **Project tokens**: tokens scoped to one project, for CI systems that can't use OIDC. Create one by picking the project and a description. The secret is shown **once**, in the new token's outputs. Rename a token by editing its description, or delete it to revoke it. Depot never shows the secret again.
- **Trust relationships**: OIDC trust relationships that let a GitHub repository, CircleCI project, Buildkite pipeline or GitLab project build in a project without a stored token. Add one by picking the CI provider and filling in its fields, or remove one. Depot doesn't support editing them, so remove and add instead.
- **Registry images**: image tags saved to each project's Depot registry by `depot build --save`, with digest, size and push time. Delete a tag to free storage.
- **GitHub Actions repositories**: every repository whose jobs ran on Depot runners this billing cycle, with jobs, elapsed and billed minutes, and a table by workflow and runner label. The Metrics tab charts billed minutes, elapsed minutes and jobs per day.

Each project exports `DEPOT_PROJECT_ID`, and a newly created project token exports `DEPOT_TOKEN`, through [secret export](../core-concepts/output-references.md).

## Connect your account

- **Organization token**: in Depot, open **Organization Settings** and create one under **API Tokens**. Project tokens and user tokens can't read usage, so cost data needs an organization token.
- **Depot plan**: Depot doesn't report which plan you're on or what it costs, so pick it: **Developer**, **Startup**, **Business** (custom contract) or **Usage only** (every minute at list price). The plan's monthly fee and its included build minutes, GitHub Actions minutes and storage shape the cost estimate and the plan allowance readings.
- **Rate overrides** (optional): replace any published rate or allowance, one `key=value` per line. Use it for a Business contract or a price change.

| Key                      | Meaning                                                          | Default       |
| ------------------------ | ---------------------------------------------------------------- | ------------- |
| `planFee`                | Monthly plan fee, USD                                            | From the plan |
| `includedBuildMinutes`   | Docker build minutes included per cycle                          | From the plan |
| `includedActionsMinutes` | GitHub Actions minutes included per cycle                        | From the plan |
| `includedStorageGb`      | Cache and registry storage included                              | From the plan |
| `includedSandboxMinutes` | Sandbox minutes included per cycle, at 2 vCPUs, used by Depot CI | From the plan |
| `buildMinute`            | USD per container build minute beyond the allowance              | 0.04          |
| `actionsMinute`          | USD per billed GitHub Actions minute beyond the allowance        | 0.006         |
| `macosMinute`            | USD per macOS runner minute                                      | 0.08          |
| `sandboxMinute`          | USD per agent sandbox minute                                     | 0.01          |
| `ciVcpuMinute`           | USD per Depot CI vCPU-minute beyond the allowance                | 0.003         |
| `storageGbMonth`         | USD per GB-month of storage beyond the allowance                 | 0.20          |
| `cycleStartDay`          | Day of the month your billing cycle starts (1 to 28)             | 1             |

You can change the plan or the overrides at any time from the account's **Edit credentials**. New values apply to the next cost update.

<insert [Depot Add-account form with the organization token filled, the plan picker open on Startup, and the rate overrides field showing two example lines] here>

## Costs

Depot spend appears in [cost graphs and budgets](../features/cloud-costs.md). The amounts are **estimates**: Depot reports usage but not prices, so Infrawrench multiplies your usage by your plan's rates. Each day is broken down by:

- **Service**: Container builds, GitHub Actions runners, GitHub Actions runners (macOS), Cache storage, Registry storage, Agent sandboxes, Depot CI, and Depot plan (the monthly fee spread across the days of the cycle).
- **Resource**: the project, for container build minutes.
- **Tags**: `project`, `repo`, `workflow`, `runner`, `storageType` and `agentType`, so you can filter or group runner spend by repository or workflow.

Included minutes are a pool per billing cycle. Build and runner minutes cost nothing beyond the plan fee until the cycle's allowance runs out, and the days after that are priced at the overage rate. Usage inside the allowance still appears with a zero amount, so you can see which projects and repositories use it up. Billed runner minutes already include Depot's runner-size multiplier (a 16-CPU runner bills 8 minutes per minute). macOS runners are priced at their flat per-minute rate and don't use the included pool. Storage is priced from the GB Depot reports each day, spread across the days of the month.

The estimate can't see discounts, credits, tax, or custom terms you haven't entered as overrides. Up to 90 days of history are collected.

## Plan allowances

If your plan includes minutes or storage, the [quota radar](../features/quota-radar.md) shows this cycle's included build minutes, GitHub Actions minutes and storage against what you've used.

## Status

Incidents from [status.depot.dev](https://status.depot.dev) appear on the account through [provider status](../features/provider-status.md). Incidents on a builder region are matched to the projects in that region.

## CI jobs

Depot isn't offered for [CI](../features/ci.md) cloud jobs. A Depot build is driven by a BuildKit client that stays connected for the whole build and reports its health every few minutes, and Depot removes the builder once it stops; Infrawrench starts a job and checks on it later, so nothing would keep the build alive.
