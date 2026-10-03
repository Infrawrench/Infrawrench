---
title: AWS
description: Manage EC2, EKS, RDS, Lambda, S3, and most of the AWS surface area.
sidebar_order: 1
---

The AWS plugin covers the services most teams live in day to day.

## What you can manage

- **Compute** — EC2 instances, Auto Scaling Groups, Lambda functions, ECS services.
- **Kubernetes** — EKS clusters (links to the [Kubernetes plugin](./kubernetes.md) for pod-level access).
- **Databases** — RDS (Postgres, MySQL, MariaDB, SQL Server, Oracle), Aurora, DocumentDB, Neptune, Redshift, DynamoDB, ElastiCache node-based clusters (Valkey / Redis OSS / Memcached), ElastiCache Serverless caches, OpenSearch Service domains, DB subnet groups.
- **Storage** — S3 buckets, EBS volumes, EFS file systems.
- **Networking** — VPC, Subnets, Security Groups, Internet / NAT Gateways, Elastic IPs, Load Balancers, API Gateway, CloudFront.
- **Messaging** — SQS, SNS.
- **Secrets & identity** — Secrets Manager, IAM users / roles / policies, KMS keys.
- **CI/CD** — CodeBuild, CodePipeline, Step Functions, Glue, CloudFormation stacks.
- **ML & AI** — SageMaker endpoints, Bedrock foundation models and inference profiles (chat playground and usage metrics).

## Credentials

Generate an access key pair in the AWS console (**IAM → Users → Security credentials → Create access key**) for a user with the permissions you need. Paste:

- **Access key ID**
- **Secret access key**
- **Default region**

![AWS Add-account form with access key / secret / region fields](https://agent-assets.infrawrench.com/docs-screenshots/plugins/aws/add-account.png)

Use least-privilege policies. For read-only browsing, the `ReadOnlyAccess` managed policy is usually enough; for creating resources, you need the matching write permissions.

### Credential preflight & least-privilege policy

The add-account form (and **Check credentials** on the account page) probes what the key pair can actually do, per capability — see [Credential preflight](../core-concepts/credential-preflight.md):

- **Resource inventory** — read-only Describe/List access, checked via a representative sample: `ec2:DescribeInstances`, `s3:ListAllMyBuckets`, `rds:DescribeDBInstances`, `lambda:ListFunctions`, `dynamodb:ListTables`.
- **Metrics & dashboards** — `cloudwatch:GetMetricStatistics`, `cloudwatch:GetMetricData`, `cloudwatch:ListMetrics`, plus `logs:FilterLogEvents` and `logs:DescribeLogStreams` for the Logs tabs.
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
- **Bedrock playground** on Bedrock models. The list covers your account's home region and has two kinds of entry:
  - **Foundation models** that can be called on demand by model ID and produce text.
  - **Inference profiles**: the cross-region profiles Bedrock defines (`us.…`, `eu.…`, `apac.…`, `global.…`) and any application inference profiles you created. Most models released since late 2024 can only be called through a profile, so this is where current Claude, Llama and Nova models appear. A profile is listed when it routes to a text-output model; its **Routes to** field names the model behind it.

  Open one and use the **Playground** tab to chat with it through the Converse API. Replies arrive as a single whole message (non-streaming), and the full conversation history is sent on each turn. Models that need provisioned throughput are still left out. The **Lifecycle** field reads `LEGACY` for models AWS has scheduled for end of life. Listing profiles needs `bedrock:ListInferenceProfiles` (without it you still get the on-demand models), and chatting needs `bedrock:InvokeModel`.

- **Bedrock usage metrics**: each Bedrock model or profile has a Metrics tab built from `AWS/Bedrock` CloudWatch metrics: invocations, latency, time to first token, input, output and prompt-cache tokens, client and server errors, throttles, and estimated tokens-per-minute quota usage.
- **Edit Lambda functions**: memory, timeout, ephemeral storage (`/tmp`), runtime, log format and application and system log levels can be changed from **Edit** (`lambda:UpdateFunctionConfiguration`). The detail page also shows the architecture, package type, log group (linked in the [dependency graph](../features/dependency-graph.md)), SnapStart setting, whether the function is a durable function, and the capacity provider for functions on Lambda Managed Instances. The create form defaults to arm64 (Graviton), which is billed at a lower rate, and offers Node.js 24 and 22, Python 3.12 to 3.14 and Ruby 3.3 to 4.0; Node.js 20 was dropped because AWS deprecated it in April 2026.
- **ElastiCache Serverless caches**: create Valkey, Redis OSS or Memcached serverless caches with optional data-storage and ECPU ceilings and a security group picker; the cache is placed in the default VPC's subnets. **Edit** changes the description, both usage ceilings and the snapshot retention and time (`elasticache:ModifyServerlessCache`). Valkey and Redis OSS caches get a **Valkey** or **Redis** tab with a TLS (`rediss://`) connection string, and every cache has a Metrics tab: ECPUs consumed, data stored, hit rate, hits and misses, commands, throttled commands, read and write latency, connections, items, evictions and network bytes. Node-based ElastiCache clusters running Valkey also get the Valkey tab now.
- **Logs tabs** on CloudWatch log groups, Lambda functions, App Runner services, CodeBuild projects and EKS clusters tail the last 24 hours of CloudWatch Logs (`logs:FilterLogEvents`), newest at the bottom, with follow mode. The dropdown picks what to read:
  - **Log groups**: all streams, or one of the 20 most recently written (`logs:DescribeLogStreams`).
  - **Lambda functions**: the function's log group, including a custom one set in its logging config.
  - **App Runner services**: application output or App Runner's own service and deployment log.
  - **CodeBuild projects**: the project's configured log group and stream prefix, or `/aws/codebuild/<project>` by default.
  - **EKS clusters**: all control plane components or one of API server, audit, authenticator, controller manager and scheduler. Control plane logging is off by default; the tab says so until you enable the log types you need in the EKS console.
- **EKS control plane metrics**: EKS clusters on Kubernetes 1.28 or later have a Metrics tab built from the free `AWS/EKS` CloudWatch metrics: API server requests with 4xx, 5xx and 429 responses, p99 latency per verb, in-flight read and mutating requests, API Priority and Fairness seats, pending and unschedulable pods, scheduling attempts by outcome, admission webhook rejections and latency, and etcd database size. The [Kubernetes plugin](./kubernetes.md)'s cost and efficiency series join the same tab.
- **Lambda metrics** cover invocations, duration, errors, throttles, concurrency and provisioned-concurrency spillover, extension duration, dead-letter and destination delivery failures, async events received, aged and dropped, stream iterator age, Kafka offset lag, and invocations dropped by recursive loop detection. Series a function never emits (Kafka lag on a function with no Kafka trigger, say) are left out.
- **ECS service metrics** add running, desired and pending task counts, deployments, container restarts, network throughput and storage I/O when [Container Insights](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/ContainerInsights.html) is on for the cluster. Without it the tab shows CPU and memory utilization only.
- **Read-only manifest view** for most resources.

![DynamoDB detail page showing the Schema & indexes tab with a primary key section, an attribute definitions table, and the global secondary index pills with their build status](https://agent-assets.infrawrench.com/docs-screenshots/plugins/aws/dynamodb-schema-indexes.png)

![DynamoDB Create resource form with the optional "Secondary indexes (optional)" textarea expanded showing an example JSON value](https://agent-assets.infrawrench.com/docs-screenshots/plugins/aws/dynamodb-create-secondary-indexes.png)

## Size pickers

The create forms offer current-generation sizes: Graviton (`db.t4g`, `db.m7g`/`db.r7g`, and Graviton4 `db.m8g`/`db.r8g`) RDS classes, `cache.t4g`, `cache.m7g` and `cache.r7g` ElastiCache nodes, Graviton3 and Graviton4 OpenSearch instances, and RA3 and Graviton RG nodes for Redshift. DC2 Redshift nodes are no longer offered, because AWS stopped accepting new DC2 clusters. Graviton4 and RG sizes are not available in every region yet; if AWS rejects one, pick the previous generation.

The region pickers include every commercial region, including the opt-in regions added since 2023: Calgary (`ca-west-1`), Mexico (`mx-central-1`), Melbourne, Malaysia, New Zealand and Thailand (`ap-southeast-4` to `ap-southeast-7`) and Taipei (`ap-east-2`). Opt-in regions must be enabled on the account before anything can be created there.

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

![Cost graph for an AWS account grouped by Charge type, showing a usage band with smaller commitment fee, tax and credit bands stacked on it](https://agent-assets.infrawrench.com/docs-screenshots/plugins/aws/cost-graph.png)

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

## Network costs

AWS is the one provider that can feed [network costs](../features/network-costs.md) — priced source→destination attribution read from **VPC Flow Logs**.

- Needs `ec2:DescribeFlowLogs`, `ec2:DescribeNetworkInterfaces`, `logs:StartQuery` and `logs:GetQueryResults`.
- **Off until you turn it on.** CloudWatch Logs Insights bills the scan to _your_ account per GB, and a busy VPC's flow log group is not small, so nothing runs until an org admin enables collection.
- Only flow logs delivering to **CloudWatch Logs** can be read. An S3 or Firehose destination is listed as a source we can see but not query.
- The record format must be **custom** and include at least `srcaddr`, `dstaddr`, `bytes` and `flow-direction`. The default format is version 2, which predates `flow-direction` by three versions — without it the local end of a record is unknowable. Add `az-id`, `instance-id`, `traffic-path`, `interface-type` and `pkt-dst-aws-service` too; they are what turn an address into a resource.
- Flows are read for the credential's **own region only**, not fanned out across every enabled region — each region is a separate log group and a separate charge, and a silent fan-out would multiply a cost you did not agree to.

Cross-AZ transfer is priced at $0.01/GB **in each direction**, which is why both directions are stored and priced separately: AWS captures the flow at both network interfaces and bills both ends, so the two records at $0.01 each reproduce the real charge exactly.

## Dependency graph

The VPC wiring is declared, so the [dependency graph](../features/dependency-graph.md) draws it exactly rather than inferring it: EC2 instances link to their VPC, subnet and security groups, and subnets, security groups, load balancers, target groups, NAT gateways and internet gateways link to their VPC. These arrows appear as soon as the account syncs — nothing to wire by hand.

**DB subnet groups** are listed as their own resource so database clusters reach the network. AWS reports a cluster's placement as nothing but the subnet group's name, so Aurora, DocumentDB and Neptune clusters link to their **DB subnet group**, and the group in turn links to its **VPC** and each **subnet** it spans. Opening the group shows every database sharing that placement.

![Dependency graph showing an Aurora cluster linked to a DB subnet group, which fans out to a VPC and two subnets](https://agent-assets.infrawrench.com/docs-screenshots/plugins/aws/dependency-graph-aurora-subnet-group.png)
