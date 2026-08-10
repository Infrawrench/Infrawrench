---
title: AWS
description: Manage EC2, EKS, RDS, Lambda, S3, and most of the AWS surface area.
sidebar_order: 1
---

The AWS plugin covers the services most teams live in day to day.

## What you can manage

- **Compute** — EC2 instances, Auto Scaling Groups, Lambda functions, ECS services.
- **Kubernetes** — EKS clusters (links to the [Kubernetes plugin](./kubernetes.md) for pod-level access).
- **Databases** — RDS (Postgres, MySQL, MariaDB, SQL Server, Oracle), Aurora, DocumentDB, Neptune, Redshift, DynamoDB, ElastiCache (Redis / Memcached), OpenSearch Service domains, DB subnet groups.
- **Storage** — S3 buckets, EBS volumes, EFS file systems.
- **Networking** — VPC, Subnets, Security Groups, Internet / NAT Gateways, Elastic IPs, Load Balancers, API Gateway, CloudFront.
- **Messaging** — SQS, SNS.
- **Secrets & identity** — Secrets Manager, IAM users / roles / policies, KMS keys.
- **CI/CD** — CodeBuild, CodePipeline, Step Functions, Glue, CloudFormation stacks.
- **ML & AI** — SageMaker endpoints, Bedrock foundation models (chat playground).

## Credentials

Generate an access key pair in the AWS console (**IAM → Users → Security credentials → Create access key**) for a user with the permissions you need. Paste:

- **Access key ID**
- **Secret access key**
- **Default region**

<insert [AWS Add-account form with access key / secret / region fields] here>

Use least-privilege policies. For read-only browsing, the `ReadOnlyAccess` managed policy is usually enough; for creating resources, you need the matching write permissions.

### Credential preflight & least-privilege policy

The add-account form (and **Check credentials** on the account page) probes what the key pair can actually do, per capability — see [Credential preflight](../core-concepts/credential-preflight.md):

- **Resource inventory** — read-only Describe/List access, checked via a representative sample: `ec2:DescribeInstances`, `s3:ListAllMyBuckets`, `rds:DescribeDBInstances`, `lambda:ListFunctions`, `dynamodb:ListTables`.
- **Metrics & dashboards** — `cloudwatch:GetMetricStatistics`, `cloudwatch:GetMetricData`, `cloudwatch:ListMetrics`.
- **Cost reporting** — `ce:GetCostAndUsage`. This is **not** part of `ReadOnlyAccess`-style infra policies, so it's the check that most often comes back ✗.
- **[Cost estimates](../features/cost-estimates.md)** — `pricing:GetProducts`, for the live per-region prices behind the create form's estimate, the size picker's price chips and the resource page's monthly figure. Also outside typical read-only policies. Without it nothing breaks; AWS resources simply quote no estimate.

The probe resolves the caller with `sts:GetCallerIdentity` (needs no permission) and asks `iam:SimulatePrincipalPolicy` for an exact per-permission verdict; when the key isn't allowed to call the simulator it falls back to one cheap sample read per capability. The generator produces an IAM policy JSON document scoped to the capabilities you tick — attach it as an inline policy on the IAM user whose keys you pasted. It also grants `iam:SimulatePrincipalPolicy` so later preflights stay exact.

## Notable flows

- **SSH terminal** on EC2 instances — [SSH terminal](../features/ssh-terminal.md).
- **SQL editor** on RDS and Aurora — [SQL editor](../features/sql-editor.md).
- **File browser** on S3 — [File browsers](../features/file-browsers.md).
- **Document browser** on DynamoDB tables — scan items, edit/insert/delete documents inline.
- **OpenSearch tab** on OpenSearch Service domains — indices, search, snapshots via the [OpenSearch plugin](./opensearch.md). The domain's endpoint flows through automatically; auth still has to be filled in on the OpenSearch tab (basic auth when fine-grained access control is on, or AWS SigV4 — service `es` — using the same IAM credentials).
- **DynamoDB schema & indexes tab** — view the primary key, attribute definitions, and existing global/local secondary indexes on a table. Add or delete GSIs from the same page; LSIs are creation-only (DynamoDB rule). The create form also accepts an optional `secondaryIndexesJson` blob so you can declare GSIs and LSIs up front.
- **Send test messages** to SQS queues, SNS topics, Kinesis streams, and EventBridge rules from a **Publish** tab on the detail page — see [Send test messages](../features/send-test-message.md). The IAM user needs `sqs:SendMessage`, `sns:Publish`, `kinesis:PutRecord`, and `events:PutEvents` respectively.
- **Secret export to K8s** is supported for RDS, Aurora, Redshift, ElastiCache, S3, Lambda, SQS, SNS, DynamoDB, ECS, EKS — [Secret export](../features/secret-export-to-kubernetes.md).
- **Bedrock playground** on Bedrock foundation models — the list shows on-demand, text-output models in your account's region; open one and use the **Playground** tab to chat with it through the Converse API. Replies arrive as a single whole message (non-streaming), and the full conversation history is sent on each turn. Models that require an inference profile or provisioned throughput are filtered out, since they can't be called by bare model ID.
- **Read-only manifest view** for most resources.

<insert [DynamoDB detail page showing the Schema & indexes tab with a primary key section, an attribute definitions table, and a GSI pill with status / keys / projection / throughput stats] here>

<insert [DynamoDB Create resource form with the optional "Secondary indexes (optional)" textarea expanded showing an example JSON value] here>

## Tips & limits

- Each AWS account in infrawrench is tied to one region for defaults — add multiple accounts if you operate across regions.
- STS assume-role is not yet supported; use a dedicated IAM user for now.
- Rate limits (especially EC2 describe APIs) can slow down very large accounts. Sidebar refresh is 30s; that is usually fine.

## Cost graphs

AWS accounts feed [cost graphs & budgets](../features/cloud-costs.md) via Cost Explorer (`GetCostAndUsage`), collected daily and broken down by service, region and [charge type](../features/cloud-costs.md#charge-types-and-cash-vs-amortized), on both a cash and an [amortized](../features/cloud-costs.md#cash-and-amortized) basis.

- The IAM user needs the `ce:GetCostAndUsage` action — it is **not** part of typical read-only policies, so add a small policy for it. **Charge-type and amortized attribution need no additional permission**: they are the same API call with a different grouping and a second metric.
- AWS charges **$0.01 per Cost Explorer request**. A collection makes three requests per month of range (see below), so a normal day costs 3–6 requests and the one-time 365-day backfill about 39 — well under a dollar a month per account either way.
- Per-resource cost breakdown is not collected (Cost Explorer only retains it for 14 days).

### Charge types, and why non-usage rows have no region

Cost Explorer accepts at most **two groupings per request**, and there are three things worth knowing about a row: its service, its region, and what kind of charge it is. Each collection therefore makes three passes:

| Pass | Covers                                                             | Grouped by            |
| ---- | ------------------------------------------------------------------ | --------------------- |
| 1a   | On-demand consumption — `Usage`                                    | Service + region      |
| 1b   | Covered consumption — `DiscountedUsage`, `SavingsPlanCoveredUsage` | Service + region      |
| 2    | Everything else                                                    | Service + record type |

So **rows that are not consumption carry no region**: a tax line, a credit, a support fee or a reservation fee appears under its service with the region blank. Cost Explorer reports most of those with no region in the first place, and service is the dimension you read them by ("what did the Savings Plan cost", "how much support") — spending the second grouping on the region instead would have cost five to ten times as many requests to learn almost nothing.

Passes 1a and 1b are the same query with different filters, and they are separate only so their rows can carry different charge types. That is what makes commitment coverage measurable at all — see below. Together they are the exact complement of pass 2, so every dollar lands in exactly one of the three. AWS's record types map onto Infrawrench's charge types like this:

| Cost Explorer record type                                                            | Infrawrench charge type  |
| ------------------------------------------------------------------------------------ | ------------------------ |
| `Usage`                                                                              | Usage                    |
| `DiscountedUsage` (reservation-applied usage)                                        | Commitment-covered usage |
| `SavingsPlanCoveredUsage`                                                            | Commitment-covered usage |
| `RIFee`, `Fee`, `SavingsPlanUpfrontFee`, `SavingsPlanRecurringFee`                   | Commitment fee           |
| `SavingsPlanNegation`                                                                | Commitment discount      |
| `Credit`                                                                             | Credit                   |
| `Refund`                                                                             | Refund                   |
| `Tax`                                                                                | Tax                      |
| `Support`                                                                            | Support                  |
| `Discount` (EDP, private rate, solution provider), `BundledDiscount`, anything newer | Other                    |

Three of those are worth a sentence:

- **Reservation- and Savings-Plan-covered usage is consumption**, not a discount — the commitment shows up in the rate the row was billed at, not in what kind of charge it is. It gets its own charge type rather than being lumped in with on-demand usage because "was this hour covered" is the only thing Cost Explorer will ever tell you about coverage, and that is what the [Commitments](../features/commitments.md) coverage figure is computed from. `SavingsPlanNegation` — the separate negative line AWS writes against covered usage — is the actual commitment discount. Reserved Instances have no equivalent line.
- **`Fee` is filed as a commitment fee** even though AWS also uses it for the occasional non-reservation subscription. AWS documents it as the upfront fee for an All Upfront or Partial Upfront RI, and that purchase is the single largest one-day charge most accounts ever see; hiding it under "Other" to protect against the rare subscription is the worse trade.
- **AWS's discount families read as "Other"**, deliberately. An Enterprise Discount Program or private-rate discount is not a credit, and filing it as one would make a negotiated rate indistinguishable from spending promotional balance. Infrawrench has no charge type for a negotiated discount, so it says so rather than guessing.

<insert [Cost graph for an AWS account grouped by Charge type, showing a usage band with smaller commitment fee, tax and credit bands stacked on it] here>

### Amortized cost

Both `UnblendedCost` and `AmortizedCost` come back on the same requests, so AWS accounts support the amortized [cost basis](../features/cloud-costs.md#cash-and-amortized) at no extra cost. This matters more than it sounds for reservations: the unblended rate of RI-covered usage is **zero** by AWS's own definition, so on a cash basis a reserved fleet looks free and the reservation looks like a pure expense. Amortized cost is what those hours are actually worth.

It is also why **commitment coverage is reported on the amortized basis and only there**. Covered hours cost nothing in cash — you paid for them when you bought the commitment — so a coverage percentage computed from cash figures would read 0% for every account that has ever bought anything, however well covered it is. Coverage, the utilization Infrawrench derives from cost rows, and the savings planner all read amortized money for that reason, and all three read it on both sides of every ratio.

### What is not attributed: individual commitments

Cost rows are **not** linked to the specific reservation or Savings Plan they belong to. `GetCostAndUsage` can filter by `SAVINGS_PLAN_ARN` and `RESERVATION_ID` but cannot group by either, so the only way to attribute rows to a particular commitment is one request per commitment held — a bill that grows with the size of your holding, and one that could cover Savings Plans (usually few) but not Reserved Instances (usually many).

The practical effect: the [Commitments](../features/commitments.md) section lists what you own and what it cost, and cost graphs show commitment fees, commitment discounts and covered usage as their own charge types — but "which of my four Savings Plans paid for this hour" is a question AWS's cost API cannot answer, and Infrawrench does not invent an answer for it.

### Re-collecting days collected before charge types existed

Days collected by an older version were stored with every row typed as usage, because that was all the plugin could tell. **Nothing is required of you.** Re-collection sorts itself out: a usage row is stored under exactly the same identity it always was, so the new, usage-only figure replaces the old, all-in one, and the tax and fees that used to be inside it arrive as their own rows.

The one case that could not replace itself — a service and region whose spend was **entirely** non-usage, or entirely commitment-covered, so that no new row lands on the old row's identity — is handled automatically. Every collection compares the rows it is about to write against what is already stored for the same days and supersedes anything left over, so a stale row is cleared by the next collection that touches its day. The [restatement window](../features/cloud-costs.md) walks the last few days over on its own; to sweep your whole history, clear the account's backfill marker so the next cost pass re-walks all 365 days (about 39 requests, ~$0.39).

Earlier builds documented a manual `ALTER TABLE cost_daily DELETE` here. It is no longer needed and should not be run.

## Commitments

AWS accounts feed the [Commitments](../features/commitments.md) section: **EC2 Reserved Instances** and **RDS Reserved Instances** (collected per region) and **Savings Plans** (a single global list), refreshed daily — expired and queued records included.

- Needs `ec2:DescribeReservedInstances`, `rds:DescribeReservedDBInstances` and `savingsplans:DescribeSavingsPlans` — add them alongside `ce:GetCostAndUsage`.
- A Compute Savings Plan shows "All regions", which is exact: it follows your compute wherever it runs.
- Savings Plans' recurring payment is deliberately not shown — AWS documents no period for the figure its API returns, and guessing between hourly and monthly would be a 730× error.
- Cost rows are not linked back to an individual reservation or plan — see [what is not attributed](#what-is-not-attributed-individual-commitments) above for why, and what you get instead.

## Dependency graph

The VPC wiring is declared, so the [dependency graph](../features/dependency-graph.md) draws it exactly rather than inferring it: EC2 instances link to their VPC, subnet and security groups, and subnets, security groups, load balancers, target groups, NAT gateways and internet gateways link to their VPC. These arrows appear as soon as the account syncs — nothing to wire by hand.

**DB subnet groups** are listed as their own resource so database clusters reach the network. AWS reports a cluster's placement as nothing but the subnet group's name, so Aurora, DocumentDB and Neptune clusters link to their **DB subnet group**, and the group in turn links to its **VPC** and each **subnet** it spans. Opening the group shows every database sharing that placement.

<insert [Dependency graph showing an Aurora cluster linked to a DB subnet group, which fans out to a VPC and two subnets] here>
