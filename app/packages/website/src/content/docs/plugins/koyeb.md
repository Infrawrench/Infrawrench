---
title: Koyeb
description: Manage Koyeb apps, services, Postgres databases, deployments, instances, secrets, domains, volumes and snapshots, with logs, metrics, the current invoice, quotas and a spending alert.
sidebar_order: 21
---

## What you can manage

- **Organization**: plan and status, the current invoice, quota usage, and the monthly **spending alert** (editable).
- **Projects**: create, rename, edit the description, delete.
- **Apps**: create, rename, pause, resume, delete.
- **Services**: web services, workers and managed Postgres databases. Create from a Docker image or a GitHub repository (instance type and region pickers from Koyeb's catalog), edit the instance type, regions, min and max instances, image, branch, build and run commands; redeploy (with or without the build cache), set a fixed instance count, pause, resume, delete.
- **Deployments** (the ten most recent per service): status, commit and image; cancel one in progress, or redeploy an earlier version (pinned to the commit it built).
- **Instances**: the running replicas, with their region, datacenter and logs.
- **Secrets**: create, update the value, delete; the value is available as an output.
- **Domains**: add a custom domain to an app, see the CNAME target, and re-check DNS.
- **Volumes**: create, rename, grow, delete, and take snapshots. **Snapshots** are listed and can be deleted.

## Credentials

Koyeb control panel → **Settings → API → Create API access token**. The token belongs to that organization and has full access to it; Koyeb shows it once.

<insert [Koyeb Add-account form with the API Access Token field filled in] here>

## Notable flows

- **Postgres databases** expose a **Connection String** output (built from the database host and its owner role's password) that opens in the PostgreSQL tab and exports as `DATABASE_URL`.
- **Logs**: runtime, build and Koyeb system logs for services, deployments and single instances, from the last 24 hours (retention depends on your plan).
- **Metrics** for web services and workers: CPU and memory, plus requests, p50, p90 and p99 response time and public data in and out for web services.
- **Rollback**: **Redeploy This Version** on an earlier deployment sends its definition back as the service's configuration, pinned to the commit it built.
- **Costs**: the lines of the organization's open invoice (plan fee, each instance type, database compute and storage) are imported for the current month, with discounts as a credit. Koyeb does not expose past invoices, so history builds up from the day the account is connected.
- **Quotas**: apps, services, memory, domains, TCP proxy ports, instances per type, volume storage per region and instance snapshots, each against your plan's limit.

<insert [Koyeb service detail view showing the Redeploy, Set Instances and Pause header actions and the Details section with instance type and scaling] here>

<insert [Koyeb organization detail view showing the Quotas table and the Current Invoice table] here>

## Status and Terraform

- **Status**: incidents from status.koyeb.com are matched to services, instances and volumes by region (Frankfurt, Paris, Washington, San Francisco, Singapore, Tokyo, or a whole continent). API, control panel and build incidents count for every Koyeb resource.
- **Savings**: a volume no service uses is listed as an orphan.
- **Export to Terraform** writes `koyeb_app`, `koyeb_secret` (with the value as a sensitive variable) and `koyeb_volume` blocks for the official `koyeb/koyeb` provider, which reads its token from `KOYEB_TOKEN`. Services are not exported: their full deployment definition is not kept in inventory.

## Tips & limits

- Editing a service starts a new deployment with the changed definition, as the control panel does.
- **Set Instances** sets a fixed instance count through Koyeb's scaling endpoint; edit min and max instances to change autoscaling.
- Organizations on the free Hobby plan have no invoice, so no costs appear for them.
- The invoice endpoint is marked experimental in Koyeb's API.
