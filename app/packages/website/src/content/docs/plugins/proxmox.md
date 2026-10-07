---
title: Proxmox VE
description: Manage a self-hosted Proxmox VE cluster - nodes, VMs and containers with power actions, clones, snapshots, backups and backup jobs, storage, pools, high availability and the datacenter firewall - with RRD metrics and task logs.
sidebar_order: 50
---

Proxmox VE runs on your own hardware, so the account points at your cluster's API (any node, port 8006) rather than at a cloud endpoint.

## What you can manage

- **Cluster**: quorum, node count, version, HA manager state, the cluster log, and the guests no backup job covers. Edit the datacenter firewall switch and its default inbound and outbound policies.
- **Nodes**: status, CPU, memory, kernel, Proxmox VE version and subscription (its due date feeds the expiry radar). Start or stop all guests, refresh the package index, reboot or shut down a node, open its shell in the Proxmox web UI, and SSH to it.
- **Virtual machines** and **containers** (templates included): start, shut down, reboot, stop, reset, suspend and resume; take, roll back and delete snapshots; back up now; clone or deploy from a template; convert to a template; migrate to another node; grow a disk; move to a pool; add guest firewall rules; put the guest under HA; toggle protection. **Edit** changes name, cores, sockets, memory, ballooning, CPU type, OS type, guest agent, start at boot, protection, tags and notes.
- **Storage**: usage, content (ISOs, container templates, disk images), delete ISOs and templates, and **Download from URL** to fetch an ISO or template straight onto the storage. Edit the allowed content types and enable or disable it.
- **Backups** (vzdump archives, including Proxmox Backup Server): restore to a new or existing VMID, edit notes, protect, delete.
- **Backup jobs**: create, edit (schedule, storage, guests, pool, mode, compression, retention) and delete.
- **Pools**, **HA resources** (migrate, relocate, change requested state), **HA rules** (Proxmox VE 9), and the datacenter **firewall**: rules, security groups and their rules, aliases and IP sets.

## Creating guests

**Create Virtual Machine** and **Create Container** either clone a template (linked or full, with cores, memory and, for VMs, cloud-init user, SSH key and address) or build from scratch: a blank VM booting an ISO, or a container from an OS template. Node, VMID (the next free one is filled in), template, ISO, storage, bridge and pool are all pickers.

<insert [Proxmox VE Create Virtual Machine form with "Clone a VM template" selected, showing the template, node, VMID and SSH key pickers] here>

## Credentials

1. In the Proxmox VE web UI open **Datacenter → Permissions → API Tokens → Add**.
2. Pick a user, give the token an ID, and copy the **Token ID** (`user@realm!name`) and the **Secret** shown once.
3. Grant a role on `/` to the token (and, with **Privilege Separation** on, to its user too): `PVEAuditor` is enough to browse, `PVEAdmin` covers managing guests. The account's permission check lists exactly which privileges each feature needs and can generate the `pveum` commands for a least-privilege role.
4. Enter the URL, for example `https://pve1.example.internal:8006`.

Proxmox VE signs its certificate with the cluster's own CA. Paste `/etc/pve/pve-root-ca.pem` from any node into **CA Certificate** under advanced options, or use a node certificate from a public CA (ACME).

<insert [Proxmox VE add-account form with URL, API Token ID, API Token Secret and the expanded CA Certificate field] here>

## Metrics, logs and consoles

- The **Metrics** tab charts Proxmox's RRD data: CPU, memory, network, disk I/O and pressure for guests; CPU, IO wait, load, memory, swap, root disk and network for nodes; usage for storage.
- **Logs** on a node shows the system journal and recent tasks. On a guest it lists the guest's recent tasks (backups, migrations, starts) and shows each task's log.
- **Describe** on a guest prints its full configuration.
- **SSH** works for nodes and for running guests: VM addresses come from the QEMU guest agent, container addresses from the container's interfaces. **Open console** opens the guest's noVNC or xterm.js console in the Proxmox web UI.

<insert [Proxmox VE VM detail view showing power actions, the Snapshots table with Roll back and Delete buttons, and the Metrics tab] here>

## Tips and limits

- Reaching a private cluster: the desktop app connects directly; the cloud app needs a bastion or an SSH tunnel on the account. Through an SSH tunnel the connection goes to `127.0.0.1`, so certificate verification fails unless the node's certificate also covers that address.
- VM IP addresses need the QEMU guest agent installed and enabled; without it SSH has no address to use.
- HA rules need Proxmox VE 9. On 8.x the HA rules list is empty and HA groups are not managed here.
- Clones and creates wait up to about three minutes for the Proxmox task. A longer full clone keeps running and appears on the next refresh; CPU, memory and cloud-init settings are then applied by editing it.
- There is no cost data: Proxmox VE has no billing, and there is no official Terraform provider to export to.
