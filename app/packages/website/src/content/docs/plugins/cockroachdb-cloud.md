---
title: CockroachDB Cloud
description: Manage CockroachDB Cloud clusters, databases, SQL users, IP allowlists, backups and restores, log and metric export, folders, service accounts and API keys, with invoice-based costs.
sidebar_order: 50
---

Connect a CockroachDB Cloud organization to manage its clusters on every plan (Basic, Standard and Advanced) and see what it bills you.

## What you can manage

- **Clusters**: plan, cloud, regions, version, state, SQL host, nodes, hardware and limits. Create Basic, Standard or Advanced clusters with cloud, region, vCPU, node and storage pickers. Edit delete protection, Advanced nodes per region, vCPUs per node, storage and disk IOPS, Standard provisioned vCPUs, Basic request-unit and storage limits, the upgrade mode, managed backups (on/off, frequency, retention), the patch upgrade deferral policy and the maintenance window. Actions: **Upgrade CockroachDB** (to a version CockroachDB Cloud offers), **Finalize upgrade** and **Roll back upgrade**, **Move to folder**, and **Enable Prometheus endpoint** on Advanced clusters. The detail page lists every node and its status.
- **Databases**: create, rename and delete.
- **SQL users**: create (with a password you choose or a generated one), change the password, and delete. Each user has a **Connection String** output and a **SQL** tab.
- **IP allowlist**: add, edit (name, SQL and DB Console access) and remove entries.
- **Backups** and **restore jobs**: list the managed backups, restore the whole cluster to one with **Restore cluster to this backup**, and follow restore progress.
- **Log export** (CloudWatch, Cloud Logging or OTLP) and **metric export** (Datadog, CloudWatch, Prometheus): set up, see delivery status, and remove.
- **Blackout windows** (Advanced): schedule, change and remove periods without patch upgrades.
- **Egress rules**: allowed outbound destinations for clusters with egress restricted.
- **Folders**: create, rename and delete.
- **Service accounts** and their **API keys**: create service accounts with organization roles, rename them, create keys (the secret is shown once) and delete them.

<insert [CockroachDB Cloud cluster detail page showing plan, regions, the Nodes table and the Access, Backups and Operations tabs] here>

## Connect your organization

Use a **service account API key**.

1. In CockroachDB Cloud, open **Organization > Access Management > Service Accounts** and create a service account.
2. Give it the roles you need:
   - `CLUSTER_ADMIN` (or `CLUSTER_OPERATOR_WRITER`) at the organization scope to manage clusters, databases, SQL users, allowlists, backups and exports
   - `BILLING_COORDINATOR` at the organization scope for cost data. The API reads invoices with `BILLING_COORDINATOR` or `CLUSTER_ADMIN`, not `BILLING_VIEWER`, which only shows billing in the console.
   - `ORG_ADMIN` to manage service accounts and API keys
3. Create an API key for the account and copy its secret (it starts with `CCDB1_`).

When you add the account, the permission checklist tests each capability.

<insert [CockroachDB Cloud Add-account form with the API Key field filled in and the permission checklist below it] here>

## Connect to a database as a SQL user

CockroachDB Cloud never returns a SQL user's password. If you create the user from Infrawrench, its password is stored encrypted and the connection string works straight away. For an existing user, use **Set password** on the SQL tab, or edit the user's password once.

Connection strings for Advanced clusters use `sslmode=require`, so you don't need a local certificate file.

## Costs

Invoices are collected monthly and dated to the start of each billing period. You get one row per cluster and line item (compute, storage, request units, data transfer…) with its quantity and unit. Credits and other adjustments show as credit rows. The current month's draft invoice updates as it changes.

Amounts billed in CockroachDB Cloud credits rather than US dollars aren't included, because the API doesn't give their value in money. The organization page shows your credit balance from the latest invoice.

## Metrics and logs

CockroachDB Cloud exports metrics and logs rather than letting you query them. Set up a metric export (Datadog, CloudWatch or a Prometheus endpoint) or a log export from the cluster's Operations tab, and view them in that tool.

## Status

Incidents from `status.cockroachlabs.cloud` are linked to your clusters by product (Basic/Standard, Advanced). The status page groups regions as US-1, EU-2 and so on, which don't name cloud regions, so incidents can't be narrowed to a single cluster region.

## Terraform

Clusters, databases, SQL users (with a write-only password variable), allowlist entries, folders and service accounts export to the official `cockroachdb/cockroach` provider with import ids.

## Limits

- You can set backup retention once. Later changes need a support ticket.
- Maintenance windows, blackout windows and CMEK apply to Advanced clusters only.
- Advanced storage can grow but not shrink.
- The API allows 10 requests a second per user.
