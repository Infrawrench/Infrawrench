---
title: DigitalOcean
description: Manage Droplets, Kubernetes, managed databases, Spaces, and DNS.
sidebar_order: 4
---

The most approachable cloud plugin — a single API token is all you need.

## What you can manage

- **Droplets** — list, create (image + size + region + SSH key pickers), delete. Full lifecycle actions from the detail page: power on / off / cycle, reboot, shutdown, snapshot (auto-named or named), rename, resize, rebuild from image, reset root password, enable IPv6, enable/disable/restore backups and change backup policy.
- **Block-storage volumes** — list, create, delete, attach/detach (drag a volume onto a droplet to attach), resize, snapshot.
- **Snapshots** — sidebar group listing every droplet _and_ volume snapshot, deletable from the detail page. Restore back into a droplet via the droplet's Actions → Restore from Backup.
- **Custom images** — your account-owned images (uploaded ISOs, snapshots promoted to images, backups). Distribution and marketplace images are still selectable from the droplet create form.
- **Network File Storage (NFS)** — create POSIX-compliant NFSv4.1 shares (standard or high-performance tier), pinned to a VPC, mountable across multiple Droplets and DOKS nodes. The share detail page surfaces the mount target and a ready-to-paste `mount -t nfs` command.
- **Kubernetes (DOKS)** — clusters, with kubeconfig output for the [Kubernetes plugin](./kubernetes.md).
- **Managed databases** — Postgres, MySQL, Redis, MongoDB. Connection strings are outputs you can reference from the matching client plugins.
- **Spaces** — S3-compatible object storage, with the [file browser](../features/file-browsers.md).
- **DNS** — domains and records.
- **Projects** — list, create, edit (name / description / purpose / environment) and delete. Use the **Edit Project…** button at the bottom of the project detail page to rename or repurpose without leaving Infrawrench.

<insert [DigitalOcean Project detail page with the Edit Project button at the bottom highlighted] here>

## Droplet detail page

The droplet detail page adds:

- A **header action bar** with state-aware Power On / Reboot / Shutdown buttons and a one-click "Take Snapshot" (auto-named with the droplet name + ISO timestamp).
- An **Actions tab** with everything else — Power Cycle, hard Power Off, named Snapshot, Rename, Resize (with a CPU/RAM-only vs disk-included toggle), Rebuild, Enable IPv6, Reset Root Password, Enable/Disable Backups, Change Backup Policy (daily vs weekly + hour + weekday), Restore from Backup. Destructive actions show a confirmation prompt.
- A **Metrics tab** charting every metric the DO Monitoring API exposes for droplets: CPU, load (1/5/15 min), memory (total / available / free / cached), disk read/write, filesystem size/free, and bandwidth on both public and private interfaces in both directions. Memory/disk/load/filesystem series only render when the [DO Metrics Agent](https://docs.digitalocean.com/products/monitoring/how-to/install-metrics-agent/) is installed on the droplet.
- **Backups / Snapshots / Volumes** tabs listing IDs DO has recorded for this droplet, with quick links into the matching detail page where applicable.

<insert [DigitalOcean droplet detail page with the Actions tab open showing Power, Snapshot & Image, Configuration, and Backups sections] here>

<insert [DigitalOcean droplet Metrics tab with CPU, load, memory, bandwidth, and filesystem charts] here>

## NFS shares

Create a share from any project's NFS sidebar group:

1. Pick a region that supports NFS (the create call returns 422 in unsupported regions).
2. Size — minimum 50 GiB, maximum 16,000 GiB.
3. Performance tier — Standard ($0.15 / GiB-mo) or High Performance ($0.30 / GiB-mo, GPU-tuned).
4. VPC — the share is reachable only from droplets/DOKS nodes in this VPC. Add more VPCs after creation in the DO console.

After creation, the share's detail page renders the mount target and a copy-paste `sudo mount -t nfs -o nfsvers=4.1 …` command sized for the share.

<insert [DigitalOcean NFS share detail page showing the mount target and mount command] here>

## Credentials

1. DigitalOcean → **API → Tokens → Generate new token**. Read + write scope.
2. Paste into the add-account form.

<insert [DigitalOcean Add-account form with API token field] here>

## Notable flows

- **SSH terminal** on Droplets.
- **SQL editor** on managed Postgres and MySQL (via output reference to the [Postgres](./postgres.md) / [MySQL](./mysql.md) plugins).
- **File browser** on Spaces.
- **Secret export to K8s** for managed databases and Spaces.

## Tips & limits

- Droplet creation needs at least one SSH key. Upload via **Settings → SSH keys** on DigitalOcean (not infrawrench) or use an existing key reference.
- DOKS kubeconfigs rotate periodically. Infrawrench re-fetches on refresh.
