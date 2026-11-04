---
title: IBM Cloud
description: Manage IBM Cloud VPC servers, volumes and networking, Kubernetes Service and OpenShift clusters, Code Engine, Cloud Object Storage, Cloud Databases and service instances, with monthly billed spend and promotional credit.
sidebar_order: 50
---

Connect an IBM Cloud account with an API key to manage servers, networking, clusters, storage and databases in every VPC region, and to track billed spend and credit.

## Connect your account

1. In the IBM Cloud console, open **Manage > Access (IAM) > API keys** and choose **Create**. For a key that isn't tied to a person, create a **service ID** under **Access (IAM)** and give it an API key instead.
2. Paste the key. It's shown only once.
3. Pick a **default region**. New resources use it by default.
4. Optionally pick **regions to scan**. The list loads from your account once you enter the key. Leave it empty to scan every VPC region.

<insert [IBM Cloud add-account form with the API key, default region and the regions-to-scan picker filled in] here>

### Access you need to grant

Infrawrench can only do what the key's user or service ID is allowed to do:

- **Viewer** on VPC Infrastructure Services, Kubernetes Service, Code Engine, Cloud Object Storage, the Cloud Databases services and All Resource Groups, to list everything.
- **Editor** (and **Operator** for start and stop) on the services you want to create, edit and delete from Infrawrench.
- **Viewer** on Billing, for costs and credits.

A region where the key has no access just shows as empty.

## What you can manage

- **Account**: the account id, the key's owner, the regions being scanned, and billable spend this month.
- **Resource groups**: create, rename and delete.
- **Virtual Servers for VPC**: create from a profile, operating system, subnet and SSH key, with an optional floating IP. Start, stop, reboot and force stop. Rename and change the profile (IBM Cloud only allows a profile change while the server is stopped). The SSH key is registered in the region the first time you use it.
- **Block Storage volumes**: create in a zone with a performance tier, grow, rename, and drag onto a server in the same zone to attach.
- **VPCs**, **subnets**, **security groups**, **floating IPs** and **SSH keys**: create, rename and delete. New security groups allow all outbound traffic and can start with SSH, or SSH plus HTTP and HTTPS, open. Each group shows its inbound rules and which ports are open to the internet. Drag a floating IP onto a server to bind it.
- **Load balancers**: rename and delete. Each shows its hostname, listeners and pools.
- **Kubernetes Service and Red Hat OpenShift clusters**: update the master version, resize and delete worker pools, and delete clusters.
- **Code Engine**: create and delete projects. Create apps from a container image, change the image, port, scaling and CPU and memory, and delete them. The app URL is an output other resources can reference.
- **Cloud Object Storage buckets**: create in a cross-region or regional location with a storage class, delete, and browse, upload, create folders and delete objects. Each bucket shows its object count and stored size.
- **Cloud Databases** (PostgreSQL, MySQL, Redis, MongoDB, Elasticsearch, etcd, RabbitMQ): rename, scale memory, disk and dedicated CPU per member, and delete. Host and port are outputs.
- **Other service instances** (Key Protect, Event Streams, watsonx and so on): rename and delete. The dashboard link is an output.

## Costs

IBM Cloud billed usage shows in [cost graphs and budgets](../features/cloud-costs.md), per resource instance, plan and metric. IBM only reports usage by month, so every row is dated to the 1st of its month. Amounts are after discounts, and the price before discounts is kept as the list amount. The current and previous month keep updating while IBM finalizes them.

Promotional credit shows in [credit burndown](../features/credit-burndown.md) with its starting balance and expiry.

## Savings and security

- **Potential savings** flags stopped servers, unattached volumes, unbound floating IPs and load balancers with no pools.
- **Posture checks** flag security groups that open SSH or RDP to the internet.
- The status page shows IBM Cloud incidents and maintenance in the regions you use.

## Tips and limits

- Resources have no metrics tab, because IBM Cloud only offers metrics through an IBM Cloud Monitoring instance.
- Kubernetes Service kubeconfigs aren't offered here. Download one with `ibmcloud ks cluster config`.
- Create clusters, databases and other service instances in the IBM Cloud console or catalog.
- The [Terraform export](../features/terraform-export.md) covers resource groups, servers, volumes, VPCs, subnets, security groups, floating IPs, load balancers, and Code Engine projects and apps, for the `IBM-Cloud/ibm` provider.
