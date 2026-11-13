---
title: Proxmox VE
description: Manage a self-hosted Proxmox VE cluster, including nodes, VMs and containers with power actions, clones, snapshots, backups and backup jobs, storage, pools, high availability and the datacenter firewall, with RRD metrics and task logs.
sidebar_order: 50
---

Proxmox VE runs on your own hardware, so the account points at your cluster's API (any node, port 8006) instead of a cloud endpoint.

## What you can manage

- **Cluster**: quorum, node count, version, HA manager state, the cluster log, and the guests no backup job covers. Edit the datacenter firewall switch and its default inbound and outbound policies.
- **Nodes**: status, CPU, memory, kernel, Proxmox VE version and subscription (its due date feeds the expiry radar). Start or stop all guests, refresh the package index, reboot or shut down a node, open its shell in the Proxmox web UI, and SSH to it.
- **Virtual machines** and **containers** (templates included): start, shut down, reboot, stop, reset, suspend and resume. Take, roll back and delete snapshots. Back up now, clone or deploy from a template, convert to a template, migrate to another node, grow a disk, move to a pool, add guest firewall rules, put the guest under HA, and toggle protection. **Edit** changes name, cores, sockets, memory, ballooning, CPU type, OS type, guest agent, start at boot, protection, tags and notes.
- **Storage**: usage and content (ISOs, container templates, disk images). Delete ISOs and templates, and use **Download from URL** to fetch an ISO or template straight onto the storage. Edit the allowed content types and enable or disable it.
- **Backups** (vzdump archives, including Proxmox Backup Server): restore to a new or existing VMID, edit notes, protect, delete.
- **Backup jobs**: create, edit (schedule, storage, guests, pool, mode, compression, retention) and delete.
- **Pools**, **HA resources** (migrate, relocate, change requested state), **HA rules** (Proxmox VE 9), and the datacenter **firewall**: rules, security groups and their rules, aliases and IP sets.

## Create a VM or container

**Create Virtual Machine** and **Create Container** give you two options:

- **Clone a template** (linked or full), with cores, memory and, for VMs, cloud-init user, SSH key and address.
- **Build from scratch**: a blank VM booting an ISO, or a container from an OS template.

Node, VMID (the next free one is filled in), template, ISO, storage, bridge and pool are all picked from lists.

<insert [Proxmox VE Create Virtual Machine form with "Clone a VM template" selected, showing the template, node, VMID and SSH key pickers] here>

## Connect your cluster

1. In the Proxmox VE web UI, open **Datacenter > Permissions > API Tokens > Add**.
2. Pick a user, give the token an ID, and copy the **Token ID** (`user@realm!name`) and the **Secret** (shown once).
3. Grant a role on `/` to the token (and, with **Privilege Separation** on, to its user too). `PVEAuditor` is enough to browse. `PVEAdmin` covers managing guests. The account's permission check lists exactly which privileges each feature needs and can generate the `pveum` commands for a least-privilege role.
4. Enter the URL, for example `https://pve1.example.internal:8006`.

Proxmox VE signs its certificate with the cluster's own CA. Paste `/etc/pve/pve-root-ca.pem` from any node into **CA Certificate** under advanced options, or use a node certificate from a public CA (ACME).

<insert [Proxmox VE add-account form with URL, API Token ID, API Token Secret and the expanded CA Certificate field] here>

## Metrics, logs and consoles

- The **Metrics** tab charts Proxmox's RRD data: CPU, memory, network, disk I/O and pressure for guests; CPU, IO wait, load, memory, swap, root disk and network for nodes; usage for storage.
- **Logs** on a node shows the system journal and recent tasks. On a guest, it lists the guest's recent tasks (backups, migrations, starts) and each task's log.
- **Describe** on a guest prints its full configuration.
- **SSH** works for nodes and running guests. VM addresses come from the QEMU guest agent, container addresses from the container's interfaces. **Open console** opens the guest's noVNC or xterm.js console in the Proxmox web UI.

<insert [Proxmox VE VM detail view showing power actions, the Snapshots table with Roll back and Delete buttons, and the Metrics tab] here>

## CI jobs

A Proxmox VE cluster can run [cloud jobs](../features/ci.md#cloud-jobs) of kind `vm`: each job clones a VM from a template, runs there, and the VM is destroyed when the job ends.

```yaml
jobs:
  test:
    cloud: { provider: proxmox, kind: vm, image: ubuntu-ci, machine: 4vcpu-8gb }
    run: make test
```

- `image` is the template's VMID or name (required). The template needs the QEMU guest agent installed and enabled (**Options**, **QEMU Guest Agent**), plus `bash` and `curl`; cloud-init isn't needed. Proxmox can't take cloud-init user data over its API, so the job is handed in through the guest agent.
- `machine` is whole vCPUs and memory, like `2vcpu-4gb` (the default). `region` is the node to clone onto (default: the template's node; another node needs shared storage).
- The VM is tagged `infrawrench-ci`, powers itself off once the job's time is up, and is destroyed by Infrawrench afterwards. Proxmox has no "destroy on shutdown", so a VM that powered off on its own waits for that, using disk but no CPU or memory.
- The token needs `VM.Clone`, `VM.Allocate`, `VM.Config.CPU`, `VM.Config.Memory`, `VM.Config.Options`, `VM.PowerMgmt`, `VM.Audit`, `Datastore.AllocateSpace`, `SDN.Use` and `VM.GuestAgent.Unrestricted` (`VM.Monitor` on Proxmox VE 8). **Check permissions** names any that are missing.
- Containers (LXC) can't run CI jobs: the API has no way to run a command inside one.

## Tips and limits

- To reach a private cluster, the desktop app connects directly. The cloud app needs an SSH tunnel on the account. A bastion only reaches public addresses. Through an SSH tunnel the connection goes to `127.0.0.1`, so certificate checks fail unless the node's certificate also covers that address.
- VM IP addresses need the QEMU guest agent installed and enabled. Without it, SSH has no address to use.
- HA rules need Proxmox VE 9. On 8.x the HA rules list is empty and HA groups aren't managed here.
- Clones and creates wait up to about three minutes. A longer full clone keeps running and appears on the next refresh. Then edit it to set CPU, memory and cloud-init.
- There's no cost data, since Proxmox VE has no billing, and no official Terraform provider to export to.
