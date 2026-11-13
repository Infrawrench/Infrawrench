---
title: Railway
description: Manage Railway projects, environments, services, deployments, variables, volumes, domains and TCP proxies, with logs, metrics, estimated costs, credits and usage limits.
sidebar_order: 21
---

## What you can manage

- **Workspaces**: plan, members and their two-factor status, usage this billing period, projected usage, credit balance, and the usage alert and hard limit (editable).
- **Projects**: create, rename, edit the description, PR environments and public visibility, delete.
- **Environments**: create (empty, or copied from another environment), rename, delete.
- **Services**, one per environment they run in: create from a GitHub repository, a Docker image or empty. Edit the name, source, builder, build, start and pre-deploy commands, root directory, Dockerfile path, config file, healthcheck, cron schedule, serverless sleeping, restart policy, region, replicas and the CPU and memory limits.
- **Deployments** (the ten most recent per service): redeploy, roll back, restart, stop, cancel, approve, remove.
- **Variables** on a service and **shared variables** on an environment.
- **Volumes**: create and mount on a service, rename, move the mount path, back up now, set daily, weekly or monthly backups, restore a backup, and drag onto another service in the same environment to remount it.
- **Domains**: generate a `*.up.railway.app` domain or add a custom one, change the target port, see the DNS records to add and the certificate state, and retry the certificate.
- **TCP proxies**: expose a port inside a service on a public host and port.

## Connect with Railway

1. Pick Railway in the add-account form and click **Connect with Railway**.
2. Sign in to Railway, choose which workspaces to share, and approve.

If you share one workspace, the **Workspace** picker and the account name are filled in for you. If you share several, the account covers all of them unless you narrow it.

- **What you're granting:** your name and email, ongoing access so you stay connected, and admin-level access to the workspaces you pick. Railway caps that at your own role. In a workspace where you're a member, Infrawrench gets member access, and usage limits and credits stay hidden. Infrawrench asks for admin so it can read and set usage limits. Everything else (deploys, restarts, rollbacks, variables, volumes, domains) works at member level.
- **Staying connected:** the connection renews itself.
- **Revoking:** revoke Infrawrench in your Railway account settings. The account then shows **Reconnect required**.
- Works in the web app, the desktop app in cloud mode and desktop-local accounts.

## Use a token instead

1. In the Railway dashboard, open the avatar menu, then **Account Settings > Tokens > Create**.
2. Leave the workspace on **No workspace** for an account token that sees every workspace you belong to, or choose a workspace to limit the token to it. Project tokens aren't supported.
3. Paste the token. The **Workspace** picker lists the workspaces it can reach. Pick one to narrow the account, or leave **All workspaces**.

Billing data (usage, credits and usage limits) is only visible to workspace admins.

<insert [Railway Add-account form with the API Token field filled in and the Workspace picker open, listing two workspaces] here>

## Things you can do

- **Deploy**: **Deploy Latest Commit** and **Deploy a Commit** build from the connected repository. **Redeploy** rebuilds from the current source and settings. **Restart** restarts the running containers and **Stop** stops them. On any deployment, **Roll Back to This** makes it live again with the variables it was deployed with.
- **Scale**: set replicas and the per-replica vCPU and memory limits. Railway bills what a service uses, up to those limits.
- **Logs**: deploy, build and HTTP request logs for a service's latest deployment or any deployment.
- **Metrics**: CPU, memory, network in and out, and their limits for services, plus request count and p50, p95 and p99 latency for services with a public domain. Disk use for volumes.
- **Costs**: daily cost by service, environment and project, priced from your metered CPU, memory, egress, volume and backup usage at Railway's published rates. Rows are marked as estimates.
- **Credits and limits**: your credit balance feeds credit burndown, and a hard usage limit shows on the quotas page as spend against the limit.

<insert [Railway service detail view showing the Deploy Latest Commit, Redeploy and Scale header actions, the Details section and the Endpoints section] here>

<insert [Railway workspace detail view showing usage this period, projected usage, credit balance and the Members table] here>

## Status and posture

- **Status**: Railway incidents show against your services, volumes and domains by region (US West, US East, EU West, Southeast Asia) and component. Dashboard and API incidents count for every Railway resource. Billing and sign-in incidents are left out.
- **Posture checks** flag workspaces that don't enforce two-factor sign-in, public projects, and TCP proxies (a public port into a service).
- **Expiry**: custom domain certificates show their expiry on the expiry radar.
- **Savings**: a volume no service mounts is listed as an orphan, since you still pay for its storage.

## Run CI jobs

A Railway connection can run [Infrawrench CI](../features/ci.md) cloud jobs once an organization admin opts it in. Each `container` job gets a project of its own, named `iwci-` and 32 more characters, in the connection's workspace (pick one on the connection when the token reaches several). It holds one service that deploys the job's image once with the restart policy **Never**, so when the job's script ends the container stops and isn't restarted. When the job ends, Infrawrench deletes the project.

| `cloud.kind` | Runs on                                 | Default `machine` | Default `image`             |
| ------------ | --------------------------------------- | ----------------- | --------------------------- |
| `container`  | A one-off deployment in its own project | `2vcpu-4gb`       | `buildpack-deps:noble-curl` |

`machine` is the service's CPU and memory limits as `<vCPUs>vcpu-<GB>gb`, within your plan's per-service maximum. `region` is a Railway region such as `us-west2`, `us-east4-eqdc4a`, `europe-west4-drams3a` or `asia-southeast1-eqsg3a`; without one the job runs in your workspace's preferred region. The image needs `sh` and `base64`. Railway services have no GPUs.

The service's only variable is the job's script; a container gets Railway's own `RAILWAY_*` names and no token. Railway has no time limit for a deployment, so the job runs under a watchdog that stops it when its time is up. Railway bills the CPU and memory the container uses, by the minute. Its tags are kept in the project's description, which is how Infrawrench finds its projects again.

Railway tokens have no scopes to check, so opting the connection in reads the workspace's projects. The token's owner needs a workspace role that can create projects (Member or Admin); a workspace token can.

## Tips & limits

- Railway's API allows 100 requests an hour on the Free plan, 1,000 on Hobby and 10,000 on Pro, so large Hobby workspaces update more slowly.
- Cost is usage at list price. It doesn't include the plan fee, included usage credits or discounts, so it won't match your invoice exactly.
- Changes to a service's settings take effect on its next deploy. Use **Redeploy** to apply them now.
- Adding a TCP proxy redeploys the service, since Railway only turns on a new proxy at deploy time.
- There's no official Railway Terraform provider, so Export to Terraform isn't offered.
