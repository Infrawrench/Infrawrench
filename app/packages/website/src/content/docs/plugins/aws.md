---
title: AWS
description: Manage EC2, EKS, RDS, Lambda, S3, and most of the AWS surface area.
sidebar_order: 1
---

Connect an AWS account to browse, create and manage the services most teams use every day.

## What you can manage

- **Compute**: EC2 instances, Auto Scaling Groups, Lambda functions, ECS services.
- **Kubernetes**: EKS clusters (links to the [Kubernetes plugin](./kubernetes.md) for pod-level access).
- **Databases**: RDS (Postgres, MySQL, MariaDB, SQL Server, Oracle), Aurora, DocumentDB, Neptune, Redshift, DynamoDB, ElastiCache node-based clusters (Valkey, Redis OSS, Memcached), ElastiCache Serverless caches, OpenSearch Service domains, DB subnet groups.
- **Storage**: S3 buckets, EBS volumes, EFS file systems.
- **Networking**: VPC, Subnets, Security Groups, Internet and NAT Gateways, Elastic IPs, Load Balancers (Application, Network, Gateway and Classic), API Gateway, CloudFront.
- **Messaging**: SQS, SNS.
- **Secrets and identity**: Secrets Manager, IAM users, roles and policies, KMS keys.
- **CI/CD**: CodeBuild, CodePipeline, Step Functions, Glue, CloudFormation stacks.
- **ML and AI**: SageMaker endpoints, Bedrock foundation models and inference profiles (chat playground and usage metrics).

## Connect your account

1. In the AWS console, go to **IAM > Users > Security credentials > Create access key** for a user with the permissions you need.
2. In Infrawrench, paste the **Access key ID**, **Secret access key** and **Default region**.

![AWS Add-account form with access key / secret / region fields](https://agent-assets.infrawrench.com/docs-screenshots/plugins/aws/add-account.png)

Use least-privilege policies. For read-only browsing, the `ReadOnlyAccess` managed policy is usually enough. To create resources, you need the matching write permissions.

### Check your permissions

The add-account form, and **Check credentials** on the account page, test what your key pair can do for each feature. See [Credential preflight](../core-concepts/credential-preflight.md).

- **Resource inventory**: read-only Describe and List access, such as `ec2:DescribeInstances`, `s3:ListAllMyBuckets`, `rds:DescribeDBInstances`, `lambda:ListFunctions`, `dynamodb:ListTables`.
- **Metrics and dashboards**: `cloudwatch:GetMetricStatistics`, `cloudwatch:GetMetricData`, `cloudwatch:ListMetrics`, plus `logs:FilterLogEvents` and `logs:DescribeLogStreams` for the Logs tabs.
- **Cost reporting**: `ce:GetCostAndUsage`, plus `ce:GetReservationUtilization` for the [blended basis](#blended-commitment-discounts). These are not part of `ReadOnlyAccess`-style policies, so this is the check that most often fails.
- **[Idle resource findings](../features/idle-resources.md)**: `cloudwatch:GetMetricData`, and `pricing:GetProducts` to price what a finding saves.
- **[Cost estimates](../features/cost-estimates.md)**: `pricing:GetProducts`, for prices on the create form, the size picker and the resource page. This is also outside typical read-only policies. Without it nothing breaks, you just see no estimates.

The check can generate an IAM policy JSON document for the features you tick. Attach it as an inline policy on the IAM user whose keys you pasted. It also grants `iam:SimulatePrincipalPolicy`, which keeps later checks exact.

## Idle resource findings

Once a day, Infrawrench checks your NAT gateways, load balancers, ElastiCache clusters, provisioned DynamoDB tables and running RDS instances, and flags the ones that did no work over the lookback window (14 days by default). See [Idle resource findings](../features/idle-resources.md) for the rules and where findings appear.

| Type                  | Metrics read                                                                                                    | Fix offered                                               |
| --------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| NAT gateway           | `BytesOutToDestination`, `ActiveConnectionCount`, `BytesInFromSource` (per zone for regional NAT gateways)      | Delete it, wait, release its Elastic IP                   |
| Application / Network | `RequestCount` or `NewFlowCount`, `ProcessedBytes`, `ConsumedLCUs`, `HealthyHostCount` across its target groups | Delete it (target groups are left)                        |
| Classic               | `RequestCount`, `HealthyHostCount`                                                                              | Delete it                                                 |
| ElastiCache cluster   | `CurrConnections` per node, `GetTypeCmds` + `SetTypeCmds` (Memcached: `CmdGet` + `CmdSet`)                      | Delete it with a final snapshot, or its replication group |
| DynamoDB table        | `ConsumedRead/WriteCapacityUnits` against `ProvisionedRead/WriteCapacityUnits`                                  | Switch it to on-demand                                    |
| RDS instance          | `DatabaseConnections`                                                                                           | Stop it with a snapshot (Aurora: stop the cluster)        |

The daily check makes CloudWatch metric requests, which AWS bills to your account at its standard rate. Gateway Load Balancers are not checked.

## What you can do

- **SSH terminal** on EC2 instances. See [SSH terminal](../features/ssh-terminal.md).
- **SQL editor** on RDS and Aurora. See [SQL editor](../features/sql-editor.md).
- **File browser** on S3. See [File browsers](../features/file-browsers.md).
- **Document browser** on DynamoDB tables: scan items, and edit, insert or delete documents inline.
- **OpenSearch tab** on OpenSearch Service domains: indices, search and snapshots through the [OpenSearch plugin](./opensearch.md). The endpoint is filled in for you. You still set auth on the OpenSearch tab: basic auth when fine-grained access control is on, or AWS SigV4 (service `es`) with the same IAM credentials.
- **DynamoDB schema and indexes tab**: see the primary key, attribute definitions, and global and local secondary indexes. Add or delete GSIs from the same page. LSIs can only be set when you create the table (a DynamoDB rule). The create form also accepts an optional `secondaryIndexesJson` value so you can declare GSIs and LSIs up front.
- **Send test messages** to SQS queues, SNS topics, Kinesis streams and EventBridge rules from the **Publish** tab. See [Send test messages](../features/send-test-message.md). The IAM user needs `sqs:SendMessage`, `sns:Publish`, `kinesis:PutRecord` and `events:PutEvents` respectively.
- **Secret export to K8s** for RDS, Aurora, Redshift, ElastiCache, S3, Lambda, SQS, SNS, DynamoDB, ECS and EKS. See [Secret export](../features/secret-export-to-kubernetes.md).
- **Bedrock playground** on Bedrock models in your account's home region. You'll see two kinds of entry:
  - **Foundation models** you can call on demand by model ID that produce text.
  - **Inference profiles**: the cross-region profiles Bedrock defines (`us.…`, `eu.…`, `apac.…`, `global.…`) and any application inference profiles you created. Most models released since late 2024 can only be called through a profile, so look here for current Claude, Llama and Nova models. The **Routes to** field names the model behind each profile.

  Open one and chat with it on the **Playground** tab. Replies arrive as one whole message, not streamed. Models that need provisioned throughput aren't listed. **Lifecycle** reads `LEGACY` for models AWS plans to retire. Listing profiles needs `bedrock:ListInferenceProfiles` (without it you still see on-demand models), and chatting needs `bedrock:InvokeModel`.

- **Bedrock usage metrics**: each model or profile has a Metrics tab with invocations, latency, time to first token, input, output and prompt-cache tokens, client and server errors, throttles, and estimated tokens-per-minute quota usage.
- **Edit Lambda functions**: change memory, timeout, ephemeral storage (`/tmp`), runtime, log format and application and system log levels from **Edit** (`lambda:UpdateFunctionConfiguration`). The detail page also shows the architecture, package type, log group (linked in the [dependency graph](../features/dependency-graph.md)), SnapStart setting, whether it is a durable function, and the capacity provider for functions on Lambda Managed Instances. The create form defaults to arm64 (Graviton), which AWS bills at a lower rate, and offers Node.js 24 and 22, Python 3.12 to 3.14 and Ruby 3.3 to 4.0. Node.js 20 isn't offered because AWS deprecated it in April 2026.
- **ElastiCache Serverless caches**: create Valkey, Redis OSS or Memcached serverless caches with optional data-storage and ECPU ceilings and a security group picker. The cache goes in the default VPC's subnets. **Edit** changes the description, both usage ceilings, and snapshot retention and time (`elasticache:ModifyServerlessCache`). Valkey and Redis OSS caches get a **Valkey** or **Redis** tab with a TLS (`rediss://`) connection string. Every cache has a Metrics tab: ECPUs consumed, data stored, hit rate, hits and misses, commands, throttled commands, read and write latency, connections, items, evictions and network bytes. Node-based clusters running Valkey also get the Valkey tab.
- **Logs tabs** on CloudWatch log groups, Lambda functions, App Runner services, CodeBuild projects and EKS clusters show the last 24 hours of CloudWatch Logs (`logs:FilterLogEvents`), newest at the bottom, with follow mode. Use the dropdown to pick what to read:
  - **Log groups**: all streams, or one of the 20 most recently written (`logs:DescribeLogStreams`).
  - **Lambda functions**: the function's log group, including a custom one set in its logging config.
  - **App Runner services**: application output, or App Runner's own service and deployment log.
  - **CodeBuild projects**: the project's configured log group and stream prefix, or `/aws/codebuild/<project>` by default.
  - **EKS clusters**: all control plane components, or one of API server, audit, authenticator, controller manager and scheduler. Control plane logging is off by default. Turn on the log types you need in the EKS console.
- **EKS control plane metrics**: clusters on Kubernetes 1.28 or later have a Metrics tab with the free `AWS/EKS` CloudWatch metrics: API server requests with 4xx, 5xx and 429 responses, p99 latency per verb, in-flight read and mutating requests, API Priority and Fairness seats, pending and unschedulable pods, scheduling attempts by outcome, admission webhook rejections and latency, and etcd database size. The [Kubernetes plugin](./kubernetes.md)'s cost and efficiency series appear on the same tab.
- **Lambda metrics**: invocations, duration, errors, throttles, concurrency and provisioned-concurrency spillover, extension duration, dead-letter and destination delivery failures, async events received, aged and dropped, stream iterator age, Kafka offset lag, and invocations dropped by recursive loop detection. Series a function never emits are hidden.
- **ECS service metrics**: running, desired and pending task counts, deployments, container restarts, network throughput and storage I/O when [Container Insights](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/ContainerInsights.html) is on for the cluster. Without it you get CPU and memory utilization only.
- **Read-only manifest view** for most resources.

![DynamoDB detail page showing the Schema & indexes tab with a primary key section, an attribute definitions table, and the global secondary index pills with their build status](https://agent-assets.infrawrench.com/docs-screenshots/plugins/aws/dynamodb-schema-indexes.png)

![DynamoDB Create resource form with the optional "Secondary indexes (optional)" textarea expanded showing an example JSON value](https://agent-assets.infrawrench.com/docs-screenshots/plugins/aws/dynamodb-create-secondary-indexes.png)

## Just-in-time access

[Just-in-time access](../features/just-in-time-access.md) on AWS uses **IAM Identity Center**. A grant gives an Identity Center user a permission set on an AWS account, and ending the grant removes it. Connect your organization's management account, or the delegated administrator for IAM Identity Center. Infrawrench finds your Identity Center instance in whichever region it's enabled, and shows your accounts and permission sets as pickers.

The credentials need `sso:ListInstances`, `sso:ListPermissionSets`, `sso:DescribePermissionSet`, `sso:ListAccountAssignments`, `sso:CreateAccountAssignment`, `sso:DeleteAccountAssignment`, `sso:DescribeAccountAssignmentCreationStatus`, `sso:DescribeAccountAssignmentDeletionStatus`, `identitystore:GetUserId`, `identitystore:DescribeUser`, `identitystore:ListUsers` and `organizations:ListAccounts`. Without `organizations:ListAccounts`, only the connected account is offered. Creating assignments also needs the IAM permissions Identity Center uses to set up the permission set in the target account. The AWS managed `AWSSSOMemberAccountAdministrator` policy covers them.

Requesters are matched to Identity Center users by email address, then by user name. AWS doesn't expire assignments on its own, so Infrawrench removes them when the window ends. If the user already has that permission set on that account, nothing is created or removed.

## Pick a size and region

The create forms offer current-generation sizes: Graviton RDS classes (`db.t4g`, `db.m7g`/`db.r7g`, and Graviton4 `db.m8g`/`db.r8g`), `cache.t4g`, `cache.m7g` and `cache.r7g` ElastiCache nodes, Graviton3 and Graviton4 OpenSearch instances, and RA3 and Graviton RG nodes for Redshift. DC2 Redshift nodes aren't offered because AWS no longer accepts new DC2 clusters. Graviton4 and RG sizes aren't in every region yet. If AWS rejects one, pick the previous generation.

The region pickers include every commercial region, including the opt-in regions added since 2023: Calgary (`ca-west-1`), Mexico (`mx-central-1`), Melbourne, Malaysia, New Zealand and Thailand (`ap-southeast-4` to `ap-southeast-7`) and Taipei (`ap-east-2`). Enable an opt-in region on your account before you create anything there.

## Tips and limits

- Each AWS account in Infrawrench uses one region for defaults. Add more accounts if you work across regions.
- STS assume-role isn't supported yet. Use a dedicated IAM user for now.
- Rate limits (especially on EC2 describe APIs) can slow very large accounts. The sidebar refreshes every 30 seconds, which is usually fine.

## Cost graphs

AWS accounts feed [cost graphs and budgets](../features/cloud-costs.md) from Cost Explorer. Costs are collected daily and broken down by service, region and [charge type](../features/cloud-costs.md#charge-types-and-cash-vs-amortized), on both a cash and an [amortized](../features/cloud-costs.md#cash-amortized-and-blended) basis.

- The IAM user needs `ce:GetCostAndUsage`. It isn't part of typical read-only policies, so add a small policy for it. Charge types and amortized cost need no extra permission.
- AWS charges **$0.01 per Cost Explorer request**. A normal day costs 3 to 6 requests, and the one-time 365-day backfill about 39. That's well under a dollar a month per account.
- Per-resource cost breakdown isn't collected (Cost Explorer keeps it for only 14 days).

### Charge types

Each cost row has a charge type. Here's how AWS record types map to what you see:

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

A few things to know:

- **Rows that aren't usage have no region.** Taxes, credits, support fees and reservation fees appear under their service with the region blank. Cost Explorer reports most of them without a region anyway.
- **Usage covered by a Reserved Instance or Savings Plan is still usage**, shown as its own charge type. That's what the [Commitments](../features/commitments.md) coverage figure uses. `SavingsPlanNegation` is the actual Savings Plan discount. Reserved Instances have no equivalent line.
- **`Fee` counts as a commitment fee.** AWS mostly uses it for the upfront fee on an All Upfront or Partial Upfront RI, though it occasionally covers other subscriptions.
- **AWS discount programs show as "Other".** An Enterprise Discount Program or private-rate discount isn't a credit, and Infrawrench has no charge type for negotiated discounts.

![Cost graph for an AWS account grouped by Charge type, showing a usage band with smaller commitment fee, tax and credit bands stacked on it](https://agent-assets.infrawrench.com/docs-screenshots/plugins/aws/cost-graph.png)

### List prices for re-rating invoices

On-demand usage is billed at AWS's public rate, with negotiated discounts on their own lines, so it's used as the list price when a [managed account](../features/managed-accounts.md#re-rating-to-public-pricing) is re-rated to public pricing. Spot usage is re-rated at the Spot price it ran at. Usage covered by a reservation or Savings Plan has no on-demand figure, so it uses the customer's uplift instead. No extra permission is needed.

### Blended commitment discounts

AWS accounts also report the [blended cost basis](../features/cloud-costs.md#blended). For reservation-covered hours, this needs the **`ce:GetReservationUtilization`** permission on top of `ce:GetCostAndUsage`. Without it, collection still works, and only reservation-covered services show as amortized on the blended basis. The extra Cost Explorer requests are only made on days with covered usage.

### Amortized cost

Amortized cost comes at no extra cost. It matters most for reservations: on a cash basis, AWS prices RI-covered usage at zero, so a reserved fleet looks free and the reservation looks like pure expense. Amortized cost shows what those hours are actually worth.

That's also why commitment coverage, utilization and the savings planner use amortized figures only. On cash figures, covered hours cost nothing, so coverage would read 0% for any account that has bought a commitment.

### Costs aren't linked to individual commitments

Cost rows aren't linked to the specific reservation or Savings Plan they belong to, because AWS's cost API can't group by it. The [Commitments](../features/commitments.md) section lists what you own and what it cost, and cost graphs show commitment fees, discounts and covered usage as their own charge types. But you can't see which Savings Plan paid for a given hour.

### Days collected by older versions

Nothing is required of you. Older days are corrected automatically as they're re-collected. The [restatement window](../features/cloud-costs.md) refreshes the last few days on its own. To refresh your whole history, clear the account's backfill marker so the next cost pass re-collects all 365 days (about 39 requests, about $0.39).

Earlier docs described a manual `ALTER TABLE cost_daily DELETE`. Don't run it. It's no longer needed.

## Commitments

AWS accounts feed the [Commitments](../features/commitments.md) section with **EC2 Reserved Instances**, **RDS Reserved Instances** (per region) and **Savings Plans**, refreshed daily. Expired and queued ones are included.

- Add `ec2:DescribeReservedInstances`, `rds:DescribeReservedDBInstances` and `savingsplans:DescribeSavingsPlans` alongside `ce:GetCostAndUsage`.
- A Compute Savings Plan shows "All regions". That's accurate: it follows your compute wherever it runs.
- Savings Plans' recurring payment isn't shown, because AWS doesn't say what period the figure covers.
- Cost rows aren't linked to an individual reservation or plan. See [above](#costs-arent-linked-to-individual-commitments).

## Network costs

AWS can feed [network costs](../features/network-costs.md), which show priced traffic from source to destination using **VPC Flow Logs**.

- Needs `ec2:DescribeFlowLogs`, `ec2:DescribeNetworkInterfaces`, `logs:StartQuery` and `logs:GetQueryResults`.
- **It's off until an org admin turns it on.** CloudWatch Logs Insights bills each scan to your account per GB, and busy VPC flow logs are large.
- Only flow logs delivered to **CloudWatch Logs** can be read. S3 or Firehose destinations are listed but can't be queried.
- Use a **custom** record format with at least `srcaddr`, `dstaddr`, `bytes` and `flow-direction`. The default format (version 2) doesn't include `flow-direction`. Also add `az-id`, `instance-id`, `traffic-path`, `interface-type` and `pkt-dst-aws-service` so addresses can be matched to resources.
- Flows are read for the credential's **own region only**, since each region is a separate log group and a separate charge.

Cross-AZ transfer is priced at $0.01/GB **in each direction**, matching how AWS bills both ends.

## Vulnerability findings

AWS accounts show the open CVEs **Amazon Inspector** has found in every enabled region.

- Needs `inspector2:ListFindings`, and Inspector activated (with ECR, Lambda standard or EC2 scanning) in the regions you use. AWS bills Inspector per scanned resource. Reading findings costs nothing extra.
- Only **active package vulnerability** findings are shown. Suppressed and closed findings, network reachability findings and Lambda code scanning findings are left out.
- **ECR images** are shown by pull reference (`<account>.dkr.ecr.<region>.amazonaws.com/<repository>`) and digest, so a finding links to every running workload that pulls that image, on any connected provider (Kubernetes pods, Cloud Run, Container Apps).
- **Lambda functions** and **EC2 instances** link directly to their Lambda and EC2 resources.
- Regions that refuse the read (Inspector not activated, or a service control policy denies it) are skipped. If every region refuses, you'll see a permission or setup prompt instead of an empty list.
- Findings are capped per region, most severe first, so a very large estate may show only some of its lowest-severity findings.

## AI spend by caller

Bedrock lines on the bill carry the `ai:provider` tag (and `ai:model` for Marketplace editions such as "Claude 3.5 Sonnet (Amazon Bedrock Edition)"). Three [AI attribution](../features/ai-attribution.md) sources read per-request logs through this account:

- **Bedrock invocation logs (S3)**: the log objects under `AWSLogs/<account>/BedrockModelInvocationLogs/<region>/YYYY/MM/DD/`. Needs `s3:ListBucket` and `s3:GetObject` on the bucket.
- **Bedrock invocation logs (CloudWatch Logs)**: one Logs Insights query per day, billed to your account per GB scanned. Needs `logs:StartQuery`, `logs:GetQueryResults` and `logs:StopQuery`.
- **Custom request logs (JSONL in S3)**: the documented JSONL format under a prefix you choose.

All three need `bedrock:GetModelInvocationLoggingConfiguration` to preselect the bucket or log group Bedrock writes to. Tag requests with the Converse `requestMetadata` field or the `X-Amzn-Bedrock-Request-Metadata` header. Logs are read for the credential's own region.

## Dependency graph

The [dependency graph](../features/dependency-graph.md) draws your VPC wiring exactly. EC2 instances link to their VPC, subnet and security groups. Subnets, security groups, load balancers, target groups, NAT gateways and internet gateways link to their VPC. These links appear as soon as the account syncs, with nothing to set up.

**DB subnet groups** are listed as their own resource. Aurora, DocumentDB and Neptune clusters link to their DB subnet group, which links to its VPC and each subnet it spans. Open the group to see every database that shares it.

![Dependency graph showing an Aurora cluster linked to a DB subnet group, which fans out to a VPC and two subnets](https://agent-assets.infrawrench.com/docs-screenshots/plugins/aws/dependency-graph-aurora-subnet-group.png)
