---
title: Network flow reports
description: Saved, shareable reports of network traffic and its estimated cost, by flow pair, traffic class, zone, region or VPC, over a window you choose.
sidebar_order: 12
---

[Network costs](./network-costs.md) answers "what is driving our egress bill right now" over the last two weeks. A **network flow report** keeps a narrower question under a name: _how much did cross-zone traffic out of this VPC cost, per day, and which pairs moved it?_ You save it once, re-run it whenever you open it, file it beside your cost reports, share it, export it, and manage it from Terraform.

Reports read the same flow store the Network tab does, so everything on that page about where the numbers come from applies here too. Most importantly: **every cost is an estimate at list price and will not reconcile to your invoice.** The ranking is the finding.

## Creating a report

On the **Costs** page, open the **Network** tab and choose **New report** under **Network flow reports**.

<insert [The New network flow report editor with name, folder, date range "Last 30 days", granularity "Daily", group by "Flow pair", show "Bytes and estimated cost", and the Traffic classes filter set to Cross-zone] here>

| Setting     | What it does                                                                                                                                                                                 |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Folder      | The same [report folders](./cost-reports.md) cost reports use. Create and rename folders under Reports.                                                                                      |
| Date range  | A preset that moves with each run (last 7, 30 or 90 days, month to date, last month…) or fixed dates. Flows are kept for 90 days, so a window reaching further back has empty early buckets. |
| Granularity | Daily, weekly (starting Monday) or monthly. There is no hourly: flows are stored one row per day.                                                                                            |
| Group by    | Flow pair, source, destination, traffic class, peer service, zone pair, region pair, account or VPC. Or no grouping, for one overall line.                                                   |
| Show        | Estimated cost, bytes, or both. A bytes-only report ranks groups and pairs by bytes; the others rank by money.                                                                               |
| Rows listed | How many groups and top talking pairs the report lists, 1 to 200 (25 by default).                                                                                                            |

### Filters

Every filter is a picker over values the flow store has actually seen in the last 90 days. Leave one empty and it does not filter.

- **Accounts.** Without an account filter, Kubernetes cluster traffic is left out: pod traffic leaves through the same node interfaces a cloud flow log already counts, and adding both would count the same bytes twice. Pick a cluster's account to report on its pods.
- **Traffic classes.** Same zone, cross-zone, cross-region, internet egress and ingress, NAT gateway, transit, VPN and interconnect, provider service, and unclassified. Intra-region VPC peering is billed at the cross-zone rate and is classified as cross-zone.
- **Direction.** Egress or ingress, relative to the endpoint whose flow log recorded the traffic.
- **VPCs / networks, regions and availability zones** match either end of a flow, so a region filter keeps traffic into and out of it.
- **Sources and destinations** are flow endpoints: an instance, a load balancer interface, a Kubernetes workload, the internet, or a provider service such as S3.
- **Peer services and peer resource types** describe the other end of the conversation: the destination of egress, the source of ingress.

VPC ids come from the network interface that recorded the flow (AWS). Flows collected before this was recorded, and endpoints a provider does not place in a VPC, have none and only match when the VPC filter is empty.

## Reading a report

<insert [An open network flow report: notices, the estimated cost and bytes tiles, a stacked daily bar chart by flow pair with an "Everything else" band, and the totals table below] here>

- **The tiles** show the estimated cost and bytes over the window, and how much of the traffic is attributed to a named pair. Unattributed bytes (a peer that could not be identified) and bytes outside the stored top pairs are both counted in every total and never spread across the named pairs.
- **The chart** stacks the largest groups over time. Everything else is one grey band, so the stack always adds up to the headline. With **Bytes and estimated cost** you switch the chart between the two.
- **The totals table** lists every group up to the row limit, with its bytes, estimated cost, share of the total and the number of distinct pairs behind it.
- **Top talkers** lists the heaviest flow pairs: source and destination with their zone or region and VPC, the traffic class, bytes, estimated cost, and on how many days in the window the pair appeared. A one-day spike and a standing cost need different fixes.

<insert [The Top talkers table of a network flow report, with one row marked "peer not identified"] here>

### Sampled flow sources

None of today's flow sources samples: AWS VPC flow logs record every flow, and a Kubernetes cluster's figures come from its own counters. Some providers' flow logs do sample traffic rather than recording every flow (GCP VPC flow logs default to half), and reports are ready for such a source when one is added. Bytes from it would be the provider's scaled-up estimate, which makes them an estimate of an estimate. They would be counted, never dropped, and every figure that includes them says so: a **sampled** mark (with the sampled share when it is partial) beside the total, the group and the pair, and a notice at the top of the report. The CSV carries a `sampled_share` column and a `sampled` flag per pair.

### Notices

A report says when its numbers need context: collection is switched off, no account you can see reports flows, the window starts before the 90-day retention, Kubernetes traffic was left out, some bytes are unattributed or outside the stored top pairs, or rate cards in more than one currency are in scope.

## Exporting

**Export CSV** saves one row per group per bucket plus a total row per group (bytes, estimated cost, sampled share, unattributed bytes and bytes outside the top pairs). **Export pairs CSV** saves the top talkers table. Text that looks like a spreadsheet formula is neutralised.

## Sharing and access

Reports are shared like cost reports, with **Share**: an organization-wide default plus per-member and per-role access, and the creator as owner. A report in a folder inherits the folder's explicit sharing. See [Cost visibility and sharing](../team-and-billing/cost-visibility.md).

Opening and running a report needs `costs:read`; creating, editing and deleting it needs `costs:write`. A person with a [cost visibility scope](../team-and-billing/cost-visibility.md) sees flows only for accounts their scope grants outright, in reports exactly as on the Network tab.

## Desktop, CLI, API and Terraform

The desktop app shows the same section in cloud mode.

The CLI lists and runs saved reports:

```
infrawrench network-reports
infrawrench network-reports "Cross-zone traffic by pair"
infrawrench network-reports "Cross-zone traffic by pair" --json
infrawrench network-reports "Cross-zone traffic by pair" --format pairs-csv --out pairs.csv
```

The HTTP routes are `GET|POST /api/org/{orgId}/network-flows/reports`, `GET|PUT|DELETE /api/org/{orgId}/network-flows/reports/{id}`, `POST /api/org/{orgId}/network-flows/reports/{id}/run`, `POST /api/org/{orgId}/network-flows/report-query` for an unsaved config, and `GET /api/org/{orgId}/network-flows/report-options` for the picker values.

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

- [Network costs](./network-costs.md): where flows come from, how they are priced, and turning collection on
- [Cost reports](./cost-reports.md): the report folders network flow reports share
- [Kubernetes cost allocation](./kubernetes-costs.md): per-cluster network costs and their billed allocation
