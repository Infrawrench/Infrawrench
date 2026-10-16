---
title: Kubernetes efficiency reports
description: Saved, shareable reports on how much of your clusters' cost bought capacity that was actually used, by cluster, namespace, workload, label, node pool or cost category.
sidebar_order: 3
---

A cluster's bill tells you what the nodes cost. It does not tell you how much of that money bought something a workload used. Kubernetes efficiency reports answer that across every cluster you have connected, over any window, and keep the answer as a named report you can file, share, export and open again next month.

Each report shows, per row and in total:

- **Total cost**: everything the rows cover.
- **Used**: capacity something measurably used.
- **Requested, unused**: capacity a workload reserved and did not touch.
- **Unmeasured**: capacity held by a workload with no usage data.
- **Idle**: capacity nobody requested at all.
- **Overhead**: capacity no workload can use, such as kubelet-reserved memory and the managed control-plane fee.
- **Efficiency**: the share of measured cost that was used, defined precisely [below](#how-efficiency-is-defined).

Each figure is split by cost category: CPU, memory, GPU, storage, network (load balancers) and control plane.

<insert [Kubernetes efficiency report page: summary tiles for total, efficiency, used, requested unused, idle, overhead and unmeasured, above a weekly stacked bar chart by usage state with the efficiency line, then the table grouped by namespace] here>

## Where the numbers come from

The numbers come from the [Kubernetes cost allocation](./kubernetes-costs.md) Infrawrench already runs. Every day it splits each node's price into CPU, memory and GPU pools, charges each pod for the greater of its request and its usage, and files what is left as idle and system-reserved capacity. Every cost row it writes now also records two things:

| Tag            | Values                                                        |
| -------------- | ------------------------------------------------------------- |
| `k8s_resource` | `cpu`, `memory`, `gpu`, `storage`, `network`, `control_plane` |
| `k8s_usage`    | `used`, `unused`, `unmeasured`, `idle`, `overhead`            |

A workload's compute is written as separate CPU and memory rows, each priced from its own pool. The used part is its measured usage priced the same way as its charge. The unused part is the rest, so the two always add up to what the workload was charged. Nothing is estimated beyond what the allocation already does, and the rows still add up to the cluster's total.

Where the usage comes from:

- **CPU and memory**: the cluster's metrics-server. Without one, workload compute is `unmeasured`, never `used`.
- **GPUs**: DCGM or AMD exporter busy time. A time-sliced or MPS GPU cannot say which sharer did the work, so it is `unmeasured`.
- **Storage**: a volume a running pod mounts counts as used, and a bound volume nothing mounts is idle. Disk fill level is not measured.
- **Network**: a provisioned `LoadBalancer` Service counts as used. Pod traffic is costed in the separate [network view](./kubernetes-costs.md#network-costs) and is not part of these reports.

**History starts when the tags do.** Days collected before this existed have no CPU and memory split and no usage state. A report covering them shows that money as **CPU and memory (combined)** and counts it as unmeasured, and says so above the chart.

## How efficiency is defined

Pick the basis per report:

- **Total cost** (the cluster view): `efficiency = used ÷ (total − unmeasured)`. Idle capacity and overhead count against it, because the cluster pays for them. This is the number that says the cluster is too big.
- **Allocated cost** (the workload view): `efficiency = used ÷ (used + requested, unused)`. Only what workloads reserved counts. This is the number that says a team asks for more than it needs.

Unmeasured money is left out of both the top and the bottom of the fraction, and the report says how much of the cost was measured. If nothing was measured, efficiency reads **n/a**, not 0%. A cluster whose metrics-server is down has not suddenly wasted everything.

## Idle capacity: its own row, or spread

Idle capacity and overhead have no namespace, workload or pod label. Choose how a report treats them:

- **Separate rows** (the default): they appear as **Idle capacity** and **Cluster overhead** rows of their own. Each team's row then means what that team asked for, and the oversized cluster stays visible as a finding.
- **Spread across groups**: they are shared out within each cluster and each period, in proportion to what each group was allocated. Each team's row then reads as a fully loaded cost. A cluster's idle capacity is never spread onto another cluster's teams.

Totals are identical either way. When grouping by cluster, node pool or cost category, idle money already belongs to a group, so it stays in that group's **Idle** column in both modes.

## Creating a report

Open **Kubernetes efficiency** from the sidebar and choose **New report**. Every picker lists the values your clusters actually report, so there is nothing to look up.

<insert [New efficiency report editor: name, folder, date range, granularity, group by set to Label with the pod label picker open, the cost category checkboxes, idle handling and efficiency basis radios, and a namespace filter row] here>

- **Date range and granularity**: a rolling window (last 30 days, month to date, and so on) or fixed dates, up to 366 days, by day, week or month. Weeks start on Monday.
- **Group by**: cluster, namespace, workload, node pool, cost category, or a label. A label can be a pod, node or volume label, or a node attribute such as `capacity_type`.
- **Cost categories**: tick the ones to include. Leave them all unticked for everything.
- **Filters**: by cluster, region, namespace, workload, node pool, or any label, with `is` or `is not`.
- **Folder**: reports file into the same folders as [cost reports](./cost-reports.md).

On a report's page, the category checkboxes above the chart narrow the view without changing the saved report. **Reset to saved** puts it back.

### Pod labels

Pod labels are recorded under `k8s_pod_label:<key>` for the keys a cluster's **Pod labels for cost** setting names. Open the Kubernetes account, choose **Update credentials**, and pick from the label keys present on the cluster's pods. Left blank, the `app.kubernetes.io/*` labels plus `app`, `team`, `owner`, `environment` and `cost-center` are recorded wherever pods carry them. Labels a controller stamps per pod or per rollout, such as `pod-template-hash`, are never recorded, because they would split a workload's cost into a new row on every rollout.

## Sharing and visibility

Reports are shared like cost reports. **Share** sets who can view or edit a report. A report in a folder also follows that folder's sharing, and whoever created it owns it.

[Cost visibility scopes](../team-and-billing/cost-visibility.md) always apply. A report runs as the person viewing it, so someone limited to two clusters sees only those clusters' rows in any report, including one an unrestricted colleague created.

## Exporting

- **Download CSV**: one line per row and per cost category, plus the totals.
- **CSV by period**: the same, plus every row's figures for each day, week or month.
- **API and CLI**: `GET /api/org/{orgId}/k8s-efficiency-reports/{id}/export?format=csv|ndjson&perPeriod=true` returns the per-period export as CSV or newline-delimited JSON, and `infrawrench k8s-efficiency "<name>" --format ndjson --out efficiency.ndjson` writes it to a file.

To land the underlying rows in S3, Snowflake or Databricks on a schedule, create a [cost export](./cost-exports.md) filtered to the Kubernetes provider. The `k8s_resource` and `k8s_usage` tags travel with every row.

## From the CLI and AI clients

```
infrawrench k8s-efficiency
infrawrench k8s-efficiency "Payments efficiency" --json
infrawrench k8s-efficiency --group-by namespace --last 30d --basis allocated
infrawrench k8s-efficiency --group-by k8s_pod_label:team
```

Chat and [MCP](./mcp.md) clients get `list_kubernetes_efficiency_reports`, `run_kubernetes_efficiency_report` and `query_kubernetes_efficiency`.

Reports are also an [OpenTofu/Terraform resource](./terraform-provider.md), `infrawrench_kubernetes_efficiency_report`. The mobile app shows them read-only, under **Costs**.

## Limitations

- **One snapshot a day.** The Kubernetes API describes what is running now, so each day's figures are that day's collection. Pods that came and went between collections are not seen.
- **A node with no price has no money.** Its capacity is left out of every figure rather than given an invented price. See [where the node price comes from](./kubernetes-costs.md#where-the-node-price-comes-from).
- **Storage usage is attachment, not fill.** A mounted but nearly empty volume counts as used.
- **Cluster-level rows carry a region only when every node agrees on one.** In a multi-region cluster, a region filter leaves out its disks, load balancers and control-plane fee.

## See also

- [Kubernetes cost allocation](./kubernetes-costs.md)
- [Cost reports](./cost-reports.md)
- [Cost visibility](../team-and-billing/cost-visibility.md)
