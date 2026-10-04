---
title: MongoDB Atlas
description: Track MongoDB Atlas spend by service, project and cluster, and manage projects, clusters, database users, the IP access list, backups, alerts, search indexes, online archives and private endpoints.
sidebar_order: 52
---

This plugin connects to an Atlas **organization** through the Atlas Administration API. It is separate from the [MongoDB](./mongodb.md) plugin, which connects to one database with a connection string; an Atlas cluster opens its data in that plugin instead of duplicating it (see [Browse a cluster's data](#browse-a-clusters-data)).

## What you can manage

- **Organization**: this month's pending invoice by service, by project and by cluster, the last few invoices, and a chart of daily charges.
- **Projects**: name (editable), cluster count and tags. **+ Add IP access entry** from the project page.
- **Clusters** (dedicated, plus free M0 clusters): tier, cloud, region, MongoDB version, node and shard count, storage, auto-scaling, backup and connection strings.
  - **Pause** and **Resume**. Pausing is also available as the stop action of [sleep/wake schedules](../features/sleep-schedules.md).
  - **Scale tier**: a picker of the tiers Atlas offers in the cluster's region.
  - **Edit**: tier, storage, compute and storage auto-scaling, termination protection.
  - **Take snapshot**: an on-demand snapshot with its own retention.
  - **Metrics**: connections, query/insert/update/delete/getmore/command rates, CPU, memory, disk read and write IOPS, replication lag, network in and out, and query targeting.
- **Flex clusters**: region, storage and connection string; edit termination protection.
- **Serverless instances** (legacy): listed with their connection strings while MongoDB migrates them to Flex.
- **Database users**: create one with a role (optionally limited to one cluster), edit its roles and description, or delete it.
- **IP access list**: add an address, CIDR block or temporary entry, edit its comment, or remove it.
- **Backup snapshots**: list, take on demand and delete; **backup policies**: retention per frequency, the next snapshot, and editable snapshot time and restore window.
- **Alerts**: open alerts with their metric and current value; **Acknowledge** for a while or clear the acknowledgement. **Alert configurations**: enable, disable or delete.
- **Atlas Search and Vector Search indexes**: status and namespace; delete.
- **Online archives**: what they archive and their state; pause, resume or delete.
- **Private endpoint services** (AWS PrivateLink, Azure Private Link, Google Private Service Connect) with their endpoints; delete.

## Credentials

Atlas offers two kinds of programmatic credential, and the plugin accepts either in the same two fields:

- **Service account** (recommended by MongoDB): in Atlas open **Organization Access Manager**, then **Applications**, **Service Accounts**, and create one. Copy the **client ID** (`mdb_sa_id_…`) and the **client secret** (`mdb_sa_sk_…`).
- **Programmatic API key**: paste the **public key** and the **private key**.

Give it **Organization Read Only** and **Organization Billing Viewer** to see everything including costs. To pause, scale, snapshot, or change users and the access list, it also needs **Project Owner** (or Project Cluster Manager plus Project Database Access Admin) on those projects.

After the two fields are filled, the **Organization** picker lists the organizations the credential can see. A service account belongs to one organization, so it is picked for you.

<insert [MongoDB Atlas Add-account form with the client ID and secret filled in and the Organization picker showing the organization] here>

If your organization requires an **API access list** for programmatic access, add the address Infrawrench calls Atlas from (your own address for the desktop app, or the address shown under the account's bastion settings for the cloud app).

## Cost graphs

Atlas accounts feed [cost graphs & budgets](../features/cloud-costs.md) with **billed** daily costs from your invoices: the pending invoice for the current month and the closed invoices before it.

- **Service** is the Atlas billing category of each line item's SKU: Clusters, Storage, Backup, Data Transfer, Serverless Instances, Atlas Data Federation, BI Connector, App Services, Premium Features, Support, Credits and so on.
- **Resource** is the cluster, so a cluster's spend shows on its own page and in the dependency views.
- **Tags** carry the project (`project`, `projectId`), the cluster, the SKU, the cloud, and every Atlas resource tag on the line item (`tag:<key>`), so [showback and allocation](../features/tag-policy-and-showback.md) rules can split by any of them.
- Amounts are net of line-item discounts. Credits and support charges are marked with their charge type, and sales tax on a closed invoice lands on the invoice's last day.
- Up to two years of history is read when the account is added, and the current and previous month are re-read on every collection, because the pending invoice changes daily and a month's invoice closes a few days after it ends.

## Browse a cluster's data

A cluster's **MongoDB** tab opens its databases and collections in the [MongoDB](./mongodb.md) plugin. Atlas never returns a database user's password, so the first time the tab asks you to **Create connection user**: Infrawrench creates a user scoped to that cluster (read only, or read and write) with a generated password, and keeps the password encrypted. The same user backs the **MONGODB_URI** secret export when you drag the cluster onto a Kubernetes cluster or server.

The project's IP access list must allow the address Infrawrench connects from. Clusters reachable only through private endpoints or peering cannot be browsed from here.

## Savings and checks

- **Oversized clusters** ([potential savings](../features/orphan-finder.md)): dedicated clusters whose CPU and memory stay low are suggested a smaller tier of the same class. Atlas has no price API, so savings use the hourly rates on your own recent invoices, per node; a tier your organization has never been billed for is not suggested.
- **Potential savings** also lists paused clusters (storage and backups are still billed, and Atlas resumes a cluster after 30 days), orphaned online archives, and private endpoint services with no endpoint.
- **[Posture checks](../features/posture-checks.md)** flag clusters with backup or termination protection off, `0.0.0.0/0` on the access list, and database users with `atlasAdmin`.
- **[Backup coverage](../features/backup-coverage.md)** counts each cluster's snapshots, and temporary users and access list entries appear on the [expiry radar](../features/expiry-radar.md).

## Tips & limits

- Atlas for Government (`cloud.mongodbgov.com`) is not supported.
- Alerts list only open alerts; closed alerts stay in Atlas.
- Snapshots, backup policies and online archives are listed for running dedicated clusters only; search indexes for every running cluster.
- Creating and deleting clusters is left to Atlas, where the full topology (regions, node counts, shards) is configured.
- [Export to Terraform](../features/terraform-export.md) writes projects, IP access list entries and Flex clusters as `mongodbatlas_project`, `mongodbatlas_project_ip_access_list` and `mongodbatlas_flex_cluster` resources.
