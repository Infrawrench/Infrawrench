---
title: Northflank
description: Manage Northflank projects, services, jobs, database addons, secret groups, volumes, pipelines, domains and BYOC clusters, with logs, metrics and daily spend by project.
sidebar_order: 50
---

Connect a Northflank team to see and run everything it hosts: deploy and scale services, run jobs, manage database addons, and follow spend per project.

## What you can manage

- **Projects**: every project with its region (or BYOC cluster) and how many services, jobs and addons it holds. Create projects in a Northflank region or on one of your BYOC clusters, edit the description and colour, and delete empty projects.
- **Services**: combined (build and deploy from Git), deployment (container image) and build services, with their state, instance count, compute plan, image or repository, public URLs, ports, recent builds and deployments, and the names of their runtime variables. Create a service from an image or a Git repository (picked from the repositories your linked Git accounts can see). Actions: **Restart**, **Pause** and **Resume**, **Scale** (instances and compute plan), **Start build**, **Clear build cache**, **Deploy image**, **Deploy latest build**, **Set variables** and **Remove variables**. Edit the description and instance count.
- **Jobs**: cron and manual jobs with their schedule, concurrency policy, retries, timeout and recent runs. Create a job from an image, **Run now**, **Suspend schedule** and **Resume schedule**, **Start build** for Git jobs, **Change plan**, and set or remove runtime variables. Edit the schedule, concurrency, retries, timeout and description.
- **Addons**: PostgreSQL, MySQL, MongoDB, Redis, RabbitMQ, MinIO and the other managed addons, with version, version support status, plan, replicas, storage and networking. Create an addon with pickers for the type, version, plan, storage and replicas each type offers. Actions: **Pause**, **Resume**, **Restart**, **Scale**, **Back up now** (snapshot or native dump), **Upgrade version**, **Rotate credentials** and **Finish rotation**. Edit the description, TLS and public access. The connection string, host, port, username, password and database are outputs.
- **Secret groups**: project secret groups, with what they're injected into and their priority. Create a group with its variables, edit the description, injection scope and priority, and **Set variables** or **Remove variables** without retyping the rest.
- **Volumes**: size, storage class and what each volume is attached to, plus its backups. Create a volume (optionally attached to a service), grow it, **Back up now**, **Attach** and **Detach**.
- **Pipelines**: the services, jobs and addons in each stage and recent release flow runs. **Run release flow** for a stage.
- **Domains and subdomains**: the TXT record that verifies a domain, and each subdomain's CNAME, verification state and certificate expiry. Add domains and subdomains, **Verify**, **Assign to service** (picking a public port), **Unassign**, and turn the Northflank CDN on, off, or purge it.
- **BYOC clusters**: provider, region, state, node pools and the running nodes, with **Cordon**, **Uncordon** and **Drain** per node.
- **Account**: the token's team or organisation, its API role and expiry (which shows on the Expiry radar), the invoice history and this month's spend so far.

<insert [Northflank service detail page showing the Service section, Ports table and Recent deployments table, with the Scale and Deploy image actions in the header] here>

## Open a database console

PostgreSQL, MySQL, MongoDB and Redis addons open in the matching Infrawrench console (SQL editor, document browser or key browser) using the addon's connection string. Northflank addons are private to the project by default. To reach one from Infrawrench, turn on **TLS** and **Public access** with Edit.

## Connect your account

1. In Northflank, go to your team's settings > **API > Tokens** and create an API token.
2. Give its **API role** read access to projects, services, jobs, addons, secrets, volumes, pipelines, domains and clusters for the inventory, the matching Manage permissions for the actions you plan to use, and **Billing > Read** for costs.
3. Paste the token into Infrawrench. For an organisation token, pick the team from the **Team** list, since it acts for one team at a time. Team tokens already belong to their team, so leave **Team** empty.

<insert [Northflank Add-account form with the API Token filled in and the Team picker open, listing the organisation's teams] here>

## Logs and metrics

Services, jobs and addons have a Logs tab with the last 24 hours of runtime logs. Services and jobs also show build logs. The Metrics tab charts CPU, memory, and network in and out. Services also show requests, HTTP 4xx and 5xx responses and open TCP connections, and addons show disk usage. Replicas are added together, except percentages, which are averaged.

## Costs

The Costs page shows daily Northflank spend split by **project** and by CPU, memory, storage and GPU. BYOC, egress IP and load balancer charges are account-wide and appear without a project. Accounts with more than 40 projects show spend by category only, to stay inside Northflank's API rate limit.

## Status

Incidents on [status.northflank.com](https://status.northflank.com) show on your Northflank resources: an Addons incident on addons, a Builds incident on services and jobs, and an API, app or networking incident on everything.

## Run CI jobs

A Northflank connection can run [Infrawrench CI](../features/ci.md) cloud jobs once an organization admin opts it in. Each `container` job is a manual job named `iwci-` and 32 more characters, run once in a project named `infrawrench-ci-<region>` that Infrawrench makes the first time a job runs in that region and keeps. When the job ends, Infrawrench aborts the run if it's still going and deletes the job.

| `cloud.kind` | Runs on              | Default `machine` | Default `image`             | Default `region` |
| ------------ | -------------------- | ----------------- | --------------------------- | ---------------- |
| `container`  | A Northflank job run | `nf-compute-200`  | `buildpack-deps:noble-curl` | `europe-west`    |

`machine` is a Northflank compute plan, such as `nf-compute-100-2`, `nf-compute-200`, `nf-compute-400-16` or `nf-compute-800-16`. `region` is a Northflank region such as `us-central` or `europe-west-netherlands`; teams that only deploy to their own cloud (BYOC) aren't supported yet. The image needs `sh` and `base64`: the job's script reaches the container as a runtime file, encoded so Northflank's `${...}` templating leaves it alone. Jobs here have no GPUs.

The job's `activeDeadlineSeconds` is its time limit, so Northflank fails the run then even if Infrawrench can't. A job gets no Northflank token and no runtime variables; its tags are kept in its description, which is how Infrawrench finds its jobs again. Jobs are billed by the second at the plan's rate.

Northflank doesn't publish the permission names an API role carries, so opting the connection in checks that the token can read projects, that an organisation token has a team picked, and that its role isn't restricted to some projects. Give the token's API role, under Project: **Projects** Create and Read, and **Jobs** Create, Read, Run Job, Update and Delete.

Northflank builds aren't offered as a `build` kind. A build runs your commands as `RUN` steps of a Dockerfile, where there's no Docker daemon to build or push with, and it needs its source from a linked repository or an archive URL. Run Docker builds as a job on a provider that offers `build` or `vm`.

## Tips and limits

- Northflank allows 1000 API requests per hour per account by default (ask Northflank support for more). Infrawrench keeps well inside that, even for a large team, by loading details such as builds, deployments, ports and backups only when you open a resource.
- Teams with more than 40 projects or domains refresh in turns: each sync reads the per-project lists (services, jobs, addons, secret groups, volumes, pipelines) for 40 projects and the details of 40 domains, starting somewhere different each time. The rest keep their last values until their turn comes.
- Plan, image and networking details for services and addons fill in the first time you open the resource or refresh it.
- Runtime variable values are never shown here, only their names. Setting variables restarts the workload.
- Northflank has no official Terraform provider, so Export to Terraform isn't available.
