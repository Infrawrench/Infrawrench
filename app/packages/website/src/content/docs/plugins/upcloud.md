---
title: UpCloud
description: Manage UpCloud servers, storage, backups, networks, floating IPs, Kubernetes, databases, load balancers and Object Storage, with billed spend per resource, prepaid credits and account limits.
sidebar_order: 6
---

Infrawrench talks to the UpCloud API 1.3 with an API token or an API user. Billed spend comes from UpCloud's monthly billing summary, and the resources below can be listed, created, edited and acted on without leaving the app.

## What you can manage

- **Servers**: create from any public or private template with a zone, a plan priced for that zone, a disk size, an SSH key, cloud-init user data, a private network, IPv6 and simple backups. Start, stop, force stop, restart, change the plan (on a stopped server), turn the firewall on or off, add and remove firewall rules, and attach storage. Edit the title, hostname, labels and backup plan. SSH straight in from the server page.
- **Storage**: create MaxIOPS, Standard or HDD storage (encrypted by default, optionally with an automatic backup rule and attached to a server), grow it, rename it, change its backup rule, back it up now, clone it, attach and detach it. Drag storage onto a server in the same zone to attach it.
- **Backups**: take, restore and delete; each backup is linked to the storage it protects.
- **Templates**: turn a storage into a private template, rename and delete it. Private templates show up in the server form.
- **Private networks and routers**: create networks with a range, DHCP and an optional router; rename, relabel and delete them.
- **Floating IPs**: reserve, assign to a server (or drag onto one), unassign and set reverse DNS.
- **Managed Kubernetes**: create clusters with a version, control-plane plan, private network, API allow list and a first node group; add, resize and delete node groups, remove single nodes, upgrade, and download the kubeconfig. The cluster page opens the Kubernetes tab directly.
- **Managed Databases** (PostgreSQL, MySQL, Valkey, OpenSearch): create with an engine, a plan filtered to it, allowed IPs, public access, a maintenance window and termination protection. Edit the title, plan, access, maintenance window and protection; power off and on; upgrade the version; fork from a point in time; read the service logs. Users and logical databases are child resources. The database page opens a PostgreSQL, MySQL or Valkey tab with the connection filled in.
- **Managed Load Balancers**: create with a plan, private network, listener and backend servers picked from your servers' addresses; add and remove backend members, start, stop, rename and change the plan.
- **Managed Object Storage**: create services in a region, start or stop them, create and delete buckets, and create users with full S3 access. Get credentials on a user mints a new access key and shows its secret once.
- **Account**: prepaid credits, the account currency and the resource limits.

<insert [UpCloud account page showing Servers, Storage, Kubernetes Clusters, Managed Databases and Load Balancers] here>

## Credentials

Use either:

- **An API token** (recommended): in the UpCloud Control Panel open **Account**, then **API Tokens**, and create one. It is shown once and lasts at most 365 days; you can restrict it to IP ranges.
- **An API user**: under **People**, create a user with **Allow API connections** ticked, then enter its username and password.

Costs need the **Billing** role. Click **Check credentials** after adding the account to see what the key can reach.

<insert [Add account dialog for UpCloud with the API Token field filled in and the API user fields empty] here>

## Costs, credits and limits

- Spend comes from the monthly billing summary: one row per resource per month, with its zone, its plan and its labels as tags. The current month is updated as it accrues and replaced by the final figure after the month ends.
- Prepaid credits feed the credit burndown.
- Account limits (cores, memory, networks, routers, load balancers, databases, Kubernetes clusters and Object Storage services) are tracked against what the account runs.
- Create forms show each plan's monthly price for the zone you pick.

## Metrics

- Managed Databases: CPU, memory, disk, load, disk I/O and network, per primary node.
- Servers: daily outbound public transfer (the API has no CPU graphs).
- Object Storage: object count and stored size.

## Status

Incidents from [status.upcloud.com](https://status.upcloud.com) are matched to your resources by zone and product.

## Terraform

Servers, storage, networks, routers, floating IPs, Kubernetes clusters and node groups, databases, load balancers and Object Storage export to the official `UpCloudLtd/upcloud` provider. Servers export without their boot template; add it before applying.

## Limits

- File Storage, network gateways, network peering, server groups and load balancer TLS configuration are not covered yet.
- Deleting a server requires it to be stopped, and deletes its storage (the latest backup is kept).
