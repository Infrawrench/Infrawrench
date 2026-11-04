---
title: Exoscale
description: Manage Exoscale instances, block storage, snapshots, private networks, security groups, elastic IPs, SKS Kubernetes, load balancers, DBaaS, DNS and SOS buckets, with billed spend, quotas and the organization balance.
sidebar_order: 6
---

Connect Exoscale with an IAM API key to create, edit and run your resources in every zone your organization uses, and to track billed spend, quotas and your balance.

## What you can manage

- **Compute instances**: create with a zone, instance type, template (public or your own), disk size, SSH key, cloud-init user data, security groups, private network and a public IPv4 or dual-stack address. Start, stop, reboot, change the type (on a stopped instance), grow the disk, take and revert snapshots, reinstall from a template, protect against deletion, and detach security groups, elastic IPs and private networks. Edit the name and labels. SSH straight in from the instance page.
- **Block storage**: create volumes (and attach them to an instance right away if you like), grow and rename them, attach and detach (or drag a volume onto an instance in the same zone), and take snapshots.
- **Snapshots and templates**: instance and volume snapshots are listed with their source. Turn a snapshot into a private template, and rename and delete templates.
- **Private networks**: create unmanaged or managed (DHCP) networks, edit the range and description, and attach them to instances.
- **Security groups**: create with preset rules (SSH, HTTP/HTTPS, ping), add and remove rules from the group page, and attach groups to instances. Groups that open ports other than HTTP and HTTPS to the whole internet are flagged.
- **Elastic IPs**: reserve, describe, add a health check, and attach to an instance (or drag onto one).
- **SKS Kubernetes**: create clusters with a version, a Starter or Pro control plane, a CNI and add-ons. Add, resize and delete node pools, upgrade Kubernetes or move to Pro, and download an admin kubeconfig. The cluster page opens the Kubernetes tab directly.
- **Network load balancers**: create, rename, and add or remove services that forward a port to an instance pool, with TCP or HTTP health checks. You can resize and edit instance pools.
- **DBaaS** (PostgreSQL, MySQL, Valkey and the other engines): create with an engine, plan, allowed IPs, maintenance window and termination protection. Edit the plan, allowed IPs, maintenance window and protection, start maintenance now, reveal a user's password and read the service logs. Users and logical databases show under each service. The service page opens a PostgreSQL, MySQL or Valkey tab with the connection filled in.
- **DNS**: create domains and records, and edit records. Records pointing at buckets nobody owns are flagged.
- **SOS object storage**: create buckets in any zone, and browse, upload, create folders and delete objects.
- **SSH keys and anti-affinity groups**: register, list and delete.
- **Organization**: the organization name, currency and live balance.

<insert [Exoscale account page showing Compute Instances, Block Storage, SKS Clusters, DBaaS Services and SOS Buckets across several zones] here>

## Connect your account

1. In the [Exoscale Portal](https://portal.exoscale.com), open **IAM > API Keys** and create a key with a role. The secret is shown once.
2. The role decides what Infrawrench can see. Allow the `compute`, `dbaas`, `dns` and `sos` services, plus billing access for costs.
3. After adding the account, click **Check credentials** to see what the key can reach.

<insert [Add account dialog for Exoscale with the API Key and API Secret fields and the credential check results] here>

## Costs, quotas and balance

- Spend comes from Exoscale's monthly billing report, per day, service, zone, resource and tag set, with taxes and credits marked. The current month updates as it goes.
- Organization quotas (instances, GPUs, elastic IPs, SKS clusters, DBaaS services, snapshots and more) are tracked with Exoscale's own usage figures.
- Your live balance shows in the credit view.

## Metrics

DBaaS services chart CPU, memory, disk, load, disk I/O and network over the window you pick.

## Status

Incidents and maintenance from [exoscalestatus.com](https://exoscalestatus.com) show on your resources by zone and product.

## Terraform

Instances, volumes, private networks, security groups, elastic IPs, SKS clusters and node pools, load balancers, instance pools, DBaaS services, DNS domains and records, SSH keys and anti-affinity groups export to the official `exoscale/exoscale` provider. Instances export without their template id unless it's known, so set it before you apply. Volumes and DBaaS services export without an import id.

## Limits

- Exoscale marks its billing report as beta. If Exoscale delivers it as Parquet, costs show a setup error.
- Not covered yet: private networks' static leases, security group external sources, IAM roles and keys, DBaaS integrations and connection pools, SOS bucket policies and the AI services.
