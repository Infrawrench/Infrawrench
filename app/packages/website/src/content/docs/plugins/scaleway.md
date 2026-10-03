---
title: Scaleway
description: Manage Scaleway Instances, Kapsule, managed RDB, Object Storage, Block Storage, Load Balancers, networking, Serverless, Container Registry, DNS and Secret Manager.
sidebar_order: 6
---

## What you can manage

- Compute instances (edit to rename, change the commercial type, toggle delete protection or set tags)
- Kapsule clusters (managed Kubernetes; edit to upgrade the Kubernetes version or resize)
- Managed RDB (Postgres / MySQL; edit to rename, move to a bigger node type or grow the volume)
- Object Storage (S3-compatible)
- Block Storage volumes
- Flexible IPs (create, attach to an instance in the same zone, edit reverse DNS and tags)
- Load Balancers (create with a type picker; edit name, description, tags and TLS compatibility level)
- VPC Private Networks (create with optional subnets; rename)
- Serverless Containers (edit image, scaling and limits; redeploy)
- Serverless Functions (edit handler, scaling and memory; deploy)
- Container Registry namespaces (create; edit description and visibility)
- DNS zones and records (Scaleway Domains and DNS)
- Secret Manager secrets (metadata only: names, paths, version counts; secret values are never read)

Every region and zone is covered, including Milan (`it-mil`, zone `it-mil-1`), which opened in March 2026. Products Scaleway does not offer in a location are skipped there.

## Credentials

Scaleway Console → **Identity and Access Management → API keys → Generate API key**. Paste:

- **Access Key** and **Secret Key** — from the generated API key.
- **Default Project ID** — the project resources will be scoped to.
- **Cockpit Query Token** (optional): a Cockpit token with metrics query access (and logs query access for Logs tabs), from **Observability → Tokens**.

![Scaleway Add-account form with access / secret / project fields](https://agent-assets.infrawrench.com/docs-screenshots/plugins/scaleway/add-account.png)

## Notable flows

- **SSH terminal** on Compute instances.
- **SQL editor** on RDB (via output reference).
- **File browser** on Object Storage.
- **Block volume attachment** to instances in the same zone.
- Zone / region picker on resource creation.
- **Instance actions**: power on/off, reboot, stop in place, and back up (snapshots every volume into a new image).
- **Metrics**: Managed RDB charts CPU, memory, disk usage and connections (per node on HA and replica setups) straight from the RDB API. With the optional Cockpit query token, instances chart CPU and network, Kapsule charts nodes, pods and API-server load, and Serverless Functions and Containers chart CPU, memory usage and utilization, and running instances.
- **Logs** on Serverless Functions, Serverless Containers and Managed RDB, tailed from Cockpit's Scaleway logs data source. Needs the Cockpit token with the logs query permission as well as metrics.
- **Right-sizing** for instances, driven by the Cockpit CPU series (needs the optional Cockpit query token). Scaleway only changes an instance's type while it is stopped.
- **Managed RDB create form** lists the engine versions and node types the API currently offers, so retired versions and out-of-stock node types never appear. Automatic backup status and retention are shown and count towards backup coverage.
- **Kapsule** shows whether an upgrade is available. Upgrading upgrades the control plane and every pool; changing the node count resizes the first pool.
- **DNS** records are created and edited one record at a time; leave the name empty (or `@`) for the zone apex.
- A public Container Registry namespace is flagged on the security posture page.

## Tips & limits

- Resources are scoped to a Project; pick the default at account add-time.
- Kapsule kubeconfigs can be exported to the [Kubernetes plugin](./kubernetes.md) via output reference.

## Cost graphs

Scaleway projects feed [cost graphs & budgets](../features/cloud-costs.md) from the Billing consumption API — monthly billing periods broken down by product, resource, and project.

- The API key's IAM principal needs the **BillingReadOnly** permission set.
- Collection is scoped to the account's configured default project, so org-level discounts (only visible unscoped) are not captured.
