---
title: Qdrant Cloud
description: Manage Qdrant Cloud clusters, database API keys, backups, backup schedules, hybrid cloud environments and collections, with billed spend, credits, quotas, metrics, logs and alerts.
sidebar_order: 51
---

Qdrant Cloud runs managed Qdrant vector database clusters on AWS, GCP and Azure, or on your own Kubernetes through Hybrid Cloud. Use this plugin to manage your clusters, their backups and keys, and the collections inside them.

## What you can manage

- **Clusters**: status, cloud and region, Qdrant version, nodes up, the resource package with vCPU, RAM and disk per node, extra disk, storage tier, allowed IP ranges, labels, endpoints, and per-node health.
  - Create a cluster by picking a region and a package from a list with prices shown.
  - Edit the node count, Qdrant version (the detail page lists the releases you can move to), extra disk, storage tier, allowed IP ranges, labels, default replication and write consistency, vectors on disk, cloud inference, audit logging, restart policy and shard rebalancing.
  - **Resize** switches the package. **Suspend** and **Resume** stop and start compute billing. **Restart** restarts every node. **Enable JWT RBAC** turns on fine-grained keys.
  - Firing alerts (disk or memory pressure, out-of-memory, recovery mode, unsupported version) show on the cluster page.
- **Database API keys**: every key with its cluster, access (global manage, global read-only, or one collection), creator and expiry. Create a key with any of those access levels and an optional expiry. A key you create in Infrawrench keeps its value as a sensitive output. Expiring keys appear on the [expiry radar](../features/expiry-radar.md).
- **Backups**: status, cluster, schedule, retention, and what the backup costs per month to keep. Back up any cluster on demand, rename a backup, restore it into its cluster, restore it as a new cluster, or delete it.
- **Backup schedules**: cron schedule and retention per cluster. Create one from presets (daily, every 6 hours, hourly, weekly) or a custom cron expression, and change the schedule, retention or name later.
- **Backup restores**: progress of every restore.
- **Hybrid cloud environments**: Kubernetes version and distribution, node count, readiness, namespace. Create and rename environments, and use **Generate bootstrap commands** to get the kubectl and helm commands that connect your Kubernetes cluster (kept as a sensitive output).
- **Collections**: points, indexed vectors, segments, vector size and distance, shards and replication. Create a collection, change its replication factor and write consistency, or delete it.

### See a cluster's collections

Collections need a database API key, not the management key. Run **Connect Infrawrench** on a cluster once. It creates a database key named `infrawrench` with manage access and stores it encrypted in Infrawrench. The same key fills the cluster's **Database API Key** output, and the **Qdrant environment variables** export writes `QDRANT_URL` and `QDRANT_API_KEY` into a Kubernetes secret or a server's environment.

## Connect your account

- **Cloud Management Key**: in the Qdrant Cloud console, open **Access Management**, then **Cloud Management Keys**, and create a key. Its role needs read and write access to clusters, backups, database API keys and hybrid cloud environments. Add `read:payment_information` for costs and credits. A database API key won't work here.
- **Account**: pick it from the accounts the key can see.

<insert [Qdrant Cloud Add-account form with the management key entered and the account picker open] here>

## Costs, credits and quotas

You see the same spend as Qdrant's billing page: one row per cluster and billable item (cluster nodes, extra disk, storage tier, backups, inference tokens), after discounts, tagged with the cluster's labels.

Prepaid credit contracts appear on the [credit burndown](../features/credit-burndown.md) page with what's left. The account's cluster limit, the per-cluster node limit and the per-cluster database key limit appear on the [quota radar](../features/quota-radar.md).

<insert [Cost explorer filtered to a Qdrant Cloud account, grouped by service] here>

## Metrics, logs and status

Clusters have a **Metrics** tab with CPU, RAM (total, cache, RSS and Qdrant's own RSS), disk, requests per second and request latency, plus GPU and GPU RAM on GPU clusters. The **Logs** tab shows the last day of database logs.

Qdrant Cloud's [status page](https://status.qdrant.io) feeds [provider status](../features/provider-status.md). A region incident shows next to the clusters there, and a Cloud API or Cloud UI incident shows against the whole account.

You can put clusters on a [sleep schedule](../features/sleep-schedules.md): stopping suspends them, starting resumes them.

<insert [Qdrant Cloud cluster detail page showing nodes, firing alerts and the Resize action] here>

## Terraform

You can [export to Terraform](../features/terraform-export.md) clusters, backup schedules and hybrid cloud environments for the official `qdrant/qdrant-cloud` provider, with import ids. Labels and extra disk are added as comments for you to fill in by hand.

## Limits and quirks

- Disks only grow. Extra disk can't be reduced, and Qdrant refuses a downscale that wouldn't fit your stored data.
- Qdrant shows a database key's value once. Keys created in the console are listed, but their values aren't available here.
- Collection-scoped database keys need JWT RBAC turned on for the cluster.
- Hybrid cloud clusters use whatever endpoint your Kubernetes exposes. Their collections only show if Infrawrench can reach that endpoint.
