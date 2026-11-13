---
title: Render
description: Manage Render services, deploys, environment variables and groups, custom domains, Postgres, Key Value, disks, jobs, projects, Blueprints and maintenance.
sidebar_order: 21
---

## What you can manage

- **Services** of every type: web services, private services, background workers, cron jobs and static sites. Create, edit settings, deploy, roll back, restart, suspend and resume, scale, set autoscaling, toggle maintenance mode and purge the edge cache.
- **Deploys** (the ten most recent per service): status, commit, trigger. Cancel one in progress or roll back to it.
- **Environment variables** set on a service, and **environment groups** with their variables, linked services and secret files.
- **Custom domains** on web services and static sites, with DNS verification.
- **One-off jobs**: run a command on a copy of a service, follow its logs, cancel it.
- **Disks**: attach, resize, rename, move the mount path, list snapshots and restore one.
- **Render Postgres**: create, change instance type and storage, high availability, storage autoscaling and the IP allow list. Restart, suspend, resume, fail over, export, point-in-time recovery, and database users.
- **Render Key Value**: create, change instance type, eviction policy, persistence and the IP allow list. Suspend and resume.
- **Projects and environments**, including environment protection and network isolation.
- **Blueprints**: sync status, recent syncs, auto sync and the YAML path.
- **Maintenance runs**: see what's scheduled, move it, or start it now.
- **Workspaces** with their members and two-factor status.

## Connect your account

1. In the Render dashboard, open the avatar menu, then **Account Settings > API Keys > Create API Key**. Render keys belong to your user and can reach every workspace you're in. There are no scopes to choose.
2. Paste the key. The **Workspace** picker lists the workspaces it can reach. Pick one to limit the account to it, or leave **All workspaces**.

<insert [Render Add-account form with the API Key field filled in and the Workspace picker open, listing a personal and a team workspace] here>

## Things you can do

- **Deploy**: **Deploy** builds the latest commit. **Clear Cache and Deploy** does the same from a clean build cache. **Deploy a Specific Version** takes a commit SHA, or an image tag or digest for an image-backed service. On a deploy, **Roll Back to This Deploy** redeploys that version. Render leaves auto-deploy on after a rollback, so your next push replaces it. If that matters, turn **Auto-Deploy** off in **Edit** first.
- **Scale**: **Scale** sets a fixed instance count. **Autoscaling** sets the minimum, maximum and CPU or memory targets (Render ignores a fixed count while autoscaling is on).
- **Edit a service**: name, branch, root directory, auto-deploy (every commit, after CI checks pass, or off), build, start and pre-deploy commands, instance type, health check path, cron schedule, publish directory and preview environments.
- **Cron jobs**: **Run Now** starts a run (and cancels one in progress). **Cancel Run** stops it.
- **Logs** for services, jobs, Postgres and Key Value. For services, filter to application, request or build logs.
- **Metrics**: CPU, memory and instance count for services, plus request count, p95 latency and bandwidth for web services. CPU, memory, disk use, connections and replication lag for Postgres. CPU, memory and connections for Key Value. Used and total space for disks.
- **Connection details**: Postgres outputs the external, internal and pooled connection strings and the password. Key Value outputs its external and internal URLs. Both open in the SQL and key browser tabs once your IP is in **Allowed Sources**, and export as `DATABASE_URL` or `REDIS_URL`.
- **Environment groups**: create one from `KEY=value` lines, add or change variables, and drag the group onto a service (or use **Link to Service**) to link it.
- **Point-in-time recovery**: create a new database from a Postgres instance as it was at the moment you pick. The detail view shows how far back you can go.

<insert [Render web service detail view showing the Deploy, Scale and Autoscaling header actions, the Details section and the Recent Events table] here>

<insert [Render Postgres detail view showing the Endpoints section, Database Users table and Point-in-Time Recovery status] here>

## Status, security and Terraform

- **Status**: Render incidents show against your resources by region (Oregon, Ohio, Virginia, Frankfurt, Singapore) and product. Dashboard and API incidents count for every Render resource.
- **Posture checks** flag Postgres and Key Value instances whose allow list includes `0.0.0.0/0`, and workspaces that don't enforce two-factor sign-in.
- **Expiry**: free Postgres databases show their expiry date on the expiry radar.
- **Export to Terraform** writes `render_web_service`, `render_private_service`, `render_background_worker`, `render_cron_job`, `render_static_site`, `render_postgres`, `render_keyvalue` and `render_env_group` blocks for the official `render-oss/render` provider, each with its import id. Environment variable values, disks and custom domains aren't included.

## Tips & limits

- Render has no billing API, so Render spend doesn't appear in Costs.
- Render's API allows 400 reads and 30 writes a minute per user, 30 log reads a minute, and 10 deploys, suspends or resumes a minute per service. Large workspaces update deploys, variables, domains and jobs more slowly because of this.
- Creating a service needs a repository Render's connected Git provider can read, or a public image. Private registries need a registry credential set up in the Render dashboard.
- Disks can only grow, and a resize applies while the service is running.
- Environment variable values are fetched when you need them and never stored with the resource.
- Render isn't offered for [CI](../features/ci.md) cloud jobs. A one-off job runs on an existing service's build with all of that service's environment variables, so it can't run a job's own image without handing it your secrets; a cron job made per CI job may carry Render's $1 monthly minimum for each one.
