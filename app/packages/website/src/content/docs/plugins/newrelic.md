---
title: New Relic
description: Track New Relic spend by product and account, and manage APM and browser applications, hosts, synthetic monitors, dashboards, workloads, alert policies and NRQL alert conditions.
sidebar_order: 51
---

## What you can manage

- **Accounts**: every account your key can access. The usage account shows this month's data ingest, users, compute and synthetic checks with an estimated cost per product, data ingested by account and by source, and charts daily usage.
- **APM applications**: Apdex, response time, throughput, error rate, hosts and instances; charts response time, throughput and error rate.
- **Browser applications**: page load time, page views and JavaScript error rate; charts page load time and page views.
- **Hosts** reporting through the infrastructure agent: CPU, memory and disk use; charts them with load and network traffic.
- **Synthetic monitors**: type, status, frequency, success rate and failing locations. **Enable** or **Disable** a monitor, **Edit** its name and frequency, delete it, and chart duration and failure rate.
- **Dashboards**: owner and permissions; open in New Relic or delete.
- **Workloads**: rolled-up status and its source; delete.
- **Alert policies**: create one in any account (picked from a list), **Edit** its name and incident preference, or delete it.
- **Alert conditions** (NRQL): query, thresholds and policy. **Enable** or **Disable**, **Edit** the name, description and runbook link, delete, and chart the query the condition evaluates.

Entities, policies and conditions are listed from every account the key can access. Each one shows its account.

## Credentials

1. In New Relic, open your user menu, then **API Keys**, and create a key of type **User**. It starts with `NRAK-`. The key acts with your user's permissions, so use a user who can query data in the parent account if you want cost data.
2. In Infrawrench, pick the **Region** your organization uses (US, EU or JP: the address you sign in at, `one.newrelic.com`, `one.eu.newrelic.com` or `one.jp.newrelic.com`).
3. Paste the key. The **Usage Account** picker then lists every account the key can see. Pick the parent (or reporting) account: New Relic records the usage of all its child accounts there.

<insert [New Relic Add-account form with the region picker, the user key filled in and the Usage Account picker open on the list of accounts] here>

The remaining fields are the prices used to estimate cost (see below). They start at New Relic's list prices, and you can change them at any time with **Edit credentials** on the account.

## Cost graphs

New Relic accounts feed [cost graphs & budgets](../features/cloud-costs.md) with daily costs by product:

| Product             | Usage                                      | Default price                     |
| ------------------- | ------------------------------------------ | --------------------------------- |
| Data ingest         | GB ingested beyond the free allowance      | $0.40 per GB, 100 GB free a month |
| Full platform users | Billable full platform users for the month | $349 per user                     |
| Core users          | Billable core users for the month          | $49 per user                      |
| Core compute        | Core CCUs                                  | None: enter your rate             |
| Advanced compute    | Advanced CCUs                              | None: enter your rate             |
| Synthetic checks    | Checks beyond your plan's included checks  | $0.005 per check                  |

- Data ingest and compute are broken down by the consuming account (the `account` tag), and by the ingest source (`source`) or compute capability (`capability`).
- **These amounts are estimates.** New Relic's API reports usage but not prices or invoices, so Infrawrench multiplies usage by the prices in the account's credentials. Enter your contract's rates there (Data Plus is $0.60 per GB, the EU region adds $0.05 per GB, Pro pay-as-you-go users are $418.80, Standard users are $99) to bring the numbers in line with your bill. Compute rows only appear once you enter a CCU price, because New Relic does not publish one.
- Monthly charges are spread over the days they accrue on: users land on the day the month's billable count rises, and data ingest is free until the month's total passes the allowance. A month's rows add up to what that month bills at your rates.
- Usage arrives about three hours late, and the current month is re-read on every collection.

## Tips & limits

- The usage account must be the parent account on an organization with several accounts. Picking a child account only shows that account's own usage.
- Alert policies and conditions are read one account at a time, for the first 100 accounts the key can access. Entities have no such limit.
- Only NRQL alert conditions are listed. Older condition types (APM metric, infrastructure, synthetics) are managed in New Relic.
- Monitors and conditions are edited with the mutation for their own type, so every monitor type and the static, baseline and outlier condition types can be enabled, disabled and renamed.
- [Export to Terraform](../features/terraform-export.md) writes alert policies as `newrelic_alert_policy` resources.
