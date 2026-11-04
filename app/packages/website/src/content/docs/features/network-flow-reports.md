---
title: Network flow reports
description: Saved, shareable reports of network traffic and its estimated cost, by flow pair, traffic class, zone, region or VPC, over a window you choose.
sidebar_order: 12
---

[Network costs](./network-costs.md) shows what's driving your egress bill over the last two weeks. A **network flow report** saves a narrower question under a name, like _how much did cross-zone traffic out of this VPC cost per day, and which pairs moved it?_ Save it once and it re-runs whenever you open it. You can file it next to your cost reports, share it, export it and manage it from Terraform.

Reports use the same traffic data as the Network tab, so everything on that page about where the numbers come from applies here too. Most importantly: **every cost is an estimate at list price and won't match your invoice.** What matters is the ranking.

## Create a report

On the **Costs** page, open the **Network** tab and choose **New report** under **Network flow reports**.

<insert [The New network flow report editor with name, folder, date range "Last 30 days", granularity "Daily", group by "Flow pair", show "Bytes and estimated cost", and the Traffic classes filter set to Cross-zone] here>

| Setting     | What it does                                                                                                                                                                                 |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Folder      | The same [report folders](./cost-reports.md) cost reports use. Create and rename folders under Reports.                                                                                      |
| Date range  | A preset that moves with each run (last 7, 30 or 90 days, month to date, last month…) or fixed dates. Flows are kept for 90 days, so a window reaching further back has empty early buckets. |
| Granularity | Daily, weekly (starting Monday) or monthly. There's no hourly option, as traffic is stored per day.                                                                                          |
| Group by    | Flow pair, source, destination, traffic class, peer service, zone pair, region pair, account or VPC. Or no grouping, for one overall line.                                                   |
| Show        | Estimated cost, bytes, or both. A bytes-only report ranks groups and pairs by bytes. The others rank by money.                                                                               |
| Rows listed | How many groups and top talking pairs the report lists, 1 to 200 (25 by default).                                                                                                            |

### Filters

Each filter offers values seen in the last 90 days. Leave a filter empty to skip it.

- **Accounts.** Without an account filter, Kubernetes cluster traffic is left out, because pod traffic is already counted in the cloud flow logs and including both would count the same bytes twice. Pick a cluster's account to report on its pods.
- **Traffic classes.** Same zone, cross-zone, cross-region, internet egress and ingress, NAT gateway, transit, VPN and interconnect, provider service, and unclassified. Intra-region VPC peering is billed at the cross-zone rate, so it's classed as cross-zone.
- **Direction.** Egress or ingress, relative to the endpoint whose flow log recorded the traffic.
- **VPCs / networks, regions and availability zones** match either end of a flow, so a region filter keeps traffic both into and out of it.
- **Sources and destinations** are flow endpoints: an instance, a load balancer interface, a Kubernetes workload, the internet, or a provider service such as S3.
- **Peer services and peer resource types** describe the other end of the conversation: the destination of egress, or the source of ingress.

VPC ids are available for AWS. Older flows, and endpoints a provider doesn't place in a VPC, have no VPC and only match when the VPC filter is empty.

## Read a report

<insert [An open network flow report: notices, the estimated cost and bytes tiles, a stacked daily bar chart by flow pair with an "Everything else" band, and the totals table below] here>

- **The tiles** show estimated cost and bytes over the window, and how much traffic is attributed to a named pair. Unattributed bytes (where the other end couldn't be identified) and bytes outside the top pairs are counted in every total and never spread across the named pairs.
- **The chart** stacks the largest groups over time. Everything else is one grey band, so the stack always adds up to the headline. With **Bytes and estimated cost** selected, you can switch the chart between the two.
- **The totals table** lists every group up to the row limit, with its bytes, estimated cost, share of the total and the number of distinct pairs behind it.
- **Top talkers** lists the heaviest flow pairs: source and destination with their zone or region and VPC, the traffic class, bytes, estimated cost, and how many days in the window the pair appeared. A one-day spike and a standing cost need different fixes.

<insert [The Top talkers table of a network flow report, with one row marked "peer not identified"] here>

### Sampled traffic

None of today's sources sample traffic: AWS VPC flow logs record every flow, and Kubernetes figures come from the cluster's own counters. If a sampling source is added later, its bytes are counted and clearly marked **sampled** (with the sampled share when it's partial) next to the total, group and pair, with a notice at the top of the report. The CSV has a `sampled_share` column and a `sampled` flag per pair.

### Notices

A report tells you when its numbers need context: collection is switched off, no account you can see reports flows, the window starts before the 90-day retention, Kubernetes traffic was left out, some bytes are unattributed or outside the top pairs, or rate cards in more than one currency are included.

## Export

**Export CSV** saves one row per group per bucket plus a total row per group (bytes, estimated cost, sampled share, unattributed bytes and bytes outside the top pairs). **Export pairs CSV** saves the top talkers table. Text that looks like a spreadsheet formula is made safe.

## Share and control access

Share reports the same way as cost reports, with **Share**: an organization-wide default plus per-member and per-role access, with the creator as owner. A report in a folder inherits the folder's sharing. See [Cost visibility and sharing](../team-and-billing/cost-visibility.md).

- Opening and running a report needs `costs:read`.
- Creating, editing and deleting it needs `costs:write`.
- Someone with a [cost visibility scope](../team-and-billing/cost-visibility.md) only sees traffic for accounts their scope fully grants, the same as on the Network tab.

## Desktop, CLI, API and Terraform

The desktop app shows the same section in cloud mode.

The CLI lists and runs saved reports:

```
infrawrench network-reports
infrawrench network-reports "Cross-zone traffic by pair"
infrawrench network-reports "Cross-zone traffic by pair" --json
infrawrench network-reports "Cross-zone traffic by pair" --format pairs-csv --out pairs.csv
```

API routes:

- `GET|POST /api/org/{orgId}/network-flows/reports`
- `GET|PUT|DELETE /api/org/{orgId}/network-flows/reports/{id}`
- `POST /api/org/{orgId}/network-flows/reports/{id}/run`
- `POST /api/org/{orgId}/network-flows/report-query` for an unsaved report
- `GET /api/org/{orgId}/network-flows/report-options` for the filter values

The [Terraform provider](./terraform-provider.md) manages reports as `infrawrench_network_flow_report`:

```hcl
resource "infrawrench_network_flow_report" "cross_zone" {
  name            = "Cross-zone traffic by pair"
  date_preset     = "30d"
  group_by        = "pair"
  traffic_classes = ["cross_zone", "cross_region"]
}
```

## Related

- [Network costs](./network-costs.md): where traffic data comes from, how it's priced, and turning collection on
- [Cost reports](./cost-reports.md): the report folders network flow reports share
- [Kubernetes cost allocation](./kubernetes-costs.md): per-cluster network costs and their billed allocation
