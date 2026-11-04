---
title: Fly.io
description: Manage Fly apps, machines, volumes, secrets, certificates, IP addresses, and Managed Postgres clusters.
sidebar_order: 8
---

Connect Fly.io to run your machines, watch logs and metrics, and manage volumes, secrets, certificates, IPs and Managed Postgres from one place.

## What you can manage

- Apps (list, view config, create deploy tokens)
- Machines (start, stop, restart, suspend, cordon, state and lifecycle events)
- Volumes (grow, snapshot settings, on-demand snapshots)
- App secrets
- Certificates
- IP addresses (shared and dedicated IPv4, IPv6, Flycast, static egress)
- Managed Postgres clusters

## Connect your account

1. In the Fly.io dashboard, go to **Account > Access Tokens > Create Token**.
2. Fill in the form:
   - **API Token**: the token you just created.
   - **Organization Slug**: your Fly org slug (defaults to `personal`). Tokens are scoped to an organization, so Infrawrench needs to know which one.

![Fly Add-account form with API token and organization slug fields](https://agent-assets.infrawrench.com/docs-screenshots/plugins/fly/add-account.png)

The token is used for machines, metrics and logs.

## Work with machines

- **SSH terminal**: open one on any machine that has `fly ssh` enabled.
- **Regions**: the region pickers always show Fly's current region list.
- **Machine sizes**: when you create a machine, pick a preset (`shared-cpu-1x` up to `performance-16x`) and optionally raise its memory.
- **Machine actions**: Start, Stop, Restart, Suspend (the next start resumes from a memory snapshot), and Cordon or Uncordon (take a machine out of the Fly Proxy's rotation without stopping it).
- **Machine logs**: the **Logs** tab shows the machine's output (stdout and stderr). Switch it to **events** to see lifecycle events, including exit codes.
- **App logs**: an app's **Logs** tab shows the latest output from all its machines, with each line tagged by machine and region.

## Watch metrics

Apps and machines chart CPU, CPU throttling, burst balance and baseline, memory used and available, swap, load, network, disk read and write throughput and IOPS, root disk usage, open file descriptors, HTTP request rate, 5xx rate, p95 response time, p95 connect time, TCP connects and concurrency.

Apps also chart the Fly Proxy edge: request rate, 5xx rate, p95 response time, data in and out, and TLS handshake errors. Volumes chart disk usage.

## Manage volumes, secrets and networking

- **Volumes**: **Edit** grows a volume (volumes can't shrink) and changes automatic snapshots and snapshot retention. **Snapshot Now** takes a snapshot, and the detail view lists the ones you have.
- **App secrets**: create, update (values are write-only) and delete secrets. Machines pick up a changed secret on their next restart or deploy.
- **Deploy tokens**: export an app-scoped `FLY_API_TOKEN` for CI from an app's credentials menu.
- **Certificates**: request Let's Encrypt certificates for custom hostnames, see their validation state and any DNS errors, and use **Check DNS** to validate again.
- **IP addresses**: allocate shared or dedicated IPv4, IPv6, private Flycast, or a static egress pair for a region, and release them.

## Use Managed Postgres

- Create a cluster: choose region, plan, Postgres version, disk, pooler mode and PostGIS.
- See its sizing, storage and private connection endpoints, plus its databases, users and backups.
- Start a full backup with **Back Up Now**.
- Drag a cluster onto an app to record the attachment in Fly. Attaching doesn't set a `DATABASE_URL` secret, so add one as an app secret.

<insert [Fly Managed Postgres cluster detail view showing the Cluster, Storage, and Connection sections and the Back Up Now action] here>

## Tips and limits

- A token scoped to one org won't see apps from another.
- Creating a machine here sets only the common fields (image, region, size, memory). For complex configs (custom init, services, metadata), use `flyctl` and the result shows up here.
- Managed Postgres endpoints live on your organization's private network. You can reach them from your Fly apps or over WireGuard, not from the public internet.
- Logs show the most recent 100 lines from the last 24 hours, the same as `fly logs`. Fly calls that source mostly stable but not officially supported. For search and long retention, [ship logs](https://fly.io/docs/monitoring/exporting-logs/) somewhere else.
- Metrics go back about 15 days.
