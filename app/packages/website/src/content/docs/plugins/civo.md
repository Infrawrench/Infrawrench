---
title: Civo
description: Manage Civo instances, volumes, Kubernetes clusters, databases, load balancers, firewalls, networks, DNS and Object Stores across every region, with account quotas and this month's usage.
sidebar_order: 6
---

Infrawrench talks to the Civo API v2 with your account's API key. Civo resources live in regions, so Infrawrench lists every region your account can use and shows them together.

## What you can manage

- **Instances**: create with a region, a size, a disk image, an SSH key, the initial user, a network, a firewall, a public or private-only address (or one of your reserved IPs), an initialization script and tags. Start, stop, reboot, hard reboot, resize, change the firewall, take a snapshot, and enter or leave recovery mode. Edit the hostname, reverse DNS, notes, tags, allowed source IPs and bandwidth limit. SSH straight in as the initial user; the generated password is available as an output.
- **Volumes**: create (optionally attached to an instance), grow, attach and detach. Drag a volume onto an instance in the same region to attach it. **Volume snapshots** can be taken and deleted.
- **Instance snapshots**: take, rename, delete and restore (to a new instance or over the original).
- **Kubernetes**: create K3s or Talos clusters with a version picker, a CNI, a node size and count, a network, a firewall and marketplace applications. Add, resize and delete node pools, remove or recycle individual nodes, install more marketplace applications, change the firewall and upgrade the Kubernetes version when Civo offers one. Download the kubeconfig, and the cluster page opens the Kubernetes tab directly.
- **Databases** (MySQL and PostgreSQL): create with an engine version picker, a size, one or three nodes, a network and a firewall. Rename, change the node count and the firewall, take manual backups, set up scheduled backups, and restore from a backup. The database page opens a PostgreSQL or MySQL tab with the connection filled in.
- **Load balancers**: create with backends picked from your instances, edit the algorithm, traffic policy, session affinity, proxy protocol and connection limit, change the backends and the firewall.
- **Firewalls**: create (with SSH and web presets, or Civo's default rules), rename, add and remove inbound and outbound rules. Drag a firewall onto an instance to protect it.
- **Networks**, **reserved IPs** (assign, unassign, or drag onto an instance), **DNS domains and records** (records can track another resource's address), **Object Stores** with a file browser (upload, create folders, delete), **Object Store credentials** and **SSH keys**.
- **Account**: your quota usage and every resource Civo metered this month, in hours.

<insert [Civo account page showing Instances, Kubernetes Clusters, Databases and Object Stores from several regions] here>

## Credentials

In the Civo dashboard click your account name, then **Profile**, then **Security**, and under **API Keys** create a key. Civo shows it once. The key has full access to the account and works in every region.

## Quotas

Civo reports used and limit pairs for instances, vCPUs, memory, disk, volumes, snapshots, public IPs, networks, firewalls and rules, load balancers, object storage and databases. Infrawrench tracks them and warns before you run out; request an increase from the Civo dashboard.

<insert [Civo quota usage on the Quotas page with the vCPU and instance limits] here>

## Status

Open issues from [status.civo.com](https://status.civo.com) are matched to your resources by region (LON1, FRA1, NYC1, PHX1, MUM1) and by product where the title names one.

## Terraform

Instances, volumes, Kubernetes clusters and node pools, databases, firewalls, networks, reserved IPs, DNS domains and records, Object Stores, credentials and SSH keys export to the official `civo/civo` provider with their import ids. The provider reads the key from `CIVO_TOKEN`.

## Limits

- Civo's API reports usage in hours per resource but no prices or invoices, so Infrawrench does not show Civo spend. The account page lists this month's metered usage instead.
- Civo publishes no metrics API, so there is no Metrics tab for Civo resources.
- The load balancer create form offers instances from the default region; pick the backends from the load balancer page after creating it in another region.
- Civo can only resize instances up.
