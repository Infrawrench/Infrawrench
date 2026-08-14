---
title: Network costs
description: Which two things are talking, across which billing boundary, and what that costs — priced egress and cross-zone attribution from your VPC flow logs.
sidebar_order: 12
---

Egress and cross-zone transfer are the least explicable lines on a cloud bill. Your cost graphs can tell you that `AWSDataTransfer` cost $4,100 last month. They cannot tell you that most of it was one service in `use1-az2` talking to a replica in `use1-az4`, because every cost dimension describes _one side_ of a transfer and a network charge is about a **pair**.

Network costs is the pair view. It reads your provider's flow logs, groups them by source and destination, works out which boundary each conversation crossed, prices it, and ranks the result.

## Read this before you read a number

**Everything on this page is an estimate, and it will not reconcile to your invoice.** That is not a bug to be fixed later; it follows from where the data comes from. Specifically:

- **Flow logs are not a meter.** AWS drops records under capacity pressure (`SKIPDATA`) and GCP samples by default. The bytes are close, not exact.
- **Prices are published list rates**, applied per boundary. The 100 GB/month free internet-egress allowance is _not_ deducted — it is consumed account-wide by services this feature cannot see, so subtracting it here would credit it twice. The volume tier above 10 TB is not applied either. Both make large bills read high.
- **Negotiated rates, private pricing and commitment discounts are invisible to us.**

All three errors run in known directions, which is what makes the feature useful anyway: **the ranking is trustworthy even when the absolute figure is not**, and the ranking is the finding. If two flows are $900 and $80 here, the first one is your problem.

For the number that _does_ reconcile, use the provider's own data-transfer line in [cost graphs](./cloud-costs.md). These figures are deliberately kept in a separate store and never added to it — doing so would double-count the same bytes.

## What it can tell you

For each pair of endpoints, per day:

| Question                               | Answer                                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------------ |
| Who is talking to what?                | Source and destination, as resources where they could be identified                        |
| Across what?                           | Same zone, cross-zone, cross-region, internet in, internet out, provider service, NAT, VPN |
| Did it cross a zone, region, or leave? | Derived from the boundary, so the three can never disagree with each other                 |
| What did it cost?                      | Bytes × the published rate for that boundary, in the rate card's currency                  |
| How much of the total is explained?    | A coverage percentage, with the unexplained parts named rather than hidden                 |

![The Network costs section on the Costs panel, showing the coverage line, the by-boundary breakdown, and the top flows list with a cross-zone pair at the top](https://agent-assets.infrawrench.com/docs-screenshots/features/network-costs/section-with-data.png)

## What it cannot tell you

- **Ports, protocols and individual connections.** The aggregation happens before storage — that is what makes the feature affordable — and the key deliberately has no port, protocol or address in it. If you need those, query the flow log directly in your provider's console.
- **Anything below the top-500 pairs per account per day.** Those bytes are not dropped: they are totalled into an explicit **truncated** bucket, priced, and shown. You will always know how much of the bill the itemized list accounts for.
- **The other side of a conversation that isn't yours.** An address that doesn't resolve to one of your network interfaces becomes an **unidentified peer** — its own row, never merged into a neighbouring resource and never spread across the ones that did resolve. "2 TB left this instance for somewhere we can't identify" is a finding; a fabricated destination is not.
- **Anything for a provider with no readable flow source.** Those accounts are listed as unsupported, and contribute nothing. They never show as `0 bytes`, which would be a claim about your network made out of a gap in our coverage.

## Provider support

### AWS — supported

Reads **VPC Flow Logs delivered to CloudWatch Logs**, using the credentials you already connected. Needs `ec2:DescribeFlowLogs`, `ec2:DescribeNetworkInterfaces`, `logs:StartQuery` and `logs:GetQueryResults`.

Two conditions have to hold, and the screen tells you when they don't:

1. **The destination must be CloudWatch Logs.** A flow log writing to S3 or Firehose is listed as a source we can see but not query — reading it would need an Athena workgroup and a results bucket we don't create. Add a second flow log with a CloudWatch destination for the same VPC.
2. **The record format must be custom.** The default flow-log format is version 2, which has no `flow-direction` field — and without it the local end of a record is unknowable, so every inbound byte would be attributed to whoever sent it. Recreate the flow log with a custom format including at least `srcaddr`, `dstaddr`, `bytes` and `flow-direction`.

The fields that turn "an address" into "a resource" are worth adding while you're there: `az-id`, `instance-id`, `traffic-path`, `interface-type` and `pkt-dst-aws-service`. With `next-hop-az-id` (a version 11 field), cross-zone totals become exact rather than top-N.

<insert [The AWS console flow log creation form with "Custom format" selected and the recommended field list highlighted] here>

### GCP — not supported

GCP VPC Flow Logs land in Cloud Logging. The Cloud Logging API cannot aggregate — it lists entries — so reading them would mean pulling gigabytes a day across the internet to compute a few hundred numbers. The affordable path is a BigQuery log sink, which requires a table id we don't currently collect. It is a small addition to the GCP account form and the rest of this feature is already provider-neutral, so it is a question of when rather than whether.

### Azure — not supported

NSG and VNet flow logs are written as JSON blobs to a storage account, one file per hour per NSG. The only aggregatable form is Traffic Analytics, which is a paid add-on that processes them into a Log Analytics workspace — so support would need the add-on enabled, a workspace id we don't hold, and a different authentication scope. Enabling all three on a customer's behalf to produce an estimate is not a trade worth making silently.

## Turning it on

**Collection is off by default, and turning it on spends your money.** Answering "which two things are talking" means running a query against your provider's own log store, and AWS bills CloudWatch Logs Insights **to your account, per gigabyte scanned** — a busy VPC's flow log group is not small. Nothing runs until somebody enables it.

1. Open the **Costs** panel in the sidebar and find the **Network costs** section.
2. Tick **Collect network flows**.

The first pass walks back 7 days by default. Flow logs are commonly retained for 7 or 30 days at the source, so a larger window mostly buys empty queries you still pay to run.

Enabling and disabling are both recorded in the [audit log](../team-and-billing/audit-log.md) — when the line shows up on a bill review, somebody needs to be able to find out who agreed to it. The switch requires the **organization settings** permission for the same reason: it is a decision to spend money in your cloud account, not an edit to a cost object.

Once on, collection runs once a day and reads only **closed** UTC days, so the first flows appear within about 24 hours. The screen shows how much log data the last collection scanned.

![The Network costs section with the "Collect network flows" switch on and the note about queries being billed to your cloud account](https://agent-assets.infrawrench.com/docs-screenshots/features/network-costs/collect-switch-on.png)

## How to read the screen

The **Network costs** section on the [Costs panel](./cloud-costs.md#the-costs-panel) leads with a coverage line: the estimated total, the bytes behind it, and **what percentage of those bytes is attributed to a pair**. Read that first. A top-flows list without it invites exactly the wrong conclusion — that the flows shown _are_ the egress bill.

Below it:

- **Where it goes — by boundary.** Every boundary with traffic, priced. This is the "what is driving our egress bill" answer in one glance: if internet egress is 90% of the money, the fix is a CDN or a cache; if cross-zone is, the fix is placement.
- **Top flows by estimated cost.** Pairs, largest first, with the boundary they crossed, the bytes, and how many days in the range they appeared on — a one-day spike and a standing cost need different responses.

A pair marked **peer not identified** is real traffic to something outside your synced estate. It is ranked and priced like any other row.

## Why it is cheap to keep

Raw flow logs are gigabytes a day per VPC and storing them would make this feature unaffordable. It doesn't store them.

The grouping runs **inside your provider's query engine**, and only the grouped result — at most 500 pairs plus one residual row per boundary, per account, per day — ever leaves it. That is about 518 rows per account per day, hard, regardless of how large or busy your network is. Flow data is kept for **90 days** rather than the three years cost data gets: it explains a bill rather than being a record of one, nothing reconciles against it, and your provider's own flow logs usually can't reach further back anyway.

The consequence to know about: collection is **forward-only**. A day is collected once and never revisited, because flow logs don't restate the way billing data does and re-querying a settled day would charge you again for a byte-identical answer. A day missed during an outage stays missed.

## Related

- [Cost graphs & budgets](./cloud-costs.md) — the collected, invoice-reconciling spend these estimates explain
- [Commitments](./commitments.md) — the other lever that is invisible in a per-resource cost breakdown
- [Kubernetes cost allocation](./kubernetes-costs.md) — the other derived, non-collected cost surface
