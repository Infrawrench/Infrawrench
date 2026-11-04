---
title: Commitments
description: Track your reserved instances, savings plans and committed-use discounts, how much of your bill they cover, whether they're being used, and what to buy next.
sidebar_order: 14
---

Reserved instances, savings plans and committed-use discounts are often the biggest lever on a large cloud bill, and the hardest thing to see on a spend graph. The purchase is one spike, the discount is a slightly lower line, and no daily total tells you whether a three-year reservation is paying for itself.

The **Commitments** section, on the **Commitments & credits** tab of the Costs panel, shows every reservation, savings plan and committed-use discount your connected accounts hold. It's collected daily from each provider.

![The Commitments section on the Costs panel showing a coverage range line ("62% to 78% of USD usage covered"), a table of holdings with utilization percentages and one "expired" row, and a savings planner recommendation beneath](https://agent-assets.infrawrench.com/docs-screenshots/features/commitments/commitments-section.png)

## What's collected

| Provider         | What appears                                                  | Source                                                                                               |
| ---------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **AWS**          | EC2 Reserved Instances, RDS Reserved Instances, Savings Plans | `DescribeReservedInstances`, `DescribeReservedDBInstances`, `DescribeSavingsPlans`                   |
| **GCP**          | Committed-use discounts                                       | `compute.regionCommitments`                                                                          |
| **Azure**        | Reservations, Savings Plans                                   | the tenant-level `Microsoft.Capacity/reservations` list and `Microsoft.BillingBenefits/savingsPlans` |
| **Crusoe Cloud** | Reserved capacity contracts per instance type                 | `GET /organizations/{id}/reservations`                                                               |

Expired and queued commitments are shown too, so you can see a queued purchase before it starts billing.

A few things to know about what providers report:

- **Some rows say "price not reported".** Azure doesn't report the purchase price, GCP reports commitments in vCPUs and GB rather than money, and Crusoe reports the reserved quantity of an instance type rather than a price. These rows never show $0, because "free" and "not reported" aren't the same.
- **"All regions"** means the commitment applies wherever your usage runs, like an AWS Compute Savings Plan.
- **Azure reservations show Azure's own utilization figures** (1, 7 and 30 day). They're labelled as provider-reported and kept separate from Infrawrench's utilization, since the two are measured differently.

## Coverage, shown as a range

Coverage tells you how much of your usage spend is covered by a commitment.

It uses **amortized** cost on both sides. Providers price covered hours at zero cash, because you paid upfront, so a cash-based coverage figure would always read 0%.

A cost row counts as covered when the provider says a commitment covered it, even if it doesn't say which one.

There's no single right denominator, so coverage is shown as a **range**:

- The **low end** counts every uncovered usage dollar. That's an overcount, since things like egress and per-request charges can never be covered by a commitment.
- The **high end** only counts uncovered usage in service and region combinations where a commitment actually applied during the period.

Accounts whose provider can't separate usage from credits, fees and taxes are **left out and named** instead of dragging the figure down. If every account is left out, coverage says "unavailable", not 0%.

## Blended discounts for fair chargeback

Coverage and utilization use amortized cost because they describe what the provider actually did. To split the bill fairly between teams, choose the **Blended** [cost basis](./cloud-costs.md#blended) on any graph, report, budget, export or customer. It spreads each commitment's discount evenly over all the usage it could have covered, so every team pays the same rate for the same kind of usage, whichever account got the discount. Daily totals match the amortized totals exactly.

## Utilization, measured only where there's data

For commitments priced in money (like a savings plan's hourly commitment), utilization is _spend delivered ÷ spend committed_, counted only on days where cost data was collected. A day without data shows as a **missing day**, not as an idle commitment, so a fully used plan never looks half used.

Values above 100% are shown as they are. Spending past your commitment is a sign you could commit more.

Commitments measured in units (GCP's vCPU and memory commitments) show "not measurable from spend" instead of a percentage, because cost data can't say how many of the committed vCPUs actually ran.

## Get purchase recommendations

The savings planner looks for steady, uncovered, meaningful workloads over the last 90 days (minimum 60). It recommends committing at the **10th percentile** of daily uncovered spend: the level the workload almost never drops below, not its average.

A workload has to pass four checks, and the first one it fails is shown as the reason:

1. **Present:** spend on at least 90% of days.
2. **Not in decline.**
3. **Steady floor:** the 10th percentile is close to the median.
4. **Material:** at least $1,000 a year of commitment.

Each recommendation shows its risk. At a discount _d_, break-even utilization is _1 − d_. Put simply, **the workload can shrink by the discount rate before the commitment loses money**. Each row also shows the worst-case yearly loss if the workload halves.

Savings use the providers' published rates, which are "up to" figures. So the planner says **"up to $X/yr"** (AWS up to 66%, GCP up to 55%) or a range (Azure publishes 36 to 72%), never a single number.

**Nothing is ever bought automatically.** You make the purchase in your provider's console after reading the recommendation.

## Get alerts

Two alerts cover commitments. See [Commitment & unit-cost alerts](./commitment-and-unit-cost-alerts.md).

- **Commitment expiry** warns 60, 30 and 7 days before a term ends (and once for one that already lapsed without anyone noticing). It tells you what the covered usage will cost at on-demand rates. Commitments with a replacement already queued are skipped.
- **Idle commitments** alert when utilization stays under 70% for a full 30-day window, and tell you how much money was wasted. A commitment with no utilization figure in the table (a unit-based CUD, or an account whose provider doesn't say which commitment applied) **never** alerts, because unknown isn't zero.

## CLI, mobile, API and MCP

- **CLI:** `infrawrench commitments` prints the holdings table, coverage range and planner recommendations. Use `--json` in a weekly cron job to check for commitments expiring soon or utilization dropping.
- **Mobile:** a read-only Commitments section on the **Commitments** tab of the Costs screen.
- **API and MCP:** `GET /api/org/{orgId}/commitments` (permission `costs:read`), and the `get_commitments` tool for AI assistants.

## Required permissions

- **AWS:** `ec2:DescribeReservedInstances`, `rds:DescribeReservedDBInstances`, `savingsplans:DescribeSavingsPlans`.
- **GCP:** `compute.commitments.list` (included in `roles/compute.viewer`).
- **Azure:** the service principal needs **Reader** on the reservations (or the **Reservations Reader** role at tenant scope). Savings plans need the **Savings plan Reader** role. Without it, reservations are still collected and savings plans are skipped.

If collection fails, the section shows the provider's error. A missing permission won't flood the provider's API with retries.
