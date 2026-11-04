---
title: Cost per change & cost per deploy
description: See what a change or a deployment did to your bill, as a daily run-rate difference measured from your provider spend before and after it, with a confidence level.
---

Every change in the [change timeline](./change-timeline.md) and every run in the
[deploy history](./infrafile.md) can answer one more question: **what did that cost?**

Infrawrench compares the affected resource's daily spend in a window **before** the change with
the window **after** it, and shows the difference as a **run-rate delta**: money per day, not a
total. That tells you what the resource now costs to run.

![The Changes page with cost-impact lines under several rows: one showing a large positive delta with high confidence, one showing a saving, and one row with no cost line at all](https://agent-assets.infrawrench.com/docs-screenshots/features/cost-per-change/changes-feed-cost-lines.png)

## Read the cost line

A cost-impact line looks like this:

```
+$42.37/day (+118%) · cash basis, 7d before/after · high confidence
```

- **The delta** is after minus before, per day. Positive means the change costs more.
- **The percentage** is relative to the "before" window. It's left out when nothing was spent
  before, for example on a newly created resource.
- **The basis** is which kind of spend was compared. See
  [Which numbers are compared](#which-numbers-are-compared).
- **The window** is how many days were compared on _each_ side.
- **The confidence** is how far you should trust the number.

Hover the window text to see the exact dates that were compared.

## Which numbers are compared

Both windows always use the same charge-type basis, and every figure names it:

- **Cash** (the default): what the provider charged on the day it charged it.
- **Amortized**: a commitment's up-front fee spread across the term it covers.
- **Blended**: amortized, with each commitment's discount shared evenly across all the usage it
  could cover.

They're never mixed, so a change in basis can't show up as a fake saving.

The same bases are available on [cost graphs](./cloud-costs.md) and
[cost reports](./cost-reports.md).

## Which days are compared

All windows are whole UTC days.

- **The day of the change isn't included** in either window, because it's billed partly under the
  old setup and partly under the new one.
- **Today is never included**, because it's still accruing.
- **Both windows are the same length.** If only three full days have passed since the change, the
  "before" window is shortened to three days too, so you're comparing like with like.

The default is 7 days on each side. You can set anything from 2 to 30 through the API.

## When you see "unknown"

"This change cost nothing" and "we can't tell what this change cost" are different answers.
Infrawrench shows **unknown** when it has no spend for a resource, never `$0.00/day`.

You'll see `unknown` when:

| Reason                              | What it means                                                                                                                                        |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| No provider id to match spend to    | The resource has no provider id, so no billing data can be matched to it. Waiting won't help.                                                        |
| No spend recorded for this resource | Costs were collected for the window, but this resource never appears in them. Security groups, IAM roles and similar resources simply aren't billed. |
| Provider bills by invoice period    | The provider records a whole invoice period on its first day, so a day-by-day comparison isn't possible.                                             |
| Cost collection had not started     | The "before" window is earlier than the first day this account has cost data for.                                                                    |
| Not enough days have passed         | The provider hasn't published billing for the days after the change yet. This fixes itself, so check back later.                                     |

A resource that really was billed on one side and not the other is a real measurement, not an
unknown: a deleted instance shows a saving, and a new one shows its full cost as an increase.

## How much to trust the number

The number shows that something changed and the bill moved. It doesn't prove the change caused it.

Confidence depends on how many comparable days each side had: seven or more is high, four or more
is medium, anything less is low. It drops one level when **other recorded changes touched the same
resource in the window**. When that happens, the line says `(contested)`, and hovering it shows how
many other changes there were.

For the cleanest read, look for a change with no overlapping changes and a full window.

## Deployments

A deploy usually touches more than one resource, so its cost impact is a **per-resource breakdown**
that adds up to the total.

![The Deploy tab's run history with one run expanded to show its per-resource cost breakdown and the total line above it](https://agent-assets.infrawrench.com/docs-screenshots/features/cost-per-change/deploy-run-breakdown.png)

About that total:

- It covers the resources the run **created** through `infra.accounts.*.create(...)` in your
  [Infrafile](./infrafile.md). A deploy that only re-shipped an image has no linked resources and
  says so.
- Resources whose impact couldn't be measured are **left out** of the total and counted
  separately, so the breakdown always adds up. The run's confidence is the lowest of its rows.

The windows are measured from when the run **started**, not when it finished.

## Pin a finding to your cost graphs

Press **Annotate cost graph** to add the finding as a [cost annotation](./cost-reports.md), so the
jump in spend is explained right on the chart. This needs the `costs:write` permission.

If you pin the same change or deploy again, it **updates the existing note** instead of adding a
second one. So it's safe to pin a finding early and pin it again a week later once billing has
settled. Your note's date and report scope are never changed, in case you moved or widened them.

You can't annotate a change with no measurable impact.

## Why the number changes over time

Providers publish billing late and keep correcting it for days afterwards. Infrawrench recalculates
the comparison every time you look, so the number gets more accurate as the data fills in. A deploy
that reads `+$4/day` with low confidence on Tuesday might read `+$18/day` with high confidence by
the following week.

## Where it shows up

| Surface                    | What you get                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Changes** (web, desktop) | A cost line under each row, plus **Annotate cost graph**.                                                                             |
| **Deploy** (web, desktop)  | **Cost impact** on each successful run, expanding to the per-resource breakdown.                                                      |
| **Mobile**                 | The cost line on change rows and in the change detail. Tap a successful deploy for its breakdown. Annotating is web and desktop only. |
| **Weekly digest**          | A **Biggest cost move** line naming the week's largest measured change, with its basis and window.                                    |

In the [weekly digest](./weekly-digest.md), this line is separate from **Projected spend**. The
projection is an estimate of what new resources will cost based on list prices. This line is what
your provider's actual billing says a specific change did.

## Requirements

- Cloud only. Desktop local mode doesn't have collected provider spend.
- At least one account with [cost collection](./cloud-costs.md) working, covering both windows.
- `costs:read` to see impacts, `costs:write` to annotate.
