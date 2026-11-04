---
title: SLOs and error budgets
description: Set service-level objectives on your probes and metrics, track the error budget left, get burn-rate alerts through your alert routing, and start a change freeze when the budget runs out.
sidebar_order: 12
---

An alert tells you something is wrong right now. A **service-level objective** (SLO) answers
the next question: _how much unreliability can we still afford this month?_

Pick something Infrawrench already measures, say how often it has to be good (99.9%, for
example) over a rolling window, and Infrawrench keeps score. You see the current SLI, how much
**error budget** is left (as a share and as time), and how fast it is burning. When it burns too
fast, you get paged through your [alert routing](./alert-routing.md) rules. When it runs out,
Infrawrench can suggest a [change freeze](../team-and-billing/change-freeze.md).

<insert [The SLOs tab listing several SLOs worst first: one with "Budget exhausted" in red and a warning triangle, one "Slow burn" in amber, the rest "Within budget", each row showing SLI against target, a budget bar and the time left] here>

## Where to find it

Open **SLOs** in the sidebar of the web app, or of the desktop app in cloud mode. The mobile app
has a read-only SLO list and detail view, and the `infrawrench` [CLI](./cli.md) prints the same
numbers with `infrawrench slos`.

## Choose what to measure

The editor lists your probes, plus every resource that reported metrics in the last week and the
series it reported. You pick from those; there are no ids to type.

- **Probe availability.** The share of a [synthetic probe](./synthetic-probes.md)'s checks that
  succeed. The classic uptime SLO.
- **Probe latency.** The share of a probe's checks that answer within a threshold you choose
  (say 300 ms). A failed check records its latency too, usually the timeout, so an outage also
  burns a latency budget.
- **Resource metric against a threshold.** The share of minutes a resource's metric meets a
  condition, for example "CPU % < 80" on a database, or "Queue depth <= 1000". Anything a
  resource chart shows can be an objective, just like with [metric alerts](./metric-alerts.md).

Set the **target** anywhere from 50% to 99.999%, and the **window** to a rolling 7, 28 or 30
days.

<insert [The New SLO editor with "Probe latency" selected: the probe picker open listing probe names with their URLs, the latency threshold field, the target field at 99.9 with the budget hint underneath ("Error budget: 43m 12s of bad minutes per 30 days") and the alert and freeze-suggestion checkboxes] here>

### How minutes are counted

Each minute that has data counts once. For availability, a minute counts as good in proportion
to the checks that succeeded in it. For latency and metric SLOs, a minute is good when its
average is on the right side of the threshold.

**Minutes with no data don't count at all.** A paused probe hasn't been down, but it hasn't been
up either. An SLO with no data in its window shows _No data_, never _Within budget_.

## Read the numbers

<insert [One SLO's detail page: the stat tiles (Status, Current SLI with its target, Budget remaining as a percentage with the time left, Budget total), the row of burn rates for 5m, 30m, 1h, 6h and 3d with the page and ticket policy lines underneath, and the "SLI per day" chart with a flat target line] here>

- **Current SLI**: good minutes divided by all counted minutes over the window.
- **Error budget**: what the target leaves over. 99.9% over 30 days allows 0.1% of the window
  to be bad, which is **43 minutes 12 seconds**. The page shows how much is left, as a
  percentage and as time. An overspent budget shows how far over it is.
- **Burn rate**: how fast the budget is going. **1×** spends exactly the whole budget over the
  window. **14.4×** spends a 30-day budget in about two days.
- **Error budget burndown**: a chart of the budget left after each hour of the window, so you can
  see which day spent it.

<insert [The "Error budget burndown" chart on an SLO's detail page, starting near 100% and stepping down sharply on one day where an incident happened] here>

## Get burn-rate alerts

Alerting on the SLI itself is either too slow (you hear about it once the budget is gone) or too
noisy (you hear about every blip). Infrawrench uses the **multiwindow, multi-burn-rate** policy
from the Google SRE workbook instead:

| Severity | Budget spent | Long window | Short window | Burn rate (30-day SLO) |
| -------- | ------------ | ----------- | ------------ | ---------------------- |
| Page     | 2%           | 1 hour      | 5 minutes    | 14.4×                  |
| Page     | 5%           | 6 hours     | 30 minutes   | 6×                     |
| Ticket   | 10%          | 3 days      | 6 hours      | 1×                     |

An alert fires only when **both** windows are over the threshold. The long window says the burn
matters. The short one says it is still happening, so the alert clears within minutes of the
problem stopping. Thresholds are shares of the budget, so they scale with the window: a 7-day SLO
pages at 3.36× rather than 14.4×.

Each SLO is checked every minute. Alerts go out under the **SLOs** trigger, so your
[alert routing](./alert-routing.md) rules decide where they land: Slack, Microsoft Teams, email,
push to the mobile app, or whoever is [on call](./on-call.md). You get one message per change of
state, not one per check:

- **Fast burn** (a page-severity pair fired), sent at critical severity.
- **Slow burn** (the ticket pair fired), sent as a warning.
- **Stopped burning**, sent as information when the burn subsides.
- **Budget exhausted**, sent once each time the budget runs out.

A fast burn that settles into a slow one doesn't send another message; the page shows the current
state. To keep the numbers without the messages, turn **Alert on burn rate** off on that SLO.

## When the budget runs out

An exhausted budget means the service has used all the unreliability it was allowed for the
window. The usual response is to stop spending more: hold risky deploys and changes until
reliability recovers. With **Suggest a change freeze** on, the exhausted alert says so, and the
SLO's page offers **Start a change freeze**.

<insert [An exhausted SLO's detail page showing the red banner "The error budget is spent. Consider a change freeze…" with the Start a change freeze button, and the freeze dialog open with the duration picker (24 hours, 3 days, 7 days, Until ended) and an optional reason] here>

It is only a suggestion. Nothing is frozen until somebody starts the freeze. The freeze it
creates is an ordinary one: it blocks destructive changes across the organization, shows on the
[operations calendar](./ops-calendar.md), and can be ended early from **Settings > [Change
freezes](../team-and-billing/change-freeze.md)**. Starting one needs the **Freezes: write**
permission.

## On the wallboard

Once your organization has an SLO, the [wallboard](./wallboard.md) gets a **Lowest error budget**
tile naming the SLO closest to running out. An SLO whose budget is spent, or that is burning
fast, appears on the wall's _Not healthy_ panel and turns it amber.

## Manage SLOs as code

SLOs are an `slos` section in [config as code](./config-as-code.md). A probe SLO names its probe
by the probe's document key, and a metric SLO names its resource the same way dashboard resource
pins do. You can also manage them with the [`infrawrench_slo`](./terraform-provider.md) Terraform
resource.

## Permissions

Viewing SLOs needs **Resources: read**. Creating, editing and deleting them needs **Resources:
write**, the same as probes. Starting a change freeze from an SLO needs **Freezes: write**.

## Current limits

- There is no dashboard card for an SLO. The wallboard tile and the SLOs tab carry the numbers.
- Status pages don't show SLO attainment.
- SLOs run in the cloud only. The desktop app shows them in cloud mode.
