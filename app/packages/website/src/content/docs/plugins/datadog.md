---
title: Datadog
description: Track Datadog spend by product and organization with month-end projections and cost attribution by tag, chart hourly usage, and manage monitors, downtimes, dashboards, SLOs, synthetic tests, hosts, users and API and application keys.
sidebar_order: 50
---

## What you can manage

- **Organizations**: your Datadog organization and, on a multi-organization account, every child organization. Each shows its month-to-date cost, the projected month-end cost, a per-product breakdown of both, and the latest finalised month of cost attribution by tag. The Metrics tab charts hourly usage by product: hosts, containers, ingested and indexed logs, spans, custom metrics, synthetic runs, RUM sessions and serverless invocations.
- **Monitors**: edit a monitor's name, notification message, priority and tags. Mute it for an hour, for a day, or until you unmute it, and delete it. Metric and query alerts get a Metrics tab that plots the metric the monitor watches with its critical and warning thresholds drawn across it. Monitor queries are not edited here; change those in Datadog.
- **Downtimes**: the current and scheduled downtimes. Create one by picking a monitor from the list (or **All monitors**), a scope such as `env:prod`, and an optional start and end; leave the end empty to keep it until it is canceled. Change a downtime's scope or message afterwards, or cancel it by deleting it.
- **Dashboards**: listed with their author and layout, opened in Datadog with one click, and deletable.
- **SLOs**: target, warning threshold, timeframe and monitors. The Metrics tab charts the SLI with good and bad events for metric SLOs, and up/down state for monitor and time-slice SLOs.
- **Synthetic tests**: API, browser, mobile and network tests with their target and locations. **Run now** triggers the test from every configured location; **Pause** and **Resume** toggle it. The Metrics tab charts response time per location and failed runs from recent results.
- **Hosts**: every host reporting to Datadog, with its Agent version, platform, integrations, CPU, I/O wait and load. Mute or unmute it, and chart CPU, load, memory, the fullest disk and network traffic.
- **Users**: members and service accounts with their roles, MFA and last login. **Disable** removes a user's access; the [access review](../features/access-review.md) offers the same action as its Revoke button.
- **API keys** and **application keys**: names, last four characters, creator or owner, scopes and last use. Datadog only ever shows a key's secret when it is created, so the list is metadata. Deleting a key revokes it at once.

## Credentials

Three fields:

- **Datadog site**: the site your organization lives on. It is the one in the address you sign in at: `app.datadoghq.com` is **US1**, `us3.datadoghq.com` is **US3**, `us5.datadoghq.com` is **US5**, `app.datadoghq.eu` is **EU**, `ap1.datadoghq.com` is **AP1**, `ap2.datadoghq.com` is **AP2**, `uk1.datadoghq.com` is **UK1**, and `app.ddog-gov.com` / `us2.ddog-gov.com` are the **US1-FED** and **US2-FED** government sites. Keys only work on their own site.
- **API key**: from **Organization Settings → API Keys**. It identifies the organization.
- **Application key**: from **Organization Settings → Application Keys** (or **Personal Settings → Application Keys** for your own). It carries the permissions of the user or service account that owns it.

<insert [Datadog Add-account form with the site picker open on EU and the API key and application key fields filled] here>

### Permissions

Cost data needs **Usage Read** (`usage_read`) and **Billing Read** (`billing_read`), and **both keys must belong to the parent organization**: Datadog does not expose cost to child organizations. Users with the Datadog Admin role have both.

To keep an account read-only, or as narrow as you like, use a **scoped application key**. Run **Check credentials** on the add-account form or the account page: it probes one read per capability, and its [least-privilege generator](../core-concepts/credential-preflight.md) lists exactly the scopes to grant in Datadog's **Edit Scopes** dialog. The scopes behind each capability:

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
| Users                   | `user_access_read`, plus `user_access_manage` to disable                        |
| API keys                | `api_keys_read`, plus `api_keys_delete` to revoke                               |
| Application keys        | `org_app_keys_read`, plus `org_app_keys_write` to revoke                        |

A scope narrows a key; it cannot grant more than its owner's role has. A type the key cannot read simply lists empty rather than failing the whole account.

## Cost graphs

Datadog accounts feed [cost graphs & budgets](../features/cloud-costs.md) from Datadog's own cost figures, at your contracted rates:

- **The current and previous month are daily.** Datadog's estimated cost is published as month-to-date running totals per day; the plugin takes the difference between consecutive days, so each day carries what was spent that day. Estimated cost lags by up to 72 hours and is revised while the month is open, so the last 35 days are re-read on every collection.
- **Older months are monthly.** Before that, Datadog only offers finalised monthly totals (available around the 16th of the following month), recorded on the 1st of each month. Up to 15 months are backfilled on the first sync.
- **Breakdowns.** Spend is broken down by **product** (Infrastructure Hosts, APM Hosts, Indexed Logs, …) as the service, by the Datadog region, and by two tags: `org` (the child organization on a multi-organization account) and `pricing` (`committed` for usage at your committed rates, `on_demand` for overage). Group or filter by `pricing` to see what your commitments cover.
- **Projected month-end cost** is on each organization's page and dashboard card. Datadog publishes the projection from around the 12th of the month.
- **Cost attribution by tag** is on each organization's page, for the latest finalised month (available by the 19th of the following month). It is broken down by the tag keys your organization chose for usage attribution in Datadog under **Plan & Usage → Usage Attribution**; there is nothing to configure here. It is shown beside the product costs rather than collected into the graphs, because the same dollars split a second way would double any total. It is not offered on US1-FED.

Amounts are recorded in US dollars, the currency Datadog prices contracts in; the cost API reports no currency of its own.

<insert [Cost graph grouped by service for a Datadog account, showing Infrastructure Hosts, APM Hosts and Indexed Logs stacked by day] here>

<insert [Datadog organization page showing month-to-date and projected month-end cost, the per-product table, and the cost attribution by tag table] here>

## Export to Terraform

Monitors export to the official `datadog/datadog` provider as `datadog_monitor` blocks with their name, type, query, message, priority, tags and thresholds, each with its `terraform import` id. Other notification options (renotify, no-data, evaluation delay) are not stored, so import and review the plan before applying. See [Export to Terraform](../features/terraform-export.md).

## Tips & limits

- **Pick the right site.** A key from one site is rejected by every other site with a 403 that looks like a permission problem. **Check credentials** says which site it tried.
- **Cost needs the parent organization's keys.** A child organization's keys list its own resources fine, but its cost endpoints are refused, and the account says so instead of graphing nothing.
- **Unmute only cancels downtimes on the monitor itself.** A monitor silenced by a downtime that targets its tags stays muted until that downtime is canceled; the Downtimes list shows it.
- **Host mutes and monitor mutes are different things.** Muting a host silences every monitor notification for that host; muting a monitor silences that monitor everywhere.
- **Provider status** follows Datadog's US1 status page. Each site has its own page; if you are on another site, check it directly.
