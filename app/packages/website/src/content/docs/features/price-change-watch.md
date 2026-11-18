---
title: Price change watch
description: Get one alert when a provider changes the list price of an instance type you run, with what it does to your month, and keep anomaly detection and forecasts in step.
sidebar_order: 5
---

Providers change list prices without asking. Infrawrench checks the price history of every instance type your organization runs once a day, and when a price moves it tells you what changed and what it does to your bill: "m5.large in us-east-1 (Amazon EC2) went from $0.096/hr to $0.105/hr on 2026-12-01, +$39.42/mo for your 6 instances".

<insert [The Price catalog tab's Price changes view: the "Affecting your resources" table with two changes (one increase in red with its monthly impact and "Alerted" status, one cut in green), one row's resource list expanded, and the "All catalog changes" table below filtered to Amazon EC2] here>

## What it watches

Each day Infrawrench looks at every running resource whose provider says which instance type it pays for by the hour, matches it against the [instance pricing](./instance-pricing-panel.md) warehouse's price history, and records each change that took effect in the last five weeks.

| Provider      | Resources                                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| AWS           | Running EC2 instances, RDS instances (engine and Multi-AZ matched), ElastiCache clusters, OpenSearch domains, Redshift clusters, EKS node types |
| Azure         | Virtual machines that aren't deallocated, AKS clusters                                                                                           |
| Google Cloud  | Running Compute Engine instances, GKE clusters                                                                                                   |
| Alibaba Cloud | ECS instances (not stopped in economical mode), ACK node pools                                                                                   |
| RunPod        | Running pods (GPU prices count each GPU)                                                                                                         |

Only on-demand list prices count. That's what a running instance pays per hour at list price. Spot prices move every few hours, and reserved and savings-plan rates are bought up front, so neither is news about a running bill. Prices are in USD and don't include your discounts or negotiated rates.

**One change, one row.** A change is the price of one instance type, in one region and variant (operating system, database engine), moving at one moment. Six servers on that type are one change with six instances, never six alerts.

**How the monthly figure is worked out.** The difference in the hourly price, times 730 hours, times how many of that type you run. A cluster counts its nodes when the node count is synced. When it isn't, or a cluster mixes node types, each type counts once and the figure says "at least".

### Future prices

When a provider's price list dates a new price in the future, the change shows as **Upcoming** and is alerted straight away. In practice, none of the providers above publish a price in their price lists before the day it takes effect (checked against AWS's Price List, Azure's Retail Prices API, Google's Cloud Billing Catalog, Alibaba Cloud, RunPod, DigitalOcean, Hetzner, Linode and Scaleway in November 2026), so most changes appear on the first daily check after they take effect.

## Alerts

Each change raises **one alert**, through [alert routing](./alert-routing.md) as its own trigger, **Price changes**. Increases are `warning`, cuts are `info`. A routing rule can match on the provider, the account (when every affected resource is in one), the instance type (the alert's name) and the size of the monthly impact, so "price changes over $100 a month go to #finops" is one rule. The alert reaches [Slack](./slack-alerts.md), [Microsoft Teams](./teams-alerts.md), [email](./email-alerts.md) and [mobile push](./mobile-push-notifications.md) like any other.

A change is alerted when:

- it clears **both** of your thresholds: the monthly impact and the percentage, and
- it's upcoming, or took effect in the last 7 days. Older changes Infrawrench finds (on the first check, or when you start running a type whose price moved weeks ago) are listed but not alerted.

## Anomalies and forecasts

**Expected for anomaly detection.** A price increase is a step in your spend that [anomaly detection](./cost-anomaly-alerts.md) would otherwise flag. When an increase is alerted, Infrawrench adds a one-off [suppression](./cost-anomaly-alerts.md#suppressions) for each account running the type, from the day the new price takes effect, for 7 days, with the reason **Pricing change**. They're ordinary suppressions: you'll see them in the Suppressions list and can edit or delete them. Cuts need none, since detection looks for spikes. If your organization already holds 100 active suppressions, no more are added. Turn this off in the settings below.

**Add to forecast.** A [forecast](./cost-forecasts.md) is a trend, and takes weeks to learn a step in your run rate. **Add to forecast** on a change makes a [scenario model](./scenario-models.md) in USD with one recurring monthly amount, the change's monthly impact, from the day it takes effect, scoped to the change's provider and the accounts running it. Apply it to a cost graph or budget like any other model. Once made, the change says **In a scenario model**, and the model is yours to rename, edit or delete. Making one needs `costs:write`.

## Where to see changes

Open the **Price catalog** tile and choose **Price changes**. It's a view of the same workspace tab, on web and in the desktop app (cloud mode).

- **Affecting your resources** lists your organization's changes, newest first, over the last 30 days to a year. Each row has the old and new hourly price, when it took effect, how many you run (click to list the resources and open one), the monthly impact and what happened: **Alerted**, **Under threshold**, **Marked expected for anomalies**. Changes under your thresholds are hidden until you tick **Include changes under your thresholds**.
- **All catalog changes** lists every on-demand list-price change on one provider's platform (Amazon EC2, Amazon RDS, Azure Virtual Machines, Google Compute Engine and the rest of the [instance pricing](../team-and-billing/instance-pricing-api.md) platforms), whether you run the type or not, for the headline variant: Linux, shared tenancy, standard priority. Filter by instance type or region. Each instance name opens its page on [instances.infrawrench.com](https://instances.infrawrench.com) with its full price history.

The [weekly digest](./weekly-digest.md) has a **Price changes** line when any change over your thresholds took effect during the week, with the net monthly impact and the largest change.

In the [mobile app](./mobile-app.md), the **Alerts** tab of the Costs screen lists your changes over your thresholds from the last 90 days, and a price-change push opens it.

## Settings

In **Settings > Notifications**, on the **Alerts & digest** tab:

<insert [Settings > Notifications > Alerts & digest, the Price changes section: the watch checkbox ticked, the two threshold fields set to 10 and 1, and the "Mark price increases as expected" checkbox] here>

| Setting                                                 | Default | What it does                                                                     |
| ------------------------------------------------------- | ------- | -------------------------------------------------------------------------------- |
| **Watch list prices of what we run**                    | On      | Turns the daily check, and so its alerts, on or off                              |
| **Ignore changes under (USD a month)**                  | 10      | Changes with a smaller monthly impact are listed, not alerted (0 to 1,000,000)   |
| **Ignore changes under (percent)**                      | 1       | Changes smaller than this share of the old price are listed, not alerted (0-100) |
| **Mark price increases as expected for anomaly detection** | On   | Adds the suppressions described above                                            |

Changing the settings needs `org:settings:write`. Seeing your organization's changes needs `costs:read`; the catalog-wide list needs `resources:read`, like the rest of the price catalog. The settings are also a [Terraform resource](./terraform-provider.md), `infrawrench_price_change_settings`.

## CLI and API

```
infrawrench price-changes                          # your changes over your thresholds, last 180 days
infrawrench price-changes --all --days 365         # including the ones under them
infrawrench price-changes catalog --provider rds   # every Amazon RDS change, last 90 days
infrawrench price-changes --json
```

See [CLI](./cli.md). [AI chat](./ai-chat.md) and the [MCP server](./mcp.md) have `list_price_changes` and `list_catalog_price_changes`. The HTTP API has the same under `/api/org/{orgId}/price-changes`: `GET /` (your changes, `?days=`), `GET /catalog` (`?platform=&days=`), `GET` and `PUT /settings`, and `POST /{changeId}/scenario`. See the [API reference](../team-and-billing/openapi.md).

## Where the history comes from

Price history is the instance pricing warehouse behind [instances.infrawrench.com](https://instances.infrawrench.com), which keeps every price a provider has listed as one row per period it held, refreshed from the providers' bulk price lists. AWS history goes back years; Azure, Google Cloud and RunPod changes are tracked from November 2026.

- Hetzner, Oracle Cloud, IBM Cloud and OVHcloud are in the warehouse, so their changes are in **All catalog changes**, but they aren't matched to your resources yet.
- DigitalOcean, Linode, Scaleway and CoreWeave prices come only from their live APIs in the [price catalog](./price-catalog.md), with no history to compare, so they aren't watched.

A self-hosted server without the warehouse's read token says price history isn't available rather than showing no changes.
