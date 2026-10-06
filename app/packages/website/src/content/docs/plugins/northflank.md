---
title: Northflank
description: Manage Northflank projects, services, jobs, database addons, secret groups, volumes, pipelines, domains and BYOC clusters, with logs, metrics and daily spend by project.
sidebar_order: 50
---

Connect a Northflank team to see and operate everything it runs: deploy and scale services, run jobs, manage database addons, and follow spend per project.

## What you can manage

- **Projects**: every project with its region (or BYOC cluster) and how many services, jobs and addons it holds. Create projects in a Northflank region or on one of your BYOC clusters, edit the description and colour, and delete empty projects.
- **Services**: combined (build and deploy from Git), deployment (container image) and build services, with their state, instance count, compute plan, image or repository, public URLs, ports, recent builds and deployments, and the names of their runtime variables. Create a service from an image or a Git repository (picked from the repositories your linked Git accounts can see). Actions: **Restart**, **Pause** and **Resume**, **Scale** (instances and compute plan), **Start build**, **Clear build cache**, **Deploy image**, **Deploy latest build**, **Set variables** and **Remove variables**. Edit the description and instance count.
- **Jobs**: cron and manual jobs with their schedule, concurrency policy, retries, timeout and recent runs. Create a job from an image, **Run now**, **Suspend schedule** and **Resume schedule**, **Start build** for Git jobs, **Change plan**, and set or remove runtime variables. Edit the schedule, concurrency, retries, timeout and description.
- **Addons**: PostgreSQL, MySQL, MongoDB, Redis, RabbitMQ, MinIO and the other managed addons, with version, version support status, plan, replicas, storage and networking. Create an addon with pickers for the type, version, plan, storage and replicas each type offers. Actions: **Pause**, **Resume**, **Restart**, **Scale**, **Back up now** (snapshot or native dump), **Upgrade version**, **Rotate credentials** and **Finish rotation**. Edit the description, TLS and public access. The connection string, host, port, username, password and database are outputs.
- **Secret groups**: project secret groups with what they are injected into and their priority. Create a group with its variables, edit the description, injection scope and priority, and **Set variables** or **Remove variables** without retyping the rest.
- **Volumes**: size, storage class and what each volume is attached to, plus its backups. Create a volume (optionally attached to a service), grow it, **Back up now**, **Attach** and **Detach**.
- **Pipelines**: the services, jobs and addons in each stage and recent release flow runs. **Run release flow** for a stage.
- **Domains and subdomains**: the TXT record that verifies a domain, each subdomain's CNAME, verification state and certificate expiry. Add domains and subdomains, **Verify**, **Assign to service** (picking a public port), **Unassign**, and enable, disable or purge the Northflank CDN.
- **BYOC clusters**: provider, region, state, node pools and the running nodes, with **Cordon**, **Uncordon** and **Drain** per node.
- **Account**: the token's team or organisation, its API role and expiry (which feeds the Expiry radar), the invoice history and this month's spend so far.

<insert [Northflank service detail page showing the Service section, Ports table and Recent deployments table, with the Scale and Deploy image actions in the header] here>

## Database consoles

PostgreSQL, MySQL, MongoDB and Redis addons open in the matching Infrawrench console (SQL editor, document browser or key browser) using the addon's connection string. Northflank addons are private to the project by default; turn on **TLS** and **Public access** with Edit to give the addon an address Infrawrench can reach.

## Credentials

Create an API token in Northflank under your team's settings, **API → Tokens**. A token uses an **API role**, which decides what it can do: give the role read access to projects, services, jobs, addons, secrets, volumes, pipelines, domains and clusters for the inventory, the matching Manage permissions for the actions you plan to use, and **Billing → Read** for costs.

Organisation tokens act for one team at a time: after pasting the token, pick the team from the **Team** list. Team tokens are already scoped to their team, so leave **Team** empty.

<insert [Northflank Add-account form with the API Token filled in and the Team picker open, listing the organisation's teams] here>

## Logs and metrics

Services, jobs and addons have a Logs tab with the last 24 hours of runtime logs; services and jobs also show build logs. The Metrics tab charts CPU, memory, network in and out, and for services requests, HTTP 4xx and 5xx responses and open TCP connections (addons also show disk usage). Replicas are summed, except percentages, which are averaged.

## Costs

Northflank's billing API reports spend per day, so the Costs page shows daily Northflank spend split by **project** and by CPU, memory, storage and GPU. BYOC, egress IP and load balancer charges are account-wide and appear without a project. Accounts with more than 40 projects show spend by category only, to stay inside Northflank's API rate limit.

## Status

Incidents on [status.northflank.com](https://status.northflank.com) show on your Northflank resources: an Addons incident on addons, a Builds incident on services and jobs, and an API, app or networking incident on everything.

## Limits

- Northflank allows 1000 API requests per hour per account by default (ask Northflank support for more). Infrawrench syncs with list calls only and loads details such as builds, deployments, ports and backups when you open a resource, so a sync of a large team stays well inside the budget.
- Service and addon listings do not include every setting; plan, image and networking fields fill in the first time you open the resource or refresh it.
- Runtime variable values are never shown here, only their names. Setting variables restarts the workload.
- Northflank has no official Terraform provider, so Export to Terraform is not available.
