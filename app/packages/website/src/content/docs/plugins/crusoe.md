---
title: Crusoe Cloud
description: Manage Crusoe Cloud GPU VMs, disks, snapshots, VPC networks, firewall rules, managed Kubernetes clusters and node pools, and track billed spend, credits, reservations and quotas.
sidebar_order: 50
---

Crusoe Cloud is a GPU cloud. Connect it to manage what you run there and see what it costs, using Crusoe's own billing data rather than an estimate.

## What you can manage

- **Projects**: create, rename and delete. Every other resource lives in a project and also appears on that project's page.
- **VMs** (GPU and CPU): create with a project, location, instance type, image and SSH key. Start, stop and hard reset from the header. Edit to change the instance type (stop the VM first).
- **Disks** (persistent SSD and shared volumes): create, grow, delete, take a snapshot, and detach from every VM from the header. Drag a disk onto a VM in the same location to attach it.
- **Disk snapshots**: create from any disk, delete.
- **VPC networks** and **VPC subnets**: create, rename, and turn a subnet's NAT gateway on or off.
- **Firewall rules**: create and edit protocols, sources, destinations and ports. A rule without a destination applies to its whole VPC network.
- **Managed Kubernetes (CMK) clusters**: create with a version picker, and open the cluster's workloads in the Kubernetes tab.
- **Node pools**: create from the cluster's page, scale the node count, and set the autoscaling minimum and maximum.
- **Load balancers**: listener ports, backends and the virtual IP. Delete.
- **SSH keys** registered to your Crusoe user: add and delete.
- **Reservations**: reserved capacity per instance type, how much of it is in use, and the contract dates.

Create forms offer your projects, locations, instance types, images, VPC networks, disks, clusters and Kubernetes versions as pickers, so you never type an ID.

<insert [The Crusoe Cloud account page showing the Projects, VMs, Disks and Kubernetes Clusters sections, with one GPU VM selected and its Stop and Reset buttons visible in the header] here>

## Connect your account

1. In the Crusoe Cloud console, open the **Security** tab, then **Tokens**, and click **Generate token**.
2. Copy the **Access key** and the **Secret key**. The secret is only shown once.

Good to know:

- The key acts as the user who created it, so one Infrawrench account sees every organization and project that user belongs to.
- Billing data, credits and quotas need organization-level access. Create the key as a user with the organization's admin or billing role. Otherwise those sections say access was refused, and everything else keeps working.
- **Monitoring token** (optional): Crusoe has a separate monitoring token (`crusoe monitoring tokens create`) for its metrics API. If VM metrics stay empty, create one and add it here.
- Your secret key is used to sign each request and is never sent itself.

<insert [The Add account form for Crusoe Cloud with the Access Key, Secret Key and optional Monitoring Token fields] here>

## Metrics

VMs running the Crusoe Watch Agent (installed by default on new VMs) show CPU and memory utilization and network in and out. GPU instances also show GPU utilization, GPU memory utilization, tensor core activity, power draw and temperature. Crusoe keeps 30 days of metrics.

## Cost

Spend comes from Crusoe's billing data, not an estimate:

- **Infrastructure**: the same data as the console's Billing page. On-demand and spot costs per resource, broken down by product line (instance type or storage type), region, project and resource.
- **Serverless inference**: broken down by model and project.

Crusoe keeps billing data from May 1, 2025, and up to 400 days of history load when you connect. Usage is finalized daily shortly after midnight UTC.

Not included, because Crusoe leaves them out too:

- **Reserved-instance purchases.** Reservations appear in the [commitments](../features/commitments.md) section with their reserved quantity and contract dates, but Crusoe reports no price for them, so they aren't added to spend.
- **Tax.** The figures are pre-tax, like the console's Billing page.

Credits are shown in the [credit burndown](../features/credit-burndown.md) section and aren't subtracted from spend.

<insert [The Costs panel grouped by service for a Crusoe Cloud account, showing GPU product lines such as h100-80gb-sxm-ib alongside persistent-ssd] here>

## Savings and governance

- **Orphan finder**: disks attached to no VM, and stopped VMs, which stop billing for compute but keep billing for their disks.
- **Sleep schedules**: stop and start VMs on a schedule.
- **Quota radar**: every organization quota Crusoe reports, such as GPUs per instance type, against current usage.
- **Posture checks**: an ingress firewall rule that allows traffic from `0.0.0.0/0` is flagged.
- **Provider status**: incidents on [status.crusoecloud.com](https://status.crusoecloud.com) are matched to the regions and products you use.
- **Terraform export**: projects, VMs, disks, networks, subnets, firewall rules, clusters and node pools export to the `crusoecloud/crusoe` provider, with import IDs in the provider's `<id>,<project_id>` form.

## Run CI jobs

A Crusoe Cloud connection can run [Infrawrench CI](../features/ci.md) cloud jobs once an organization admin opts it in. Each `vm` job gets a fresh VM in the job's `cloud.region` (`us-east1-a` when it names none), which is deleted when the job ends:

| `cloud.kind` | Runs on     | Default `machine` | Default `image`                                 |
| ------------ | ----------- | ----------------- | ----------------------------------------------- |
| `vm`         | A Crusoe VM | `c1a.4x`          | Ubuntu 24.04, the curated image for the VM type |

`machine` is a Crusoe VM type such as `c1a.8x`, `l40s-48gb.1x`, `a100-80gb.8x` or `h100-80gb-sxm-ib.8x`. Instead of a machine you can name a GPU with `cloud.gpu`: `l40s:4` becomes `l40s-48gb.4x`, `h100:8` becomes `h100-80gb-sxm-ib.8x`, from the VM types your project offers. `image` is a curated or custom image as `name:tag`, such as `ubuntu24.04-nvidia-b.h100.1.0:latest`.

Jobs run in the project named `infrawrench-ci`. If the key's user belongs to only one project they run there, and otherwise in the project named `default`; with several projects and neither name, create an `infrawrench-ci` project. Jobs use on-demand capacity only, never a reservation's.

The VM holds no Crusoe credentials. Crusoe requires an SSH key, so it gets one whose private half is thrown away, and the Crusoe Watch agent isn't installed. Crusoe VMs have no tags, so a job's VM is named `iwci-` followed by the job's key and your organization's CI tag. Leave VMs named like that alone: Infrawrench deletes any it no longer has a job for.

Crusoe bills VMs per second while they run. A VM powers itself off when the job ends or its time is up, which stops compute billing, but its OS disk keeps billing until the VM is deleted. Infrawrench deletes it when the job ends, and again later if that fails.

Crusoe has no call that checks a permission without using it, so opting in reads the project's VMs and VM types and tries to delete a VM that doesn't exist. Give the key's user the **Editor** (or Admin) role on the project; a Reader can't start VMs.

## Good to know

- A VM's dynamic public IP changes when you stop and start it again.
- Crusoe doesn't report which image a VM was created from, so fill in the image field in Terraform exports by hand.
- Disks can only grow. Crusoe doesn't shrink a disk.
