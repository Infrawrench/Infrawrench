---
title: Datadog
description: Track Datadog spend by product and organization with month-end projections and cost attribution by tag, chart hourly usage, and manage monitors, downtimes, dashboards, SLOs, synthetic tests, hosts, users and API and application keys.
sidebar_order: 50
---

Connect Datadog to see what you spend and manage your monitors, downtimes, hosts and keys in one place.

## What you can manage

- **Organizations**: your Datadog organization and, on a multi-organization account, every child organization. Each shows its month-to-date cost, the projected month-end cost, a per-product breakdown of both, and the latest finalised month of cost attribution by tag. The Metrics tab charts hourly usage by product: hosts, containers, ingested and indexed logs, spans, custom metrics, synthetic runs, RUM sessions and serverless invocations.
- **Monitors**: edit a monitor's name, notification message, priority and tags. Mute it for an hour, for a day, or until you unmute it, or delete it. Metric and query alerts get a Metrics tab that plots the watched metric with its critical and warning thresholds. You can't edit monitor queries here; change those in Datadog.
- **Downtimes**: current and scheduled downtimes. To create one, pick a monitor (or **All monitors**), a scope such as `env:prod`, and an optional start and end. Leave the end empty to keep it until you cancel it. You can change a downtime's scope or message later, or cancel it by deleting it.
- **Dashboards**: listed with their author and layout. Open one in Datadog with one click, or delete it.
- **SLOs**: target, warning threshold, timeframe and monitors. The Metrics tab charts the SLI with good and bad events for metric SLOs, and up/down state for monitor and time-slice SLOs.
- **Synthetic tests**: API, browser, mobile and network tests with their target and locations. **Run now** runs the test from every configured location. **Pause** and **Resume** toggle it. The Metrics tab charts response time per location and failed runs.
- **Hosts**: every host reporting to Datadog, with its Agent version, platform, integrations, CPU, I/O wait and load. Mute or unmute a host, and chart CPU, load, memory, the fullest disk and network traffic.
- **Users**: members and service accounts with their roles, MFA and last login. **Disable** removes a user's access. The [access review](../features/access-review.md) offers the same action as its Revoke button.
- **API keys** and **application keys**: names, last four characters, creator or owner, scopes and last use. Datadog only shows a key's secret when it's created, so you see metadata here. Deleting a key revokes it at once.

## Connect your account

You fill in three fields:

- **Datadog site**: the site your organization lives on. It's the one in the address you sign in at: `app.datadoghq.com` is **US1**, `us3.datadoghq.com` is **US3**, `us5.datadoghq.com` is **US5**, `app.datadoghq.eu` is **EU**, `ap1.datadoghq.com` is **AP1**, `ap2.datadoghq.com` is **AP2**, `uk1.datadoghq.com` is **UK1**, and `app.ddog-gov.com` / `us2.ddog-gov.com` are the **US1-FED** and **US2-FED** government sites. Keys only work on their own site.
- **API key**: from **Organization Settings > API Keys**. It identifies your organization.
- **Application key**: from **Organization Settings > Application Keys** (or **Personal Settings > Application Keys** for your own). It has the permissions of the user or service account that owns it.

<insert [Datadog Add-account form with the site picker open on EU and the API key and application key fields filled] here>

### Permissions

Cost data needs **Usage Read** (`usage_read`) and **Billing Read** (`billing_read`), and **both keys must belong to the parent organization**. Datadog doesn't show cost to child organizations. Users with the Datadog Admin role have both.

To keep the account read-only, or as narrow as you like, use a **scoped application key**. Run **Check credentials** on the add-account form or the account page. It tests each capability, and its [least-privilege generator](../core-concepts/credential-preflight.md) lists exactly the scopes to grant in Datadog's **Edit Scopes** dialog. The scopes for each capability:

| Capability              | Scopes                                                                          |
| ----------------------- | ------------------------------------------------------------------------------- |
| Cost data               | `usage_read`, `billing_read`                                                    |
| Usage metrics           | `usage_read`                                                                    |
| Monitors and downtimes  | `monitors_read`, plus `monitors_write` and `monitors_downtime` to edit and mute |
| Dashboards              | `dashboards_read`, plus `dashboards_write` to delete                            |
| SLOs                    | `slos_read`, plus `slos_write` to delete                                        |
| Synthetic tests         | `synthetics_read`, plus `synthetics_write` to pause, run or delete              |
| Hosts                   | `hosts_read`                                                                    |
| Host and monitor charts | `timeseries_query`                                                              |
| Business metric import  | `metrics_read`, `timeseries_query`                                              |
| Unused custom metrics   | `metrics_read`                                                                  |
| Users                   | `user_access_read`, plus `user_access_manage` to disable                        |
| API keys                | `api_keys_read`, plus `api_keys_delete` to revoke                               |
| Application keys        | `org_app_keys_read`, plus `org_app_keys_write` to revoke                        |

A scope narrows a key. It can't grant more than the owner's role has. Anything the key can't read shows as an empty list, and the rest of the account still works.

## Find unused custom metrics

Once a day, Infrawrench looks for custom metrics that reported in the last day but that nobody queried in 30 days, and that no dashboard, monitor, notebook or SLO uses. They show up in [Potential savings](../features/idle-resources.md) as **Unused custom metric** findings, largest indexed volume first (up to 100 per organization).

Each finding shows how many series the metric indexes and ingests, and an estimate at Datadog's list price of $5 per 100 custom metrics a month. Metrics inside your plan's included allotment save nothing, so treat the estimate as the most you could save. You can change the 30 days (1 to 180) and the minimum number of indexed series in **Idle rules**.

The suggested commands are two read-only `curl` calls: what uses the metric, and its volumes. You can't delete a custom metric through the API. It stops billing when whatever sends it stops, or you can narrow its tags in **Metrics Summary** with Metrics without Limits.

## Cost graphs

Datadog accounts feed [cost graphs & budgets](../features/cloud-costs.md) with Datadog's own cost figures, at your contracted rates.

- **The current and previous month are daily.** Each day shows what you spent that day. Datadog's estimated cost can lag by up to 72 hours and changes while the month is open, so recent days may move.
- **Older months are monthly.** Datadog only offers finalised monthly totals for those (available around the 16th of the following month), shown on the 1st of each month. Up to 15 months of history load when you first connect.
- **Breakdowns.** Spend is broken down by **product** (Infrastructure Hosts, APM Hosts, Indexed Logs, and so on) as the service, by Datadog region, and by two tags: `org` (the child organization on a multi-organization account) and `pricing` (`committed` for usage at your committed rates, `on_demand` for overage). Group or filter by `pricing` to see what your commitments cover.
- **Projected month-end cost** is on each organization's page and dashboard card. Datadog publishes it from around the 12th of the month.
- **Cost attribution by tag** is on each organization's page, for the latest finalised month (available by the 19th of the following month). It uses the tag keys your organization chose in Datadog under **Plan & Usage > Usage Attribution**, so there's nothing to set up here. It sits beside the product costs rather than in the graphs, so totals aren't counted twice. It isn't available on US1-FED.

Amounts are in US dollars, the currency Datadog prices contracts in.

<insert [Cost graph grouped by service for a Datadog account, showing Infrastructure Hosts, APM Hosts and Indexed Logs stacked by day] here>

<insert [Datadog organization page showing month-to-date and projected month-end cost, the per-product table, and the cost attribution by tag table] here>

## Import business metrics

A Datadog metric can feed a [unit cost](../features/unit-costs.md#import-on-a-schedule) on a schedule: requests served, orders placed, or any custom metric your application sends.

1. Go to **Costs > Unit costs** and choose **Import…** on the metric's row.
2. Pick this account.
3. Fill in the form. Every field is a picker:
   - **Metric** lists metrics that reported in the past week. Type a name to use a quieter one.
   - **Scope** lists the metric's tags. Pick one, type several separated by commas to require all of them, or leave it at `*` for every source.
   - **Break down by** is an optional tag key. Each of its values becomes a label on the metric, and a day's total is the sum across them.
   - **Combine sources with** and **Hourly rollup** are Datadog's space and time aggregation. Sum and sum suit counts.
   - **Count metric**: for count and rate metrics, choose **Yes** to read the number of events rather than the per-second rate Datadog stores.

Days follow your timezone. Datadog keeps metrics for 15 months, so a backfill that reaches further back leaves older days empty.

## Export to Terraform

Monitors export to the official `datadog/datadog` provider as `datadog_monitor` blocks with their name, type, query, message, priority, tags and thresholds, each with its `terraform import` id. Other notification options (renotify, no-data, evaluation delay) aren't included, so import and review the plan before you apply. See [Export to Terraform](../features/terraform-export.md).

## Tips & limits

- **Pick the right site.** A key from one site is rejected by every other site with a 403 that looks like a permission problem. **Check credentials** tells you which site it tried.
- **Cost needs the parent organization's keys.** A child organization's keys list its own resources fine, but cost is refused, and the account tells you so.
- **Unmute only cancels downtimes on the monitor itself.** A monitor silenced by a downtime that targets its tags stays muted until you cancel that downtime. The Downtimes list shows it.
- **Host mutes and monitor mutes are different.** Muting a host silences every monitor notification for that host. Muting a monitor silences that monitor everywhere.
- **Provider status** follows Datadog's US1 status page. Each site has its own page, so if you're on another site, check yours directly.
