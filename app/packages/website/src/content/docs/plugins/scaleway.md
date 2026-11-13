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

Every region and zone is covered, including Milan (`it-mil`). Its first zone, `it-mil-1`, opened in March 2026 and is read for every product. Block Storage volumes are also read and can be created in `it-mil-2` and `it-mil-3`, which opened in October 2026. Instances and flexible IPs follow once Scaleway's Instance API lists those zones. Products Scaleway doesn't offer in a location are skipped there.

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

## Run CI jobs

A Scaleway connection can run [Infrawrench CI](../features/ci.md) cloud jobs once an organization admin opts it in. Each job gets fresh compute in the job's `cloud.region` (`fr-par-1` for an Instance, `fr-par` for a job when it names none), started with the job's bootstrap as cloud-init user data or a container's command, and deleted when the job ends:

| `cloud.kind` | Runs on                                            | Default `machine` | Default `image`                               |
| ------------ | -------------------------------------------------- | ----------------- | --------------------------------------------- |
| `vm`         | An Instance with a 20 GB Block Storage root volume | `PLAY2-NANO`      | `ubuntu_noble`                                |
| `container`  | A Serverless Jobs run                              | `2vcpu-4gb`       | `docker.io/library/buildpack-deps:noble-curl` |

A Serverless Jobs `machine` is `<vCPUs>vcpu-<GiB>gb`, at most 6 vCPUs and 16 GB, and a job runs at most 24 hours. Its image must be `linux/amd64`; Docker Hub images work, within Docker Hub's rate limits.

Neither holds Scaleway credentials. An Instance gets cloud-init user data and a dynamic address that goes with it; note that Scaleway adds the project's SSH keys to every Instance. A job run gets the bootstrap as its arguments and nothing else.

As a backstop an Instance powers itself off when the job's time is up, which ends its compute bill; its root volume is billed until Infrawrench deletes it at the end of the job, or its cleanup later finds the Instance by tag. Instances are billed by the hour. A job run ends at the job's timeout and is billed by the second.

Opting in reads the key's application in IAM and names missing permission sets: `InstancesFullAccess` and `BlockStorageFullAccess` for `vm`, `ServerlessJobsFullAccess` for `container` (`AllProductsFullAccess` covers both). Reading them needs `IAMReadOnly`; without it, or for a user's key, the check falls back to reads. If the connection has no Default Project ID, jobs run in the key's own default project.

## Tips & limits

- Resources belong to a Project. Pick the default when you add the account.
- You can export Kapsule kubeconfigs to the [Kubernetes plugin](./kubernetes.md) through an output reference.

## Cost graphs

Scaleway projects feed [cost graphs & budgets](../features/cloud-costs.md) with monthly billing periods broken down by product, resource and project.

- The API key's IAM principal needs the **BillingReadOnly** permission set.
- Costs only cover the account's default project, so organization-level discounts aren't included.
