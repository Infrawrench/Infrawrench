---
title: Extended support findings
description: Find clusters and databases billed at extended-support or end-of-life rates, see what upgrading saves each month, and get warned before the next surcharge starts.
sidebar_order: 15
---

Managed Kubernetes and managed databases are priced on the assumption that you keep upgrading. When a version leaves its provider's standard support window, one of two things happens: the provider starts billing a surcharge for as long as you stay on it (Amazon EKS charges an extra $0.50 per cluster-hour, RDS Extended Support bills per vCPU-hour and doubles in year three), or it schedules an upgrade for you. Both are knowable from the version a resource runs, and both tend to be noticed only when the invoice or the maintenance window arrives.

Infrawrench checks the version of every synced cluster and database against its provider's published support calendar and lists:

- resources **paying an extended-support surcharge** now, with the monthly amount an upgrade removes
- resources **past the end of support**, which the provider can upgrade at any time
- resources **out of standard support with no surcharge**, because the provider offers no paid extension or the resource is not enrolled in one, so a forced upgrade is pending
- resources whose standard support **ends soon**, with what the surcharge will cost once it starts

## Where to find it

Open **Costs** in the sidebar and scroll to **Extended support**, below Oversized. A line at the top totals what you pay now and what is about to start. Each row shows the resource, its current and target version, where it stands on the calendar (when standard support ended or ends, and when the provider upgrades it), the monthly surcharge, and a link to the provider's upgrade guide.

<insert [Costs page scrolled to the Extended support section: the "Paying now / Starting soon" totals line, an EKS cluster row "Amazon EKS 1.32 → 1.35" marked "Paying extended support" with $365/mo billed, an RDS for MySQL 5.7 row in year 3, and an upcoming row] here>

The same list is on the mobile app's Costs tab, in the `infrawrench extended-support` CLI subcommand, and as the `list_extended_support` [MCP tool](./mcp.md). On desktop it works in both modes: signed in it shows your organization, in local-only mode it checks the resources in your local workspace (at list price, since billing is not read locally).

## Where the monthly figure comes from

Each figure says which of these it is:

- **billed**: what the provider actually charged over the last 30 days, scaled to a month. AWS is read from Cost Explorer's extended-support usage types (for example `AmazonEKS-Hours:extendedSupport` and `ExtendedSupport:Yr3:MySQL5.7`). The credential needs `ce:GetCostAndUsage` and `ce:GetDimensionValues`. The policy the AWS credential check generates includes both; a policy written before this feature may need `ce:GetDimensionValues` added, and until then the rows show list price with a note saying so.
- **share of billed**: billing names the region and engine but not the resource, so when several of your resources match the same billed line it is split between them by their list-price weight.
- **list price**: computed from the provider's published rate for the resource's size. List prices are for one reference region (hover the figure to see which); other regions are often higher, which is why a billed figure always wins when one exists.
- **not priced / no surcharge**: the provider prices the surcharge relative to something Infrawrench cannot see (ElastiCache bills a percentage of each node's on-demand price), the size is unknown (Aurora Serverless v2), or there is simply no charge.

Billed lines that match no synced resource are listed under the table rather than dropped: usually a resource in an account you have not connected yet.

Monthly figures assume 730 hours. A row whose rate is scheduled to rise (RDS year three, the final year of OpenSearch extended support) shows the next tier and its date.

## Which providers are covered

The calendars are declared by each provider plugin, from the provider's own documentation:

| Provider      | Resources                                                         | What happens past standard support                                                                                                                |
| ------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| AWS           | EKS clusters                                                      | $0.50 per cluster-hour surcharge for 12 months, unless the cluster's upgrade policy is `STANDARD` (then EKS upgrades it); then a forced upgrade   |
| AWS           | RDS for MySQL / PostgreSQL, Aurora MySQL / PostgreSQL instances   | Per vCPU-hour, $0.100 in years 1-2 and $0.200 in year 3 (US East), unless Extended Support is disabled on the instance (then RDS upgrades it)     |
| AWS           | ElastiCache for Redis OSS 4, 5 and 6                              | 80% of the node's on-demand price in years 1-2, 160% in year 3; shown from billing only                                                           |
| AWS           | OpenSearch Service domains on legacy Elasticsearch and OpenSearch | $0.0065 per normalized instance hour; in the final year, a surcharge equal to the instance price                                                  |
| Azure         | AKS clusters                                                      | Long Term Support needs the Premium tier ($0.50 per cluster-hour over Standard); without it, platform support only and an eventual forced upgrade |
| Azure         | Database for MySQL / PostgreSQL flexible servers                  | $0.07 per vCore-hour (East US), HA standbys included; stopped servers are not billed                                                              |
| Google Cloud  | GKE clusters                                                      | $0.50 per cluster-hour on the Extended channel; clusters on other channels are upgraded before standard support ends                              |
| Google Cloud  | Cloud SQL instances                                               | Per vCPU-hour, $0.07 in years 1-2 and $0.14 in year 3 (us-central1), HA vCPUs counted twice                                                       |
| DigitalOcean  | Kubernetes clusters, managed PostgreSQL, MongoDB and Kafka        | No surcharge: the cluster is upgraded for you after end of life                                                                                   |
| MongoDB Atlas | Clusters                                                          | No surcharge: Atlas upgrades the cluster after end of life                                                                                        |
| Elastic Cloud | Hosted deployments on 7.17 and 8.19                               | No surcharge and no forced upgrade, but no fixes after end of support                                                                             |

Providers change these dates and prices a few times a year; the calendars are refreshed with each release. A version a calendar does not list is never flagged.

## Upcoming surcharges on the expiry radar

The next date for each matching resource (the day the surcharge starts, or the day the provider upgrades it) also appears on the [expiry radar](./expiry-radar.md) as an **Extended support** deadline, so it rides the same countdown and the same daily expiry alert as certificates and tokens. How far ahead the Costs section lists upcoming surcharges is its own setting (90 days by default), in **Settings → Notifications → Extended support**.

## The weekly alert

Once a week, the cloud poller sends one message naming every resource that is paying a surcharge or is past the end of support, with the monthly total an upgrade would remove. It goes out through [alert routing](./alert-routing.md) under the **Extended support** trigger, to Slack, Microsoft Teams or mobile push like every other alert. Turn it off in **Settings → Notifications → Extended support**, or manage the setting with the `infrawrench_extended_support_settings` [Terraform resource](./terraform-provider.md) or [config as code](./config-as-code.md) (`alertSettings.extendedSupport`).

<insert [Settings → Notifications showing the Extended support card with the weekly alert toggle and the "List upcoming surcharges (days ahead)" input set to 90] here>

## Filing the upgrade

Every row has the same **File in Jira** / **File in Linear** button as the other findings ([Jira](./jira.md), [Linear](./linear.md)). The issue is prefilled with the resource, versions, dates, the monthly surcharge and the upgrade guide, and the row then links to the filed issue instead of offering a duplicate.

## The CLI

`infrawrench extended-support` prints the same list, most urgent first, with `--json` for scripts and `--local` for the desktop workspace on your machine:

```
$ infrawrench extended-support
Acme Corp · 3 resources  paying $949/mo · upcoming $365/mo

status                   resource   account  version                     when                                   surcharge
paying extended support  orders-db  Prod     RDS for MySQL 5.7 → MySQL 8.4  since 2024-03-01, forced 2029-06-30   $584/mo billed
paying extended support  payments   Prod     Amazon EKS 1.32 → 1.35       since 2026-03-23, forced 2027-03-22   $365/mo billed
surcharge upcoming       platform   Staging  Amazon EKS 1.34 → 1.35       starts 2026-12-02 (58d)               $365/mo list
```

`--json` includes everything the table leaves out, including each finding's `upgradeUrl`, `nextTier`, `billedLineItems` and the `billing` block.
