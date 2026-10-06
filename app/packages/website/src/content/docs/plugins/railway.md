---
title: Railway
description: Manage Railway projects, environments, services, deployments, variables, volumes, domains and TCP proxies, with logs, metrics, estimated costs, credits and usage limits.
sidebar_order: 21
---

## What you can manage

- **Workspaces**: plan, members and their two-factor status, usage this billing period, projected usage, credit balance, and the usage alert and hard limit (editable).
- **Projects**: create, rename, edit the description, PR environments and public visibility, delete.
- **Environments**: create (empty, or copied from another environment), rename, delete.
- **Services**, one per environment they run in: create from a GitHub repository, a Docker image or empty; edit the name, source, builder, build, start and pre-deploy commands, root directory, Dockerfile path, config file, healthcheck, cron schedule, serverless sleeping, restart policy, region, replicas and the CPU and memory limits.
- **Deployments** (the ten most recent per service): redeploy, roll back, restart, stop, cancel, approve, remove.
- **Variables** on a service and **shared variables** on an environment.
- **Volumes**: create and mount on a service, rename, move the mount path, back up now, set daily, weekly or monthly backups, restore a backup, and drag onto another service in the same environment to remount it.
- **Domains**: generate a `*.up.railway.app` domain or add a custom one, change the target port, see the DNS records to add and the certificate state, and retry the certificate.
- **TCP proxies**: expose a port inside a service on a public host and port.

## Credentials

Railway dashboard → avatar menu → **Account Settings → Tokens → Create**. Leave the workspace on **No workspace** for an account token that sees every workspace you belong to, or choose a workspace for a token limited to it. Project tokens are not supported.

After pasting the token, the **Workspace** picker lists the workspaces it can reach; pick one to narrow the account, or leave **All workspaces**. Billing data (usage, credits and usage limits) is only visible to workspace admins.

<insert [Railway Add-account form with the API Token field filled in and the Workspace picker open, listing two workspaces] here>

## Notable flows

- **Deploy controls**: **Deploy Latest Commit** and **Deploy a Commit** build from the connected repository, **Redeploy** rebuilds from the current source and settings, **Restart** restarts the running containers and **Stop** stops them. On any deployment, **Roll Back to This** makes it live again with the variables it was deployed with.
- **Scale** sets replicas and the per-replica vCPU and memory limits. Railway bills what a service uses, up to those limits.
- **Logs**: deploy, build and HTTP request logs for a service's latest deployment or any deployment.
- **Metrics**: CPU, memory, network in and out, and their limits for services, plus request count and p50, p95 and p99 latency for services with a public domain; disk use for volumes.
- **Costs**: daily cost by service, environment and project, priced from Railway's metered CPU, memory, egress, volume and backup usage at the published rates. Rows are marked as estimates.
- **Credits and limits**: the credit balance feeds credit burndown, and a hard usage limit shows on the quotas page as spend against the limit.

<insert [Railway service detail view showing the Deploy Latest Commit, Redeploy and Scale header actions, the Details section and the Endpoints section] here>

<insert [Railway workspace detail view showing usage this period, projected usage, credit balance and the Members table] here>

## Status and posture

- **Status**: incidents from status.railway.com are matched to services, volumes and domains by region (US West, US East, EU West, Southeast Asia) and component. Dashboard and API incidents count for every Railway resource; billing and sign-in incidents are ignored.
- **Posture checks** flag workspaces that do not enforce two-factor sign-in, public projects, and TCP proxies (a public port into a service).
- **Expiry**: custom domain certificates show their expiry on the expiry radar.
- **Savings**: a volume no service mounts is listed as an orphan, since its storage is still billed.

## Tips & limits

- Railway's API allows 100 requests an hour on the Free plan, 1,000 on Hobby and 10,000 on Pro. Infrawrench reads each project in one request and caches it, but deployments, variables and TCP proxies are read per service, so large Hobby workspaces sync those more slowly.
- Cost is usage at list price: it does not include the plan fee, included usage credits or discounts, so it will not match the invoice exactly.
- Changing a service's settings takes effect on its next deploy; use **Redeploy** to apply them now.
- Adding a TCP proxy redeploys the service, because Railway only activates a new proxy on deploy.
- There is no official Railway Terraform provider, so Export to Terraform is not offered.
