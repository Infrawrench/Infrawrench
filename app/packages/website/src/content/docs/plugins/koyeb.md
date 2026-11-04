---
title: Koyeb
description: Manage Koyeb apps, services, Postgres databases, deployments, instances, secrets, domains, volumes and snapshots, with logs, metrics, the current invoice, quotas and a spending alert.
sidebar_order: 21
---

Connect Koyeb to deploy and scale services, manage databases, secrets, domains and volumes, and keep an eye on logs, metrics, spend and quotas.

## What you can manage

- **Organization**: plan and status, the current invoice, quota usage, and the monthly **spending alert** (you can edit it).
- **Projects**: create, rename, edit the description, delete.
- **Apps**: create, rename, pause, resume, delete.
- **Services**: web services, workers and managed Postgres databases.
  - Create one from a Docker image or a GitHub repository, picking the instance type and region.
  - Edit the instance type, regions, min and max instances, image, branch, build and run commands.
  - Redeploy (with or without the build cache), set a fixed instance count, pause, resume or delete.
- **Deployments** (the ten most recent per service): status, commit and image. Cancel one in progress, or redeploy an earlier version (pinned to the commit it built).
- **Instances**: the running replicas, with their region, datacenter and logs.
- **Secrets**: create, update the value, delete. The value is available as an output.
- **Domains**: add a custom domain to an app, see the CNAME target, and check DNS again.
- **Volumes**: create, rename, grow, delete and take snapshots. **Snapshots** are listed and can be deleted.

## Connect your account

In the Koyeb control panel, go to **Settings > API > Create API access token**. The token belongs to that organization and has full access to it. Koyeb shows it only once.

<insert [Koyeb Add-account form with the API Access Token field filled in] here>

## Day-to-day tasks

- **Connect to Postgres**: each database has a **Connection String** output that opens in the PostgreSQL tab and exports as `DATABASE_URL`.
- **Read logs**: runtime, build and Koyeb system logs for services, deployments and single instances, from the last 24 hours (retention depends on your plan).
- **Watch metrics**: CPU and memory for web services and workers. Web services also show requests, p50, p90 and p99 response time, and public data in and out.
- **Roll back**: on an earlier deployment, **Redeploy This Version** makes it the service's configuration again, pinned to the commit it built.
- **Track costs**: the lines of your open invoice for the current month (plan fee, each instance type, database compute and storage), with discounts as a credit. Koyeb doesn't share past invoices, so history starts from the day you connect the account.
- **Check quotas**: apps, services, memory, domains, TCP proxy ports, instances per type, volume storage per region and instance snapshots, each against your plan's limit.

<insert [Koyeb service detail view showing the Redeploy, Set Instances and Pause header actions and the Details section with instance type and scaling] here>

<insert [Koyeb organization detail view showing the Quotas table and the Current Invoice table] here>

## Status, savings and Terraform

- **Status**: incidents from status.koyeb.com show on services, instances and volumes in the affected region (Frankfurt, Paris, Washington, San Francisco, Singapore, Tokyo, or a whole continent). API, control panel and build incidents show on every Koyeb resource.
- **Savings**: a volume that no service uses is listed as an orphan.
- **Export to Terraform** writes `koyeb_app`, `koyeb_secret` (with the value as a sensitive variable) and `koyeb_volume` blocks for the official `koyeb/koyeb` provider, which reads its token from `KOYEB_TOKEN`. Services aren't exported.

## Tips and limits

- Editing a service starts a new deployment with your changes, just like the control panel.
- **Set Instances** sets a fixed instance count. To change autoscaling, edit min and max instances instead.
- Organizations on the free Hobby plan have no invoice, so no costs show for them.
- Koyeb marks its invoice API as experimental.
