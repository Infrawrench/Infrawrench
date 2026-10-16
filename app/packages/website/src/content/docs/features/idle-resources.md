---
title: Idle resource findings
description: Flag NAT gateways, load balancers, caches, databases, clusters and custom metrics that bill every hour but do no work, judged from their own metrics, with the evidence and what removing them saves.
sidebar_order: 14
---

Some waste does not show in how a resource is configured, only in how it is used. A NAT gateway that nothing routes through looks exactly like a busy one in the console; so does a load balancer whose targets were moved elsewhere, a cache nobody connects to, or a DynamoDB table provisioned for a launch that never came. They all bill by the hour.

Idle rules read each resource's metrics from the provider (CloudWatch, Cloud Monitoring, Azure Monitor, Datadog) over a lookback window, two weeks by default, and flag the ones whose usage stayed under the rule's thresholds the whole time. Every finding shows the numbers it was judged on, so you can check the claim before acting on it.

The findings appear in **Potential savings** next to the [orphan finder](./orphan-finder.md)'s, so one list holds everything that looks wasted.

## What gets flagged

| Provider     | Rule                            | Flagged when                                                                                                                                                                            |
| ------------ | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AWS          | Idle NAT gateway                | Next to no bytes sent to the internet (`BytesOutToDestination`) and no active connections (`ActiveConnectionCount`) over the window                                                     |
| AWS          | Idle load balancer              | An Application Load Balancer with next to no requests and processed bytes, a Network Load Balancer with next to no new flows and bytes, or either with no healthy target the whole time |
| AWS          | Idle Classic Load Balancer      | Next to no requests, or no healthy registered instance the whole time                                                                                                                   |
| AWS          | Idle ElastiCache cluster        | No client connections beyond ElastiCache's own monitoring and next to no reads or writes                                                                                                |
| AWS          | Over-provisioned DynamoDB table | A provisioned-capacity table that consumed under 5% of its read and write capacity; the fix is switching it to on-demand                                                                |
| AWS          | Idle RDS instance               | A running instance with no database connections; the fix is stopping it, which keeps the data                                                                                           |
| Google Cloud | Idle GKE cluster                | No workloads outside the namespaces GKE manages (`kube-system`, `gke-*`, `gmp-*`), or nodes averaging under 2% CPU                                                                      |
| Google Cloud | Idle Cloud NAT gateway          | VMs are assigned to it but it sent next to no traffic                                                                                                                                   |
| Azure        | Idle load balancer              | A Standard load balancer with rules that moved next to no bytes (one with no rules bills nothing and is not flagged)                                                                    |
| Azure        | Idle NAT gateway                | Attached to no subnet, or moved next to no bytes                                                                                                                                        |
| Azure        | Idle application gateway        | A running gateway with next to no requests, or no healthy backend the whole time                                                                                                        |
| Datadog      | Unused custom metric            | A custom metric still reporting that nobody queried in 30 days and that no dashboard, monitor, notebook or SLO uses                                                                     |

A resource younger than the lookback window is never judged, and neither is one whose metrics do not cover the window: no data is not the same as zero. The one exception is a metric the provider documents as only published when it is non-zero (an Application Load Balancer's request count, say); there, an absent day counts as zero once another metric the provider always publishes proves the read reached the right resource.

<insert [Costs page Savings tab, Potential savings section showing an "Idle NAT gateway" row with its evidence lines (bytes sent, peak connections, the 14-day window and "flagged since" date) and a "/ mo est." figure in the cost column] here>

## What each finding shows

- **The rule** that flagged it, as a badge beside the reason.
- **The evidence**: each metric it was judged on, its value over the window and the threshold it was compared with, plus when it was first flagged.
- **What it saves a month.** When the cost data your accounts send carries resource ids, this is the resource's real billed spend over the last 30 days. Otherwise it is the provider's published list price for the resource's configuration, marked **est.**, with a note on what the figure covers (hover it). Hourly charges are priced: NAT gateway and load balancer hours, cache node hours, the GKE management fee plus the cluster's nodes, an Azure application gateway's fixed hourly cost. Data processing and capacity units are left out because an idle resource uses next to none. A finding the provider gives no defensible figure for (a Cloud NAT gateway, which bills per assigned VM) shows no figure rather than a guess.
- **Remediate**: the commands that fix it. Most delete the resource (with a final snapshot where the provider supports one). A provisioned DynamoDB table switches to on-demand instead, an idle RDS instance is stopped, and an Azure application gateway is stopped before it is deleted. Unused Datadog metrics get two read-only checks, because a custom metric stops billing only when whatever submits it stops. See [Remediation commands](./remediation-commands.md).

The Datadog estimate uses Datadog's list price of $5 per 100 custom metrics a month. Plans include an allotment of custom metrics per host, and metrics inside it save nothing when removed, so treat the figure as the most it could save.

## Tuning the rules

Select **Idle rules** in the Potential savings header. The form lists every rule your connected providers declare, grouped by provider, with:

- a switch for the whole feature and one per rule
- the **lookback window**, 7 to 42 days (42 days is as far back as Google Cloud keeps GKE metrics at full resolution)
- each rule's thresholds, with the default shown under the field; byte thresholds are entered in MB

Saving stores only what differs from each rule's default, and makes every account due for a fresh read on the next collection. **Re-scan now** does the same without changing anything. Switching a rule off hides its findings straight away.

Under the rules, **Collection** lists each account's last read, how many findings it produced, and the last error. An account whose credential cannot read metrics says so there, with a link to the fix, rather than showing an empty list that reads as "nothing is idle".

<insert [Idle rules dialog: the "Run idle rules for this organization" switch and a 14-day lookback, the AWS group with "Idle NAT gateway" expanded to its two threshold fields and their defaults, and the Collection list with one account showing a missing-permission error] here>

Changing the settings needs the **Manage organization settings** permission; anyone who can see resources can open the form to read the rules and the collection status. The same settings are the `infrawrench_idle_finding_settings` [Terraform resource](./terraform-provider.md) and `alertSettings.idleFindings` in [config as code](./config-as-code.md).

## How often it reads, and what it costs you

The poller reads each account once a day. Every read is billed to your own cloud account at the provider's metrics rates: one CloudWatch `GetMetricData` batch per region (a few metrics per resource), a handful of Cloud Monitoring and Azure Monitor queries per resource, and two list calls to Datadog. List prices come from the AWS Price List and Azure Retail Prices APIs, which are free.

## Permissions

| Provider     | Needs                                                                         |
| ------------ | ----------------------------------------------------------------------------- |
| AWS          | `cloudwatch:GetMetricData`, and `pricing:GetProducts` for the estimates       |
| Google Cloud | `monitoring.timeSeries.list` (in `roles/monitoring.viewer`)                   |
| Azure        | `Microsoft.Insights/metrics/read` (in the Reader and Monitoring Reader roles) |
| Datadog      | An application key with the `metrics_read` scope                              |

The AWS, Google Cloud and Datadog [credential checks](../core-concepts/credential-preflight.md) list these under **Idle resource findings** (Datadog: **Unused custom metrics**), and the least-privilege policy they generate includes them when that capability is selected.

## Everywhere the findings go

Because idle findings are rows of Potential savings, they reach every place that list does:

- the **mobile app**'s Savings tab, with the evidence under each row (tuning stays on web and desktop)
- `infrawrench orphans` in the [CLI](./cli.md), which prints an **Idle evidence** section, and `infrawrench idle-rules` for the rules, thresholds and collection status (`idle-rules rescan` re-reads now)
- [Jira](./jira.md), [Linear](./linear.md) and [GitHub](./github-issues.md) issues, which carry the rule, the lookback and each evidence line
- the **Savings findings** alert and GitHub issue automation, where the monthly figure is the billed spend or the list-price estimate (labelled as one)
- **Open PR** for a Terraform-managed resource, for rules whose fix is removal (never for a DynamoDB table or a stopped database)
- the **weekly digest**, as an **Idle resources** line with the list-price total
- [realized savings](./realized-savings.md): deleting a resource an idle rule flags is recorded as a saving, the same way deleting an orphan is
- the `list_orphaned_resources` [MCP tool](./mcp.md)

Desktop shows them when signed in to an organization. Local mode cannot read provider metrics without the cloud poller, so its Potential savings list has only the orphan finder's rules.
