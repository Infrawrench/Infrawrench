---
title: Crusoe Cloud
description: Manage Crusoe Cloud GPU VMs, disks, snapshots, VPC networks, firewall rules, managed Kubernetes clusters and node pools, and track billed spend, credits, reservations and quotas.
sidebar_order: 50
---

Crusoe Cloud is a GPU cloud. The plugin covers the infrastructure you run there and the money it costs, using Crusoe's own billing data rather than an estimate.

## What you can manage

- **Projects**: create, rename and delete. Every other resource lives in a project and also appears on that project's page.
- **VMs** (GPU and CPU): create with a project, location, instance type, image and SSH key; start, stop and hard reset from the header; edit to change the instance type (Crusoe needs the VM stopped first).
- **Disks** (persistent SSD and shared volumes): create, grow, delete, take a snapshot, detach from every VM from the header, and drag a disk onto a VM in the same location to attach it.
- **Disk snapshots**: create from any disk, delete.
- **VPC networks** and **VPC subnets**: create, rename, and turn a subnet's NAT gateway on or off.
- **Firewall rules**: create and edit protocols, sources, destinations and ports. A rule left without a destination applies to its whole VPC network.
- **Managed Kubernetes (CMK) clusters**: create with a version picker, and open the cluster's workloads in the Kubernetes tab, which uses an admin kubeconfig fetched from Crusoe.
- **Node pools**: create from the cluster's page, scale the node count, and set the autoscaling minimum and maximum.
- **Load balancers**: listener ports, backends and the virtual IP; delete.
- **SSH keys** registered to your Crusoe user: add and delete.
- **Reservations**: reserved capacity per instance type, how much of it is in use, and the contract dates.

Every project, location, instance type, image, VPC network, disk, cluster and Kubernetes version in the create forms is a picker filled from your account, so you never type an ID.

<insert [The Crusoe Cloud account page showing the Projects, VMs, Disks and Kubernetes Clusters sections, with one GPU VM selected and its Stop and Reset buttons visible in the header] here>

## Credentials

In the Crusoe Cloud console open the **Security** tab, then **Tokens**, and click **Generate token**. Copy the **Access key** and the **Secret key**; the secret is only shown once.

- The key acts as the user who created it, so one Infrawrench account sees every organization and project that user belongs to.
- Billing data, credits and quotas are organization-level reads. Create the key as a user with the organization's admin or billing role, or those sections report that access was refused while everything else keeps working.
- **Monitoring token** (optional): Crusoe documents a separate monitoring token (`crusoe monitoring tokens create`) for its metrics API. If VM metrics stay empty, create one and add it here.

Requests are signed with your secret key on every call (HMAC-SHA256, as Crusoe requires); the secret itself is never sent.

<insert [The Add account form for Crusoe Cloud with the Access Key, Secret Key and optional Monitoring Token fields] here>

## Metrics

VMs running the Crusoe Watch Agent (installed by default on new VMs) show CPU and memory utilization, network in and out, and for GPU instances GPU utilization, GPU memory utilization, tensor core activity, power draw and temperature. Crusoe keeps 30 days of metrics.

## Cost

Spend is read from Crusoe's billing data, not estimated:

- **Infrastructure** comes from the billing export behind the console's Billing page: on-demand and spot costs per resource, broken down by product line (instance type or storage type), region, project and resource.
- **Serverless inference** comes from Crusoe's Intelligence Billing data, broken down by model and project.

Crusoe keeps billing data from May 1, 2025, and the first collection backfills up to 400 days of it. Usage is finalized daily shortly after midnight UTC.

What is not in the figures, because Crusoe keeps it out of this data too:

- **Reserved-instance purchases.** Reservations appear in the [commitments](../features/commitments.md) section with their reserved quantity and contract dates, but Crusoe reports no price for them, so they are not added to spend.
- **Tax.** The billing data is pre-tax, as is the console's Billing page.

Credits are shown in the [credit burndown](../features/credit-burndown.md) section and are not subtracted from spend.

<insert [The Costs panel grouped by service for a Crusoe Cloud account, showing GPU product lines such as h100-80gb-sxm-ib alongside persistent-ssd] here>

## Savings and governance

- **Orphan finder**: disks attached to no VM, and stopped VMs, which stop billing for compute but keep billing for their disks.
- **Sleep schedules**: VMs can be stopped and started on a schedule.
- **Quota radar**: every organization quota Crusoe reports, such as GPUs per instance type, against current usage.
- **Posture checks**: an ingress firewall rule that allows traffic from `0.0.0.0/0` is flagged.
- **Provider status**: incidents on [status.crusoecloud.com](https://status.crusoecloud.com) are matched to the regions and products you use.
- **Terraform export**: projects, VMs, disks, networks, subnets, firewall rules, clusters and node pools export to the `crusoecloud/crusoe` provider, with import IDs in the provider's `<id>,<project_id>` form.

## Quirks

- A VM's dynamic public IP changes when it is stopped and started again.
- Crusoe does not report which image a VM was created from, so the image field in Terraform exports has to be filled in by hand.
- Disks can only grow; Crusoe does not shrink a disk.
