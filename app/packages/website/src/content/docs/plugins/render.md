---
title: Render
description: Manage Render services, deploys, environment variables and groups, custom domains, Postgres, Key Value, disks, jobs, projects, Blueprints and maintenance.
sidebar_order: 21
---

## What you can manage

- **Services** of every type: web services, private services, background workers, cron jobs and static sites. Create, edit settings, deploy, roll back, restart, suspend and resume, scale, set autoscaling, toggle maintenance mode and purge the edge cache.
- **Deploys** (the ten most recent per service): status, commit, trigger; cancel one in progress or roll back to it.
- **Environment variables** set on a service, and **environment groups** with their variables, linked services and secret files.
- **Custom domains** on web services and static sites, with DNS verification.
- **One-off jobs**: run a command on a copy of a service, follow its logs, cancel it.
- **Disks**: attach, resize, rename, move the mount path, list snapshots and restore one.
- **Render Postgres**: create, change instance type and storage, high availability, storage autoscaling and the IP allow list; restart, suspend, resume, fail over, export, point-in-time recovery, and database users.
- **Render Key Value**: create, change instance type, eviction policy, persistence and the IP allow list; suspend and resume.
- **Projects and environments**, including environment protection and network isolation.
- **Blueprints**: sync status, recent syncs, auto sync and the YAML path.
- **Maintenance runs**: see what is scheduled, move it, or start it now.
- **Workspaces** with their members and two-factor status.

## Credentials

Render dashboard → avatar menu → **Account Settings → API Keys → Create API Key**. Render keys belong to your user and carry its access to every workspace you are in; there are no scopes to choose.

After pasting the key, the **Workspace** picker lists the workspaces it can reach. Pick one to limit the account to it, or leave **All workspaces**.

<insert [Render Add-account form with the API Key field filled in and the Workspace picker open, listing a personal and a team workspace] here>

## Notable flows

- **Deploy controls**: **Deploy** builds the latest commit, **Clear Cache and Deploy** does it from a clean build cache, and **Deploy a Specific Version** takes a commit SHA, or an image tag or digest for an image-backed service. On a deploy, **Roll Back to This Deploy** redeploys that version. Render leaves auto-deploy on after a rollback, so the next push replaces it again; turn **Auto-Deploy** off in **Edit** first if that matters.
- **Scaling**: **Scale** sets a fixed instance count, **Autoscaling** sets the minimum, maximum and CPU or memory targets (Render ignores a fixed count while autoscaling is on).
- **Edit a service**: name, branch, root directory, auto-deploy (every commit, after CI checks pass, or off), build, start and pre-deploy commands, instance type, health check path, cron schedule, publish directory and preview environments.
- **Cron jobs**: **Run Now** triggers a run (and cancels one in progress), **Cancel Run** stops it.
- **Logs** for services, jobs, Postgres and Key Value, filterable to application, request or build logs for services.
- **Metrics**: CPU, memory and instance count for services, plus request count, p95 latency and bandwidth for web services; CPU, memory, disk use, connections and replication lag for Postgres; CPU, memory and connections for Key Value; used and total space for disks.
- **Connection details**: Postgres outputs the external, internal and pooled connection strings and the password; Key Value outputs its external and internal URLs. Both open in the SQL and key browser tabs once your IP is in **Allowed Sources**, and export as `DATABASE_URL` or `REDIS_URL`.
- **Environment groups**: create one from `KEY=value` lines, add or change variables as children, and drag the group onto a service (or use **Link to Service**) to link it.
- **Point-in-time recovery** creates a new database from a Postgres instance as it was at the chosen moment. The detail view shows how far back you can go.

<insert [Render web service detail view showing the Deploy, Scale and Autoscaling header actions, the Details section and the Recent Events table] here>

<insert [Render Postgres detail view showing the Endpoints section, Database Users table and Point-in-Time Recovery status] here>

## Status, security and Terraform

- **Status**: incidents on status.render.com are matched to your resources by region (Oregon, Ohio, Virginia, Frankfurt, Singapore) and product. Dashboard and API incidents count for every Render resource.
- **Posture checks** flag Postgres and Key Value instances whose allow list includes `0.0.0.0/0`, and workspaces that do not enforce two-factor sign-in.
- **Expiry**: free Postgres databases show their expiry date on the expiry radar.
- **Export to Terraform** writes `render_web_service`, `render_private_service`, `render_background_worker`, `render_cron_job`, `render_static_site`, `render_postgres`, `render_keyvalue` and `render_env_group` blocks for the official `render-oss/render` provider, each with its import id. Environment variable values, disks and custom domains are not included.

## Tips & limits

- Render has no billing API, so Render spend does not appear in Costs.
- Render's API is limited to 400 reads and 30 writes a minute per user, 30 log reads a minute, and 10 deploys, suspends or resumes a minute per service. Large workspaces sync children (deploys, variables, domains, jobs) more slowly for that reason.
- Creating a service needs a repository Render's connected Git provider can read, or a public image. Private registries need a registry credential set up in the Render dashboard.
- Disks can only grow, and a resize applies while the service is running.
- Render returns environment variable values in plain text to any key holder; Infrawrench resolves them on demand and never stores them with the resource.
