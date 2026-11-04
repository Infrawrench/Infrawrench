---
title: Kubernetes efficiency reports
description: Saved, shareable reports on how much of your clusters' cost bought capacity that was actually used, by cluster, namespace, workload, label, node pool or cost category.
sidebar_order: 3
---

A cluster's bill tells you what the nodes cost. It doesn't tell you how much of that money bought something a workload actually used. Kubernetes efficiency reports show you that across every connected cluster, over any window, and save it as a named report you can file, share, export and open again next month.

Each report shows, per row and in total:

- **Total cost:** everything the rows cover.
- **Used:** capacity something measurably used.
- **Requested, unused:** capacity a workload reserved and didn't touch.
- **Unmeasured:** capacity held by a workload with no usage data.
- **Idle:** capacity nobody requested at all.
- **Overhead:** capacity no workload can use, such as kubelet-reserved memory and the managed control-plane fee.
- **Efficiency:** the share of measured cost that was used. See [how efficiency is defined](#how-efficiency-is-defined).

Each figure is split by cost category: CPU, memory, GPU, storage, network (load balancers) and control plane.

<insert [Kubernetes efficiency report page: summary tiles for total, efficiency, used, requested unused, idle, overhead and unmeasured, above a weekly stacked bar chart by usage state with the efficiency line, then the table grouped by namespace] here>

## Where the numbers come from

The numbers come from [Kubernetes cost allocation](./kubernetes-costs.md), which charges each pod for the greater of its request and its usage, and counts what's left over as idle and system-reserved capacity. Every cost row is tagged with:

| Tag            | Values                                                        |
| -------------- | ------------------------------------------------------------- |
| `k8s_resource` | `cpu`, `memory`, `gpu`, `storage`, `network`, `control_plane` |
| `k8s_usage`    | `used`, `unused`, `unmeasured`, `idle`, `overhead`            |

A workload's used and unused parts always add up to what it was charged, and the rows still add up to the cluster's total.

How usage is measured:

- **CPU and memory:** the cluster's metrics-server. Without one, workload compute is `unmeasured`, never `used`.
- **GPUs:** DCGM or AMD exporter busy time. A time-sliced or MPS GPU can't say which workload did the work, so it's `unmeasured`.
- **Storage:** a volume mounted by a running pod counts as used. A bound volume nothing mounts is idle. How full a disk is isn't measured.
- **Network:** a provisioned `LoadBalancer` Service counts as used. Pod traffic is costed in the separate [network view](./kubernetes-costs.md#network-costs) and isn't part of these reports.

**History starts when this feature did.** Older days have no CPU and memory split and no usage state. A report covering them shows that money as **CPU and memory (combined)**, counts it as unmeasured, and says so above the chart.

## How efficiency is defined

Pick the basis for each report:

- **Total cost** (the cluster view): `efficiency = used ÷ (total − unmeasured)`. Idle capacity and overhead count against it, because you pay for them. This is the number that tells you the cluster is too big.
- **Allocated cost** (the workload view): `efficiency = used ÷ (used + requested, unused)`. Only what workloads reserved counts. This is the number that tells you a team asks for more than it needs.

Unmeasured money is left out of both sides of the fraction, and the report shows how much of the cost was measured. If nothing was measured, efficiency reads **n/a**, not 0%. A cluster whose metrics-server is down hasn't suddenly wasted everything.

## Idle capacity: separate or spread

Idle capacity and overhead don't belong to any namespace, workload or pod label. Choose how a report handles them:

- **Separate rows** (the default): they appear as their own **Idle capacity** and **Cluster overhead** rows. Each team's row shows what that team asked for, and an oversized cluster stays visible.
- **Spread across groups:** they're shared out within each cluster and period, in proportion to what each group was allocated. Each team's row then shows a fully loaded cost. One cluster's idle capacity is never spread onto another cluster's teams.

Totals are the same either way. When grouping by cluster, node pool or cost category, idle money already belongs to a group, so it stays in that group's **Idle** column in both modes.

## Create a report

Open **Kubernetes efficiency** from the sidebar and choose **New report**. Every picker lists the values your clusters actually report, so there's nothing to look up.

<insert [New efficiency report editor: name, folder, date range, granularity, group by set to Label with the pod label picker open, the cost category checkboxes, idle handling and efficiency basis radios, and a namespace filter row] here>

- **Date range and granularity:** a rolling window (last 30 days, month to date and so on) or fixed dates, up to 366 days, by day, week or month. Weeks start on Monday.
- **Group by:** cluster, namespace, workload, node pool, cost category or a label. A label can be a pod, node or volume label, or a node attribute such as `capacity_type`.
- **Cost categories:** tick the ones to include. Leave them all unticked for everything.
- **Filters:** by cluster, region, namespace, workload, node pool or any label, with `is` or `is not`.
- **Folder:** reports go in the same folders as [cost reports](./cost-reports.md).

On a report's page, the category checkboxes above the chart narrow the view without changing the saved report. **Reset to saved** puts it back.

### Group by pod labels

Pod labels are available as `k8s_pod_label:<key>` for the keys listed in a cluster's **Pod labels for cost** setting. To choose them, open the Kubernetes account, choose **Update credentials**, and pick from the label keys on the cluster's pods. If you leave it blank, the `app.kubernetes.io/*` labels plus `app`, `team`, `owner`, `environment` and `cost-center` are used wherever pods have them. Labels that change on every rollout, such as `pod-template-hash`, are never used, since they'd split a workload's cost into a new row each time.

## Share a report

Reports are shared like cost reports. **Share** sets who can view or edit a report. A report in a folder also follows that folder's sharing, and whoever created it owns it.

[Cost visibility scopes](../team-and-billing/cost-visibility.md) always apply. Someone limited to two clusters only sees those clusters' rows in any report, including one an unrestricted colleague created.

## Export

- **Download CSV:** one line per row and per cost category, plus the totals.
- **CSV by period:** the same, plus every row's figures for each day, week or month.
- **API and CLI:** `GET /api/org/{orgId}/k8s-efficiency-reports/{id}/export?format=csv|ndjson&perPeriod=true` returns the per-period export as CSV or newline-delimited JSON, and `infrawrench k8s-efficiency "<name>" --format ndjson --out efficiency.ndjson` writes it to a file.

To send the underlying rows to S3, Snowflake or Databricks on a schedule, create a [cost export](./cost-exports.md) filtered to the Kubernetes provider. The `k8s_resource` and `k8s_usage` tags are included on every row.

## Use the CLI and AI clients

```
infrawrench k8s-efficiency
infrawrench k8s-efficiency "Payments efficiency" --json
infrawrench k8s-efficiency --group-by namespace --last 30d --basis allocated
infrawrench k8s-efficiency --group-by k8s_pod_label:team
```

Chat and [MCP](./mcp.md) clients get `list_kubernetes_efficiency_reports`, `run_kubernetes_efficiency_report` and `query_kubernetes_efficiency`.

Reports are also an [OpenTofu/Terraform resource](./terraform-provider.md), `infrawrench_kubernetes_efficiency_report`. The mobile app shows them read-only, under **Costs**.

## Limits

- **One snapshot a day.** Each day's figures come from that day's collection, so pods that came and went in between aren't seen.
- **A node with no price has no cost.** Its capacity is left out of every figure rather than given a made-up price. See [where the node price comes from](./kubernetes-costs.md#where-the-node-price-comes-from).
- **Storage counts as used if it's mounted**, even if the volume is nearly empty.
- **Cluster-level costs only have a region when every node is in the same one.** In a multi-region cluster, a region filter leaves out its disks, load balancers and control-plane fee.

## See also

- [Kubernetes cost allocation](./kubernetes-costs.md)
- [Cost reports](./cost-reports.md)
- [Cost visibility](../team-and-billing/cost-visibility.md)
