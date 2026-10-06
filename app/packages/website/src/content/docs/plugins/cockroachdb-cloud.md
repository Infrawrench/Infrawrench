---
title: CockroachDB Cloud
description: Manage CockroachDB Cloud clusters, databases, SQL users, IP allowlists, backups and restores, log and metric export, folders, service accounts and API keys, with invoice-based costs.
sidebar_order: 50
---

Connect a CockroachDB Cloud organization to manage its clusters on every plan (Basic, Standard and Advanced) and to collect what it bills.

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

## Credentials

Use a **service account API key**. In CockroachDB Cloud, open **Organization → Access Management → Service Accounts**, create a service account and give it the roles you need:

- `CLUSTER_ADMIN` (or `CLUSTER_OPERATOR_WRITER`) at the organization scope to manage clusters, databases, SQL users, allowlists, backups and exports,
- `BILLING_VIEWER` for cost data,
- `ORG_ADMIN` to manage service accounts and API keys.

Then create an API key for the account and copy its secret (it starts with `CCDB1_`). The permission checklist shown when you add the account tests each capability.

<insert [CockroachDB Cloud Add-account form with the API Key field filled in and the permission checklist below it] here>

## SQL users and connections

CockroachDB Cloud never returns a SQL user's password. Users created from Infrawrench have their password stored encrypted, so their connection string resolves straight away; for an existing user, use **Set password** on the SQL tab or edit the user's password once. Advanced-cluster connection strings are adjusted to `sslmode=require`, because the Cloud API's version points at a certificate file on your own machine.

## Costs

Invoices are collected monthly, dated to the start of each billing period, with one row per cluster and line item (compute, storage, request units, data transfer…) carrying the quantity and unit. Credits and other adjustments appear as credit rows. The current month's draft invoice is refreshed as it changes. Amounts billed in CockroachDB Cloud credits rather than US dollars are not included, because the API does not state their value in money; the organization page shows the credit balance from the latest invoice.

## Metrics and logs

The Cloud API has no metrics or log query endpoints: it exports them. Set up a metric export (Datadog, CloudWatch or a Prometheus endpoint) or a log export from the cluster's Operations tab, and view them in that tool.

## Status

Incidents from `status.cockroachlabs.cloud` are linked to your clusters by product (Basic/Standard, Advanced). The status page groups regions as US-1, EU-2 and so on, which do not name cloud regions, so incidents cannot be narrowed to a single cluster region.

## Terraform

Clusters, databases, SQL users (with a write-only password variable), allowlist entries, folders and service accounts export to the official `cockroachdb/cockroach` provider with import ids.

## Limits and quirks

- Backup retention can be set once; later changes need a support ticket.
- Maintenance windows, blackout windows and CMEK apply to Advanced clusters only.
- Advanced storage can grow but not shrink.
- The API allows 10 requests a second per user.
