---
title: Exoscale
description: Manage Exoscale instances, block storage, snapshots, private networks, security groups, elastic IPs, SKS Kubernetes, load balancers, DBaaS, DNS and SOS buckets, with billed spend, quotas and the organization balance.
sidebar_order: 6
---

Infrawrench talks to the Exoscale API v2 with an IAM API key and its secret, in every zone your organization can use. Billed spend comes from Exoscale's monthly FOCUS billing report, and the resources below can be listed, created, edited and acted on without leaving the app.

## What you can manage

- **Compute instances**: create with a zone, an instance type, a template (public or your own), a disk size, an SSH key, cloud-init user data, security groups, a private network and a public IPv4 or dual-stack address. Start, stop, reboot, change the type (on a stopped instance), grow the disk, take and revert snapshots, reinstall from a template, protect against deletion, and detach security groups, elastic IPs and private networks. Edit the name and labels. SSH straight in from the instance page.
- **Block storage**: create volumes (optionally attached to an instance right away), grow and rename them, attach and detach (or drag a volume onto an instance in the same zone), and take snapshots.
- **Snapshots and templates**: instance snapshots and volume snapshots are listed with their source; turn a snapshot into a private template, rename and delete templates.
- **Private networks**: create unmanaged or managed (DHCP) networks, edit the range and description, and attach them to instances.
- **Security groups**: create with preset rules (SSH, HTTP/HTTPS, ping), add and remove rules from the group page, and attach groups to instances. Groups that open ports other than HTTP and HTTPS to the whole internet are flagged.
- **Elastic IPs**: reserve, describe, add a health check, and attach to an instance (or drag onto one).
- **SKS Kubernetes**: create clusters with a version, a Starter or Pro control plane, a CNI and add-ons; add, resize and delete node pools; upgrade Kubernetes or move to Pro; download an admin kubeconfig. The cluster page opens the Kubernetes tab directly.
- **Network load balancers**: create, rename, and add or remove services that forward a port to an instance pool, with TCP or HTTP health checks. Instance pools can be resized and edited.
- **DBaaS** (PostgreSQL, MySQL, Valkey and the other engines): create with an engine, a plan, allowed IPs, a maintenance window and termination protection; edit the plan, allowed IPs, maintenance window and protection; start maintenance now; reveal a user's password; read the service logs. Users and logical databases are child resources. The service page opens a PostgreSQL, MySQL or Valkey tab with the connection filled in.
- **DNS**: create domains and records; edit records. Records pointing at buckets nobody owns are flagged.
- **SOS object storage**: create buckets in any zone and browse, upload, create folders and delete objects with the account's own key.
- **SSH keys and anti-affinity groups**: register, list and delete.
- **Organization**: the organization name, currency and live balance.

<insert [Exoscale account page showing Compute Instances, Block Storage, SKS Clusters, DBaaS Services and SOS Buckets across several zones] here>

## Credentials

In the [Exoscale Portal](https://portal.exoscale.com) open **IAM**, then **API Keys**, and create a key with a role. The secret is shown once. The role decides what Infrawrench sees: allow the `compute`, `dbaas`, `dns` and `sos` services, and billing access for costs. Click **Check credentials** after adding the account to see what the key can reach.

<insert [Add account dialog for Exoscale with the API Key and API Secret fields and the credential check results] here>

## Costs, quotas and balance

- Spend comes from the monthly FOCUS billing report: one row per day per service, zone, resource and tag set, with taxes and credits marked. The current month is restated as it accrues.
- Organization quotas (instances, GPUs, elastic IPs, SKS clusters, DBaaS services, snapshots and more) are tracked with Exoscale's own usage figures.
- The organization's live balance feeds the credit view.

## Metrics

DBaaS services chart CPU, memory, disk, load, disk I/O and network over the window you pick.

## Status

Incidents and maintenance from [exoscalestatus.com](https://exoscalestatus.com) are matched to your resources by zone and product.

## Terraform

Instances, volumes, private networks, security groups, elastic IPs, SKS clusters and node pools, load balancers, instance pools, DBaaS services, DNS domains and records, SSH keys and anti-affinity groups export to the official `exoscale/exoscale` provider. Instances export without their template id unless it is known; set it before applying. Volumes and DBaaS services have no documented import id, so they export without one.

## Limits

- The FOCUS billing report is marked beta in the Exoscale API; if Exoscale delivers it as Parquet, costs report a setup error.
- Private networks' static leases, security group external sources, IAM roles and keys, DBaaS integrations and connection pools, SOS bucket policies and the AI services are not covered yet.
