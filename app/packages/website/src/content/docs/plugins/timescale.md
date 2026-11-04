---
title: Tiger Cloud (Timescale)
description: Manage Tiger Data's Tiger Cloud services, replicas, forks, VPCs, IP allow lists and exporters, with metrics, logs and a PostgreSQL console.
sidebar_order: 50
---

Use this plugin to manage Tiger Cloud from Tiger Data (the company formerly called Timescale; Tiger Cloud was Timescale Cloud). Every service opens in the [PostgreSQL](./postgres.md) tab, so the SQL editor and table browser are the ones you already know.

## What you can manage

- **Projects**: the project your client credential belongs to, with its service count.
- **Services** (TimescaleDB or plain PostgreSQL): region, status, compute, HA replicas, connection pooler, VPC, tiered storage, backup retention, resource usage and endpoints. Create, edit, delete, and:
  - **Edit** to rename the service and change its **compute** (from the CPU and memory pairs Tiger Cloud offers), **environment** (DEV or PROD), **HA replicas** and **synchronous replicas**, the **connection pooler**, **tiered storage** (on only; turning it off needs Tiger Data support) and **backup retention** in days.
  - **Pause** and **Resume**. Paused services stop compute billing. Sleep/wake schedules can do this for you.
  - **Fork** from now, from the last snapshot, or from a point in time (a recovery fork), with its own compute and environment.
  - **Set password** for `tsdbadmin`. Tiger Cloud never shows a password after creation, so Infrawrench keeps the one you set (and the first password of services created here) to build connection strings.
  - **Attach to VPC** or **Detach from VPC** (AWS regions), picking from the project's VPCs in the service's region.
  - **Attach exporter** and **Detach exporter**, picking from the project's exporters in the service's region.
  - **IP allow list**: attach a list or remove the restriction.
  - **Cross-region backups**: start or stop copying backups to another region.
- **Read replica sets**: nodes, compute per node, endpoint and pooler. Create from a service, resize, change environment, toggle the pooler, delete. Each one has its own PostgreSQL tab, using the primary's password.
- **VPCs** (AWS regions): create with a CIDR and region, rename, delete.
- **VPC peerings** to your AWS VPCs: create with your account id, VPC id and region, then accept the request in AWS. Delete.
- **Exporters** (preview): Datadog, Prometheus, CloudWatch metrics, CloudWatch logs and Azure Monitor. Create with the destination's settings, rename, toggle PostgreSQL metrics, rotate the destination credential, delete. An exporter no service sends to shows under **Potential savings**.
- **IP allow lists** (preview): create, edit the description and CIDR blocks, delete.
- **Backups** (preview): the full and incremental backups Tiger Cloud took, with size, duration and which regions hold a copy.

<insert [Tiger Cloud service detail page showing the Compute and storage section and the Pause, Set password, Fork and Attach exporter buttons] here>

## Connect your project

Tiger Cloud uses a **client credential**: a public key and a secret key.

1. In the [Tiger Cloud console](https://console.cloud.tigerdata.com), open the project menu at the top left and choose **Project settings**.
2. Click **Create credentials**, and copy the public key and the secret key. The secret is shown once.

A client credential belongs to one project and has full access to it. To manage several projects, add one account per project.

<insert [Tiger Cloud Add-account form with the Public Key and Secret Key fields] here>

## Open the PostgreSQL tab

The **PostgreSQL** tab connects as `tsdbadmin` to the `tsdb` database with `sslmode=require`. Tiger Cloud doesn't reveal passwords, so the first time you open it for a service created outside Infrawrench, you'll see **Set tsdbadmin password**. Leave the field blank to generate a strong password. Clients using the old password will stop connecting, so update them with the new value from the service's **Connection String** output.

## Metrics and logs

- The service Metrics tab shows CPU and memory utilization, CPU, memory and storage used against their limits, disk reads and writes, queries per second and connections. The default window is six hours.
- The Logs tab pages through the PostgreSQL log, newest last, with an option to show only warnings and errors.

## Status

Incidents and maintenance from [status.tigerdata.com](https://status.tigerdata.com) appear against your services. Maintenance notices that name regions only mark services in those regions.

## Terraform export

Export to Terraform covers services, VPCs and VPC peerings for the `timescale/timescale` provider, with import ids. Passwords aren't exported. Read replica sets, exporters and IP allow lists are left out.

## Tips & limits

- There's no billing API, so Tiger Cloud spend doesn't appear in cost graphs.
- Tiger Cloud doesn't say which IP allow list a service uses. Choosing a list replaces whichever is attached. Choosing none detaches every list in the project from that service.
- Exporters, IP allow lists and backups are preview features Tiger Data may change. If your plan doesn't include them, those lists are empty.
- VPCs and peering are AWS-only. Azure regions start with `az-`, for example `az-eastus2`.
