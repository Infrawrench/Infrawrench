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

## Notable flows

- **SSH terminal** on Linux EC2 instances — [SSH terminal](../features/ssh-terminal.md).
- **Remote Desktop (RDP)** on Windows EC2 instances — [Remote Desktop](../features/remote-desktop.md).
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

AWS accounts feed [cost graphs & budgets](../features/cloud-costs.md) via Cost Explorer (`GetCostAndUsage`), collected daily with service and region breakdowns.

- The IAM user needs the `ce:GetCostAndUsage` action — it is **not** part of typical read-only policies, so add a small policy for it.
- AWS charges **$0.01 per Cost Explorer request**. Infrawrench fetches once a day (plus a one-time history backfill in month-sized chunks), so expect a few cents per month per account.
- Per-resource cost breakdown is not collected (Cost Explorer only retains it for 14 days).

## Dependency graph

The VPC wiring is declared, so the [dependency graph](../features/dependency-graph.md) draws it exactly rather than inferring it: EC2 instances link to their VPC, subnet and security groups, and subnets, security groups, load balancers, target groups, NAT gateways and internet gateways link to their VPC. These arrows appear as soon as the account syncs — nothing to wire by hand.

**DB subnet groups** are listed as their own resource so database clusters reach the network. AWS reports a cluster's placement as nothing but the subnet group's name, so Aurora, DocumentDB and Neptune clusters link to their **DB subnet group**, and the group in turn links to its **VPC** and each **subnet** it spans. Opening the group shows every database sharing that placement.

<insert [Dependency graph showing an Aurora cluster linked to a DB subnet group, which fans out to a VPC and two subnets] here>
