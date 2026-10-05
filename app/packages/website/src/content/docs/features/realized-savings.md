---
title: Realized savings
description: See what your optimization work actually saved, measured against each resource's own spend before the action, beside what it was projected to save.
sidebar_order: 15
---

Every savings finder in Infrawrench tells you what an action _would_ save: [orphans](./orphan-finder.md), [right-sizing](./right-sizing.md), [sleep schedules](./sleep-schedules.md) and the [commitments planner](./commitments.md). Realized savings is the other half: what the actions you took _did_ save, measured from billing. A projection is a promise; a realized figure is the receipt you show finance.

Realized savings is a cloud feature. It lives at the bottom of the **Costs** panel on web and desktop (signed in to a cloud org), as a dashboard card, in the weekly digest, in the CLI and over MCP, and read-only on mobile.

<insert [Costs panel scrolled to the Realized savings section: the realized vs projected tiles, the bar breakdown by month, and the list of actions with one flagged as falling short] here>

## What gets recorded

Infrawrench records a saving at the moment the action happens, and also catches the same actions taken outside Infrawrench:

| Action              | Recorded when                                                                                                                                                                                           | Projected saving                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Right-sizing**    | A machine of a right-sizing type is resized to a smaller size, by the Oversized section's **Apply** button or any edit in Infrawrench, or a smaller size is **detected on sync** after a console resize | The difference between the old and new size in the provider's live size catalogue                              |
| **Orphan cleanup**  | A resource the orphan finder flags is deleted, in Infrawrench (including through the AI chat or MCP) or **detected on sync** after a console delete                                                     | Its trailing 30 days of billed spend, or the list-price estimate when the provider has no per-resource billing |
| **Sleep schedule**  | A [sleep schedule](./sleep-schedules.md) is created or resumed. Pausing or deleting it ends the stretch; changing its hours starts a new one                                                            | Hours off times the resource's rate                                                                            |
| **Commitments**     | Derived from billing: the on-demand value a reservation or savings plan offset, less its amortized fee                                                                                                  | None on record                                                                                                 |
| **Logged manually** | Someone logs it (see below)                                                                                                                                                                             | The monthly amount entered                                                                                     |

A resize to a _larger_ size, or the deletion of a resource that was in use, is not a saving and is not recorded. An action taken in Infrawrench and then seen again on the next sync is recorded once.

Each recorded action also leaves a note on your cost charts at the day it happened (an org-wide [cost annotation](./cloud-costs.md)), so a dip in a cost graph is labelled with what caused it. Removing the saving removes its note.

## How a saving is measured

- **Baseline.** The resource's average daily spend over the days before the action (14 by default), read from your cost data by provider resource id. When the provider does not bill per resource, Infrawrench falls back to the list-price estimate that backed the projection and labels the figure **Estimated from list prices**.
- **Realized.** For each day after the action, the baseline minus what the resource actually cost that day, added up. Days your billing has not been collected for yet are not counted at all, so a fresh action reads **Waiting for billing** rather than "saved nothing".
- **Horizon.** A one-off action (a resize, a deletion, a manual entry) keeps counting for 12 months by default, after which it reads **Horizon reached**. A sleep schedule counts for as long as it runs.
- **Shortfall.** An action is flagged when its recent realized rate drops under 70% of the projected rate, or when the resource's spend climbs back above its baseline (**grew back**: someone resized it up again, or traffic grew into the space).

The figures are recomputed every time you look, so they improve as late and restated billing lands. Everything is shown per currency and never converted or merged. Providers that bill whole invoice periods (rather than per day) cannot be measured day by day, so their savings use the estimate.

Commitment savings count only days where the provider writes a separate discount line (AWS Savings Plans write one). A reservation whose discount is built into the hourly rate, such as an AWS Reserved Instance, writes no such line and is not counted, rather than being shown as its fee alone.

## Breaking it down

The section shows realized against projected per currency, then a breakdown you can switch between:

- **Month**: when the savings landed.
- **Action type**: right-sizing, orphan cleanup, sleep schedules, commitments, logged.
- **Cost centre**: the team each saving belongs to, from your [cost allocation rules](./tag-policy-and-showback.md) (account, provider and tag rules apply; service rules do not, because an action is about a resource rather than a service line). You can override the cost centre per saving.
- **Account**.

Below the breakdown, every action is listed with its projected monthly saving, what it realized in the period, how it was measured, and its status.

## Logging and editing savings

Choose **Log a saving** for anything Infrawrench could not see happen: a renegotiated contract, a cancelled vendor, a workload you migrated. Give it a title, the monthly amount, the currency and the day it began, and optionally:

- a **resource**, picked by name: the realized figure is then measured from that resource's billing instead of the amount you entered,
- a **cost centre**,
- an **end date** and a **horizon** different from the org default,
- a **note**.

Manual entries can be edited in full. Automatic ones keep what was observed (what was done, when, and the projection), but you can add a note, attribute them to a cost centre, change how long they count, or end them. Either kind can be removed if it was not really a saving.

Logging, editing and removing need `costs:write`; seeing the report needs `costs:read`.

<insert [The Log a saving modal filled in with a title, monthly amount, start date and a linked resource] here>

## Settings

**Settings** in the section (needs `costs:write`) tunes how savings are measured for the whole org:

| Setting                | Default | Range     |
| ---------------------- | ------- | --------- |
| Horizon (months)       | 12      | 1 to 36   |
| Shortfall threshold    | 70%     | 10 to 100 |
| Baseline window (days) | 14      | 3 to 30   |

Changing a setting changes every figure in the report, including past ones. The settings can also be managed with the [Terraform provider](./terraform-provider.md) as `infrawrench_realized_savings_settings`.

## Dashboard card

On a dashboard, **+** then **Realized savings** adds a card with the headline figure and one breakdown (month, action type, cost centre or account) over a number of months you choose. It is included in [dashboard PDFs and scheduled deliveries](./dashboard.md). Mobile shows the card read-only.

## Weekly digest

The [weekly digest](./weekly-digest.md) carries a **Realized savings** line: what was realized last week and so far this year, beside the projection, and how many actions are falling short. The line is left out until something has been realized.

## CLI

```bash
infrawrench savings                         # last 12 months, by month
infrawrench savings --group-by kind         # or cost-centre, account
infrawrench savings --from 2026-01-01 --json
infrawrench savings log "Cancelled the legacy CDN" --amount 420 --currency USD --from 2026-09-01
```

`--json` prints the report exactly as the API returns it. See [CLI](./cli.md).

## AI chat and MCP

`get_realized_savings` returns the report (with an optional date range), and `log_saving` records a manual saving. See [MCP](./mcp.md).

## API

`GET /api/org/{orgId}/savings/realized`, `POST|PUT|PATCH|DELETE /api/org/{orgId}/savings/events`, and `GET|PUT /api/org/{orgId}/savings/settings`. See the [API reference](../team-and-billing/openapi.md).
