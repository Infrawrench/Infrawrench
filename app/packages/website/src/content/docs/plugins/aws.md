---
title: AWS
description: Manage EC2, EKS, RDS, Lambda, S3, and most of the AWS surface area.
sidebar_order: 1
---

The AWS plugin covers the services most teams live in day to day.

## What you can manage

- **Compute** — EC2 instances, Auto Scaling Groups, Lambda functions, ECS services.
- **Kubernetes** — EKS clusters (links to the [Kubernetes plugin](./kubernetes.md) for pod-level access).
- **Databases** — RDS (Postgres, MySQL, MariaDB, SQL Server, Oracle), Aurora, Redshift, DynamoDB, ElastiCache (Redis / Memcached).
- **Storage** — S3 buckets, EBS volumes, EFS file systems.
- **Networking** — VPC, Subnets, Security Groups, Internet / NAT Gateways, Elastic IPs, Load Balancers, API Gateway, CloudFront.
- **Messaging** — SQS, SNS.
- **Secrets & identity** — Secrets Manager, IAM users / roles / policies, KMS keys.
- **CI/CD** — CodeBuild, CodePipeline, Step Functions, Glue, CloudFormation stacks.

## Credentials

Generate an access key pair in the AWS console (**IAM → Users → Security credentials → Create access key**) for a user with the permissions you need. Paste:

- **Access key ID**
- **Secret access key**
- **Default region**

<insert [AWS Add-account form with access key / secret / region fields] here>

Use least-privilege policies. For read-only browsing, the `ReadOnlyAccess` managed policy is usually enough; for creating resources, you need the matching write permissions.

## Notable flows

- **SSH terminal** on EC2 instances — [SSH terminal](../features/ssh-terminal.md).
- **SQL editor** on RDS and Aurora — [SQL editor](../features/sql-editor.md).
- **File browser** on S3 — [File browsers](../features/file-browsers.md).
- **Document browser** on DynamoDB tables — scan items, edit/insert/delete documents inline.
- **DynamoDB schema & indexes tab** — view the primary key, attribute definitions, and existing global/local secondary indexes on a table. Add or delete GSIs from the same page; LSIs are creation-only (DynamoDB rule). The create form also accepts an optional `secondaryIndexesJson` blob so you can declare GSIs and LSIs up front.
- **Secret export to K8s** is supported for RDS, Aurora, Redshift, ElastiCache, S3, Lambda, SQS, SNS, DynamoDB, ECS, EKS — [Secret export](../features/secret-export-to-kubernetes.md).
- **Read-only manifest view** for most resources.

<insert [DynamoDB detail page showing the Schema & indexes tab with a primary key section, an attribute definitions table, and a GSI pill with status / keys / projection / throughput stats] here>

<insert [DynamoDB Create resource form with the optional "Secondary indexes (optional)" textarea expanded showing an example JSON value] here>

## Tips & limits

- Each AWS account in infrawrench is tied to one region for defaults — add multiple accounts if you operate across regions.
- STS assume-role is not yet supported; use a dedicated IAM user for now.
- Rate limits (especially EC2 describe APIs) can slow down very large accounts. Sidebar refresh is 30s; that is usually fine.
