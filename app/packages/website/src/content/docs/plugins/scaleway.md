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
- Secret Manager secrets (names, paths and version counts only; secret values are never read)

Every region and zone is covered, including Milan (`it-mil`, zone `it-mil-1`), which opened in March 2026. Products Scaleway doesn't offer in a location are skipped there.

## Connect your account

In the Scaleway Console, go to **Identity and Access Management > API keys > Generate API key**. Then paste:

- **Access Key** and **Secret Key**: from the generated API key.
- **Default Project ID**: the project to manage.
- **Cockpit Query Token** (optional): a Cockpit token with metrics query access (and logs query access for Logs tabs), from **Observability > Tokens**.

![Scaleway Add-account form with access / secret / project fields](https://agent-assets.infrawrench.com/docs-screenshots/plugins/scaleway/add-account.png)

## Things you can do

- **SSH terminal** on Compute instances.
- **SQL editor** on RDB (through an output reference).
- **File browser** on Object Storage.
- **Attach block volumes** to instances in the same zone.
- **Pick a zone or region** when you create a resource.
- **Instance actions**: power on and off, reboot, stop in place, and back up (snapshots every volume into a new image).
- **Metrics**: Managed RDB charts CPU, memory, disk usage and connections (per node on HA and replica setups). With the optional Cockpit query token, instances chart CPU and network, Kapsule charts nodes, pods and API server load, and Serverless Functions and Containers chart CPU, memory usage and utilization, and running instances.
- **Logs** on Serverless Functions, Serverless Containers and Managed RDB. Needs the Cockpit token with logs query permission as well as metrics.
- **Right-sizing** for instances, based on their CPU (needs the optional Cockpit query token). Scaleway only changes an instance's type while it's stopped.
- **Create a Managed RDB database**: the form only lists engine versions and node types Scaleway currently offers. Automatic backup status and retention are shown and count toward backup coverage.
- **Kapsule** shows whether an upgrade is available. Upgrading updates the control plane and every pool. Changing the node count resizes the first pool.
- **DNS**: create and edit one record at a time. Leave the name empty (or `@`) for the zone apex.
- A public Container Registry namespace is flagged on the security posture page.

## Tips & limits

- Resources belong to a Project. Pick the default when you add the account.
- You can export Kapsule kubeconfigs to the [Kubernetes plugin](./kubernetes.md) through an output reference.

## Cost graphs

Scaleway projects feed [cost graphs & budgets](../features/cloud-costs.md) with monthly billing periods broken down by product, resource and project.

- The API key's IAM principal needs the **BillingReadOnly** permission set.
- Costs only cover the account's default project, so organization-level discounts aren't included.
