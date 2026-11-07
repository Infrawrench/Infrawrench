---
title: New Relic
description: Track New Relic spend by product and account, and manage APM and browser applications, hosts, synthetic monitors, dashboards, workloads, alert policies and NRQL alert conditions.
sidebar_order: 51
---

Connect New Relic to estimate what it costs you each day and manage your apps, monitors, dashboards and alerts.

## What you can manage

- **Accounts**: every account your key can access. The usage account shows this month's data ingest, users, compute and synthetic checks with an estimated cost per product, data ingested by account and by source, and charts daily usage.
- **APM applications**: Apdex, response time, throughput, error rate, hosts and instances. Charts response time, throughput and error rate.
- **Browser applications**: page load time, page views and JavaScript error rate. Charts page load time and page views.
- **Hosts** reporting through the infrastructure agent: CPU, memory and disk use, charted along with load and network traffic.
- **Synthetic monitors**: type, status, frequency, success rate and failing locations. **Enable** or **Disable** a monitor, **Edit** its name and frequency, delete it, and chart duration and failure rate. This works for every monitor type.
- **Dashboards**: owner and permissions. Open in New Relic or delete.
- **Workloads**: rolled-up status and its source. Delete.
- **Alert policies**: create one in any account (picked from a list), **Edit** its name and incident preference, or delete it.
- **Alert conditions** (NRQL): query, thresholds and policy. **Enable** or **Disable**, **Edit** the name, description and runbook link, delete, and chart the query the condition checks. Static, baseline and outlier conditions are all supported.

Entities, policies and conditions are listed from every account the key can access, and each one shows its account.

## Connect an account

1. In New Relic, open your user menu, then **API Keys**, and create a key of type **User**. It starts with `NRAK-`. The key has your user's permissions, so if you want cost data, use a user who can query data in the parent account.
2. In Infrawrench, pick the **Region** your organization uses: US, EU or JP. It's the address you sign in at (`one.newrelic.com`, `one.eu.newrelic.com` or `one.jp.newrelic.com`).
3. Paste the key. The **Usage Account** picker then lists every account the key can see. Pick the parent (or reporting) account, since New Relic records the usage of all its child accounts there.

<insert [New Relic Add-account form with the region picker, the user key filled in and the Usage Account picker open on the list of accounts] here>

The other fields are the prices used to estimate cost (see below). They start at New Relic's list prices, and you can change them any time with **Edit credentials** on the account.

## Cost graphs

New Relic accounts feed [cost graphs and budgets](../features/cloud-costs.md) with daily costs by product:

| Product             | Usage                                      | Default price                     |
| ------------------- | ------------------------------------------ | --------------------------------- |
| Data ingest         | GB ingested beyond the free allowance      | $0.40 per GB, 100 GB free a month |
| Full platform users | Billable full platform users for the month | $349 per user                     |
| Core users          | Billable core users for the month          | $49 per user                      |
| Core compute        | Core CCUs                                  | None: enter your rate             |
| Advanced compute    | Advanced CCUs                              | None: enter your rate             |
| Synthetic checks    | Checks beyond your plan's included checks  | $0.005 per check                  |

- Data ingest and compute are broken down by the account using them (the `account` tag), and by the ingest source (`source`) or compute capability (`capability`).
- **These amounts are estimates.** New Relic reports usage but not prices or invoices, so Infrawrench multiplies your usage by the prices in the account's credentials. Enter your contract's rates there (Data Plus is $0.60 per GB, the EU region adds $0.05 per GB, Pro pay-as-you-go users are $418.80, Standard users are $99) to bring the numbers in line with your bill. Compute rows only appear once you enter a CCU price, because New Relic doesn't publish one.
- Monthly charges are spread over the days they build up: users show on the day the month's billable count goes up, and data ingest is free until the month's total passes the allowance. A month's rows add up to what that month bills at your rates.
- Usage shows up about three hours late, and the current month keeps updating.

## Tips and limits

- On an organization with several accounts, the usage account must be the parent account. Picking a child account only shows that account's own usage.
- Alert policies and conditions are read for up to 1,000 of the accounts the key can access on each sync. With more accounts than that, each sync starts somewhere different and the rest keep their last values until their turn comes. Entities have no such limit.
- Only NRQL alert conditions are listed. Older condition types (APM metric, infrastructure, synthetics) are managed in New Relic.
- [Export to Terraform](../features/terraform-export.md) writes alert policies as `newrelic_alert_policy` resources.
