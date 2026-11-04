---
title: Idle resource findings
description: Find NAT gateways, load balancers, caches, databases, clusters and custom metrics that bill every hour but do no work, with the usage evidence and what removing them would save.
sidebar_order: 14
---

Idle resource findings show you resources you're paying for that aren't doing any work. A NAT gateway nothing routes through looks just like a busy one in the console. So does a load balancer whose targets moved elsewhere, a cache nobody connects to, or a DynamoDB table provisioned for a launch that never came. They all bill by the hour.

Infrawrench reads each resource's usage metrics from your provider (CloudWatch, Cloud Monitoring, Azure Monitor, Datadog) over a lookback window, two weeks by default. It flags the ones whose usage stayed under the rule's thresholds the whole time. Every finding shows the numbers it was judged on, so you can check before you act.

Findings appear in **Potential savings**, alongside the [orphan finder](./orphan-finder.md)'s, so everything that looks wasted is in one list.

## What gets flagged

| Provider     | Rule                            | Flagged when                                                                                                                                                                            |
| ------------ | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AWS          | Idle NAT gateway                | Next to no bytes sent to the internet (`BytesOutToDestination`) and no active connections (`ActiveConnectionCount`) over the window                                                     |
| AWS          | Idle load balancer              | An Application Load Balancer with next to no requests and processed bytes, a Network Load Balancer with next to no new flows and bytes, or either with no healthy target the whole time |
| AWS          | Idle Classic Load Balancer      | Next to no requests, or no healthy registered instance the whole time                                                                                                                   |
| AWS          | Idle ElastiCache cluster        | No client connections beyond ElastiCache's own monitoring and next to no reads or writes                                                                                                |
| AWS          | Over-provisioned DynamoDB table | A provisioned-capacity table that used under 5% of its read and write capacity. The fix is switching it to on-demand                                                                    |
| AWS          | Idle RDS instance               | A running instance with no database connections. The fix is stopping it, which keeps the data                                                                                           |
| Google Cloud | Idle GKE cluster                | No workloads outside the namespaces GKE manages (`kube-system`, `gke-*`, `gmp-*`), or nodes averaging under 2% CPU                                                                      |
| Google Cloud | Idle Cloud NAT gateway          | VMs are assigned to it but it sent next to no traffic                                                                                                                                   |
| Azure        | Idle load balancer              | A Standard load balancer with rules that moved next to no bytes (one with no rules bills nothing and isn't flagged)                                                                     |
| Azure        | Idle NAT gateway                | Attached to no subnet, or moved next to no bytes                                                                                                                                        |
| Azure        | Idle application gateway        | A running gateway with next to no requests, or no healthy backend the whole time                                                                                                        |
| Datadog      | Unused custom metric            | A custom metric still reporting that nobody queried in 30 days and that no dashboard, monitor, notebook or SLO uses                                                                     |

A resource younger than the lookback window is never flagged, and neither is one whose metrics don't cover the whole window. Missing data isn't treated as zero. The one exception is a metric the provider only publishes when it's non-zero (like an Application Load Balancer's request count), where a missing day counts as zero as long as other metrics confirm the resource was read correctly.

<insert [Costs page Savings tab, Potential savings section showing an "Idle NAT gateway" row with its evidence lines (bytes sent, peak connections, the 14-day window and "flagged since" date) and a "/ mo est." figure in the cost column] here>

## What each finding shows

- **The rule** that flagged it, as a badge next to the reason.
- **The evidence**: each metric it was judged on, its value over the window, the threshold it was compared with, and when it was first flagged.
- **What it saves a month.** If your cost data includes resource ids, this is the resource's real billed spend over the last 30 days. Otherwise it's the provider's list price for the resource's configuration, marked **est.** Hover it to see what the figure covers. Hourly charges are included (NAT gateway and load balancer hours, cache node hours, the GKE management fee plus the cluster's nodes, an Azure application gateway's fixed hourly cost). Data processing and capacity units are left out, since an idle resource uses next to none. If there's no reliable figure (a Cloud NAT gateway, which bills per assigned VM), no figure is shown rather than a guess.
- **Remediate**: the commands that fix it. Most delete the resource, with a final snapshot where the provider supports one. A provisioned DynamoDB table is switched to on-demand instead, an idle RDS instance is stopped, and an Azure application gateway is stopped before it's deleted. Unused Datadog metrics get two read-only checks, because a custom metric only stops billing when whatever sends it stops. See [Remediation commands](./remediation-commands.md).

The Datadog estimate uses Datadog's list price of $5 per 100 custom metrics a month. Plans include some custom metrics per host, and removing those saves nothing, so treat the figure as the most you could save.

## Tune the rules

Select **Idle rules** in the Potential savings header. The form lists every rule for your connected providers, grouped by provider, with:

- a switch for the whole feature, and one per rule
- the **lookback window**, 7 to 42 days (42 days is as far back as Google Cloud keeps GKE metrics at full detail)
- each rule's thresholds, with the default shown under the field. Byte thresholds are entered in MB

When you save, every account is read again on the next collection. **Re-scan now** does the same without changing anything. Switching a rule off hides its findings straight away.

Under the rules, **Collection** shows each account's last read, how many findings it produced, and the last error. If an account's credentials can't read metrics, it says so there with a link to the fix, so an empty list never falsely reads as "nothing is idle".

<insert [Idle rules dialog: the "Run idle rules for this organization" switch and a 14-day lookback, the AWS group with "Idle NAT gateway" expanded to its two threshold fields and their defaults, and the Collection list with one account showing a missing-permission error] here>

Changing the settings needs the **Manage organization settings** permission. Anyone who can see resources can open the form to read the rules and the collection status. You can also manage these settings with the `infrawrench_idle_finding_settings` [Terraform resource](./terraform-provider.md) and `alertSettings.idleFindings` in [config as code](./config-as-code.md).

## How often it checks, and what it costs you

Each account is checked once a day. The metric reads are billed to your own cloud account at the provider's metrics rates: one CloudWatch `GetMetricData` batch per region (a few metrics per resource), a handful of Cloud Monitoring and Azure Monitor queries per resource, and two list calls to Datadog. Price lookups use the AWS Price List and Azure Retail Prices APIs, which are free.

## Permissions

| Provider     | Needs                                                                         |
| ------------ | ----------------------------------------------------------------------------- |
| AWS          | `cloudwatch:GetMetricData`, and `pricing:GetProducts` for the estimates       |
| Google Cloud | `monitoring.timeSeries.list` (in `roles/monitoring.viewer`)                   |
| Azure        | `Microsoft.Insights/metrics/read` (in the Reader and Monitoring Reader roles) |
| Datadog      | An application key with the `metrics_read` scope                              |

The AWS, Google Cloud and Datadog [credential checks](../core-concepts/credential-preflight.md) list these under **Idle resource findings** (Datadog: **Unused custom metrics**), and the least-privilege policy they generate includes them when you select that capability.

## Where the findings show up

Idle findings are part of Potential savings, so they appear everywhere that list does:

- the **mobile app**'s Savings tab, with the evidence under each row (tuning is on web and desktop)
- `infrawrench orphans` in the [CLI](./cli.md), which prints an **Idle evidence** section, and `infrawrench idle-rules` for the rules, thresholds and collection status (`idle-rules rescan` checks again now)
- [Jira](./jira.md), [Linear](./linear.md) and [GitHub](./github-issues.md) issues, which include the rule, the lookback and each evidence line
- the **Savings findings** alert and GitHub issue automation, where the monthly figure is the billed spend or the list-price estimate (labelled as one)
- **Open PR** for a Terraform-managed resource, for rules whose fix is removal (never for a DynamoDB table or a stopped database)
- the **weekly digest**, as an **Idle resources** line with the list-price total
- [realized savings](./realized-savings.md): deleting a flagged resource is recorded as a saving, just like deleting an orphan
- the `list_orphaned_resources` [MCP tool](./mcp.md)

On desktop, you'll see idle findings when signed in to an organization. Local mode can't read provider metrics, so its Potential savings list only has the orphan finder's results.
