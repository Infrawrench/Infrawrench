---
title: Fly.io
description: Manage Fly apps, machines, volumes, secrets, certificates, IP addresses, and Managed Postgres clusters.
sidebar_order: 8
---

## What you can manage

- Apps (list, view config, mint deploy tokens)
- Machines (start / stop / restart / suspend / cordon, state tracking, lifecycle events)
- Volumes (grow, snapshot settings, on-demand snapshots)
- App secrets
- Certificates
- IP addresses (shared and dedicated IPv4, IPv6, Flycast, static egress)
- Managed Postgres clusters

## Credentials

Fly.io dashboard → **Account → Access Tokens → Create Token**. Tokens are organization-scoped, so you also need to tell infrawrench which org to use.

- **API Token**: the token from the Fly dashboard.
- **Organization Slug**: your Fly org slug (defaults to `personal`).

![Fly Add-account form with API token and organization slug fields](https://agent-assets.infrawrench.com/docs-screenshots/plugins/fly/add-account.png)

Infrawrench uses the token for the Machines API and Fly's Prometheus metrics endpoint.

## Notable flows

- **SSH terminal** on machines that have `fly ssh` enabled.
- **Region pickers** read Fly's live region list, so new regions appear and deprecated ones disappear without an update.
- **Machine sizes**: pick a preset (`shared-cpu-1x` up to `performance-16x`) when creating a machine, and optionally raise its memory.
- **Machine actions**: Start, Stop, Restart, Suspend (the next start resumes from a memory snapshot), and Cordon / Uncordon (take a machine out of the Fly Proxy's rotation without stopping it). The **Logs** tab lists the machine's lifecycle events, including exit codes.
- **Metrics** for apps and machines: CPU, memory used and available, load, network, HTTP request rate, 5xx rate, p95 response time, and concurrency. Volumes chart disk usage.
- **Volumes**: **Edit** grows a volume (volumes cannot shrink) and changes automatic snapshots and snapshot retention. **Snapshot Now** takes a snapshot, and the detail view lists existing snapshots.
- **App secrets**: create, update (the value is write-only), and delete secrets. Machines pick up a changed secret on their next restart or deploy.
- **Deploy tokens**: export an app-scoped `FLY_API_TOKEN` for CI from an app's credentials menu.
- **Certificates**: request Let's Encrypt certificates for custom hostnames, see their validation state and any DNS errors, and **Check DNS** to re-validate.
- **IP addresses**: allocate shared or dedicated IPv4, IPv6, private Flycast, or a static egress pair for a region, and release them.
- **Managed Postgres**: create a cluster (region, plan, Postgres version, disk, pooler mode, PostGIS), see its sizing, storage, and private connection endpoints, its databases, users, and backups, and start a full backup with **Back Up Now**. Drag a cluster onto an app to record the attachment in Fly. Attaching does not set a `DATABASE_URL` secret; add one as an app secret.

<insert [Fly Managed Postgres cluster detail view showing the Cluster, Storage, and Connection sections and the Back Up Now action] here>

## Tips & limits

- Fly apps can be organization-scoped. Tokens scoped to one org will not see apps from another.
- Machine creation via infrawrench sets only common fields (image, region, size, memory). For complex configs (custom init, services, metadata), use `flyctl` and pull the result back in.
- Managed Postgres endpoints live on your organization's private network, so they are reachable from your Fly apps or over WireGuard, not from the public internet.
- Machine logs (stdout) are not part of the Machines API; use `fly logs` or the Fly dashboard for them.
