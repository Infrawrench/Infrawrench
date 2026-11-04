---
title: Network costs
description: See which two things are talking, across which billing boundary, and what that costs, with priced egress and cross-zone attribution from your VPC flow logs.
sidebar_order: 12
---

Egress and cross-zone transfer are the hardest lines on a cloud bill to explain. Your cost graphs can tell you that `AWSDataTransfer` cost $4,100 last month. They can't tell you that most of it was one service in `use1-az2` talking to a replica in `use1-az4`, because a network charge is about a **pair** of endpoints, not one resource.

Network costs shows you those pairs. It reads your provider's flow logs, groups traffic by source and destination, works out which boundary each conversation crossed, prices it, and ranks the result.

## Read this before you read a number

**Everything on this page is an estimate, and it won't match your invoice.** Here's why:

- **Flow logs aren't a meter.** AWS drops records when under pressure (`SKIPDATA`) and GCP samples by default. The bytes are close, not exact.
- **Prices are published list rates** for each boundary. The 100 GB/month free internet egress allowance isn't deducted, since other services in your account use it up too. The volume tier above 10 TB isn't applied either. Both make large bills look higher.
- **Negotiated rates, private pricing and commitment discounts aren't visible to Infrawrench.**

These errors all lean in known directions, so **the ranking is reliable even when the exact figure isn't**, and the ranking is what matters. If two flows show $900 and $80, the first one is your problem.

For the figure that matches your bill, use the provider's own data transfer line in [cost graphs](./cloud-costs.md). These estimates are never added to your cost data, so nothing is counted twice.

## What it shows

For each pair of endpoints, per day:

| Question                               | Answer                                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------------ |
| Who is talking to what?                | Source and destination, as resources where they could be identified                        |
| Across what?                           | Same zone, cross-zone, cross-region, internet in, internet out, provider service, NAT, VPN |
| Did it cross a zone, region, or leave? | Worked out from the boundary, so the three always agree                                    |
| What did it cost?                      | Bytes × the published rate for that boundary, in the rate card's currency                  |
| How much of the total is explained?    | A coverage percentage, with the unexplained parts named rather than hidden                 |

![The Network costs section on the Costs panel, showing the coverage line, the by-boundary breakdown, and the top flows list with a cross-zone pair at the top](https://agent-assets.infrawrench.com/docs-screenshots/features/network-costs/section-with-data.png)

## What it doesn't show

- **Ports, protocols and individual connections.** Traffic is grouped by endpoint pair only. If you need those details, query the flow log directly in your provider's console.
- **Pairs below the top 500 per account per day.** Those bytes aren't dropped. They're totalled into a **truncated** bucket, priced and shown, so you always know how much of the total the itemized list explains.
- **The other side of a conversation that isn't yours.** An address that isn't one of your network interfaces shows as an **unidentified peer** in its own row. It's never merged into another resource. "2 TB left this instance for somewhere we can't identify" is still a useful finding.
- **Providers with no readable flow source.** Those accounts are listed as unsupported. They never show as `0 bytes`.

## Provider support

### AWS: supported

Reads **VPC Flow Logs delivered to CloudWatch Logs**, using the credentials you already connected. Needs `ec2:DescribeFlowLogs`, `ec2:DescribeNetworkInterfaces`, `logs:StartQuery` and `logs:GetQueryResults`.

Two conditions must be met, and the screen tells you if they aren't:

1. **The destination must be CloudWatch Logs.** A flow log writing to S3 or Firehose is listed but can't be queried. Add a second flow log with a CloudWatch destination for the same VPC.
2. **The record format must be custom.** The default format (version 2) has no `flow-direction` field, and without it inbound traffic can't be attributed correctly. Recreate the flow log with a custom format that includes at least `srcaddr`, `dstaddr`, `bytes` and `flow-direction`.

While you're there, add the fields that turn an address into a named resource: `az-id`, `instance-id`, `traffic-path`, `interface-type` and `pkt-dst-aws-service`. Adding `next-hop-az-id` (a version 11 field) makes cross-zone totals exact rather than top-N.

<insert [The AWS console flow log creation form with "Custom format" selected and the recommended field list highlighted] here>

### GCP: not supported

GCP VPC Flow Logs aren't supported yet. Support would need a BigQuery log sink.

### Azure: not supported

Azure NSG and VNet flow logs aren't supported. Support would need the paid Traffic Analytics add-on and a Log Analytics workspace.

### Kubernetes clusters

A Kubernetes account reports its pods' traffic too, but it's **left out of the totals on this page**, because those bytes also pass through node interfaces an AWS flow log already counts. Each cluster gets its own view, by namespace and workload, with its billed data transfer split across it. See [Kubernetes network costs](./kubernetes-costs.md#network-costs).

## Turning it on

**Collection is off by default, and turning it on costs you money.** It runs queries against your provider's log store, and AWS bills CloudWatch Logs Insights **to your account, per gigabyte scanned**. A busy VPC's flow log group can be large. Nothing runs until someone turns it on.

1. Open the **Costs** panel in the sidebar and find the **Network costs** section.
2. Tick **Collect network flows**.

The first run looks back 7 days by default. Flow logs are often only kept for 7 or 30 days, so looking further back mostly means paying for empty queries.

Turning it on and off are both recorded in the [audit log](../team-and-billing/audit-log.md), so you can see who agreed to the spend. The switch needs the **organization settings** permission, since it's a decision to spend money in your cloud account.

Once on, collection runs once a day for completed UTC days, so the first flows appear within about 24 hours. The screen shows how much log data the last run scanned.

![The Network costs section with the "Collect network flows" switch on and the note about queries being billed to your cloud account](https://agent-assets.infrawrench.com/docs-screenshots/features/network-costs/collect-switch-on.png)

## Read the screen

The **Network costs** section on the [Costs panel](./cloud-costs.md#the-costs-panel)'s **Network** tab starts with a coverage line: the estimated total, the bytes behind it, and **what percentage of those bytes is attributed to a pair**. Read that first, so you don't assume the flows listed are your whole egress bill.

Below it:

- **Where it goes, by boundary.** Every boundary with traffic, priced. If internet egress is 90% of the money, the fix is a CDN or a cache. If it's cross-zone, the fix is placement.
- **Top flows by estimated cost.** Pairs, largest first, with the boundary they crossed, the bytes, and how many days in the range they appeared. A one-day spike and a standing cost need different fixes.

A pair marked **peer not identified** is real traffic to something outside your connected accounts. It's ranked and priced like any other row.

To save a narrower view (one VPC, one traffic class, a month by week, grouped by pair or zone) under a name, create a [network flow report](./network-flow-reports.md) further down the same tab.

## Data retention

Flow data is kept for **90 days**. Your provider's own flow logs usually don't go back further anyway.

Each day is collected once and never revisited. A day missed during an outage stays missed.

## Related

- [Network flow reports](./network-flow-reports.md): saved, shareable views of this data over a window, with filters, groupings and CSV export
- [Cost graphs & budgets](./cloud-costs.md): the actual spend these estimates help explain
- [Commitments](./commitments.md): the other lever you can't see in a per-resource cost breakdown
- [Kubernetes cost allocation](./kubernetes-costs.md): per-cluster costs worked out from your nodes
