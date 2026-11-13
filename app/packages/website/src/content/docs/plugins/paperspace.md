---
title: Paperspace
description: Manage Paperspace machines, snapshots, custom templates, shared drives, private networks, static IPs, startup scripts, projects, deployments and registry credentials.
sidebar_order: 50
---

Paperspace, part of DigitalOcean since 2023, rents GPU and CPU virtual machines and runs container deployments. This plugin works with Paperspace's current API, which replaced the retired Core and Gradient APIs in May 2024.

## What you can manage

- **Machines**: create with a region, template (Paperspace's OS templates and your own), machine type, disk size, public IP type, private network, startup script and auto shutdown. Start, stop, restart and take a snapshot from the header. Edit the name, machine type (resizing needs the machine off), public IP type, auto shutdown and auto snapshot settings, or delete.
- **Snapshots**: create from any machine, rename, restore (a safety snapshot of the current disk is taken first), delete.
- **Custom templates**: make one from a machine, rename, delete. They appear in the machine create form under My Templates.
- **Shared drives**: create on a private network with a size picker, rename, delete. The mount point and username are shown. The SMB password is fetched from Paperspace when you need it and never stored.
- **Private networks**: create in a region (optionally moving that region's machines into it), rename, delete.
- **Public IPs**: claim a static IP in a region, drag it onto a machine in the same region to assign it, and delete it to release it.
- **Startup scripts**: create them and edit the name, script, enabled flag and whether it runs once. Drag one onto a machine to assign it, or unassign it from every machine from the header.
- **Projects** and their **deployments**: create, rename and delete projects. Each deployment shows its image, machine type, replicas and endpoint URL, with request rate, request duration, CPU, memory and GPU charts, and can be deleted.
- **Container registry credentials**: create, edit (including replacing the password), test the connection from the header, delete.

<insert [The Paperspace create machine form with the template picker open showing OS templates and My Templates, and the machine type select] here>

<insert [A Paperspace deployment detail page showing the endpoint URL and the request rate and GPU utilization charts] here>

## Connect your team

1. In the Paperspace console, click your profile icon, then **Team Settings**, then the **API Keys** tab.
2. Enter a name, click **Add**, and copy the key. It's only shown once.

Keys belong to a team, so the account sees every machine and deployment in that team. Add one account per team.

<insert [The Add account form for Paperspace with the API Key field] here>

## Cost

Paperspace billing now lives in DigitalOcean's billing system, so this plugin doesn't report spend. Each machine shows the usage and storage rates Paperspace reports for it.

## Savings and governance

- **Orphan finder**: machines that are off (their disk keeps billing) and static IPs not assigned to a machine.
- **Sleep schedules**: stop and start machines on a schedule. You can also edit Paperspace's own auto shutdown on each machine.
- **Provider status**: incidents on [status.paperspace.com](https://status.paperspace.com) show against the regions (NY2, CA1, AMS1) your machines run in, and against deployments and the streaming desktop.

## Run CI jobs

A Paperspace connection can run [Infrawrench CI](../features/ci.md) cloud jobs once an organization admin opts it in. Each `vm` job gets a fresh Paperspace machine in the job's `cloud.region` (`ny2` when it names none), which is deleted when the job ends:

| `cloud.kind` | Runs on              | Default `machine` | Default `image` |
| ------------ | -------------------- | ----------------- | --------------- |
| `vm`         | A Paperspace machine | `C5`              | Ubuntu 22.04    |

`machine` is a Paperspace machine type such as `C5`, `C7`, `A4000`, `A6000`, `A100-80G` or `H100`, or a multi-GPU type such as `A6000x4` or `H100x8`. Instead of a machine you can name a GPU with `cloud.gpu`: `a6000` becomes `A6000`, `a6000:4` becomes `A6000x4`, `a100-80gb:8` becomes `A100-80Gx8`. `image` is an OS template's name or ID; the template has to offer the machine type in the region.

The job reaches the machine as a run-once startup script named after it, which is deleted with the machine. The machine holds no Paperspace credentials, gets a dynamic public IP and no snapshots, and Paperspace doesn't email a password for it.

Paperspace machines have no tags, so a job's machine is named `iwci-` followed by the job's key and your organization's CI tag. Leave machines named like that alone: Infrawrench deletes any it no longer has a job for.

Paperspace bills machines by the hour. A machine powers itself off when the job ends or its time is up (Paperspace's own auto-shutdown is set to the same deadline too), which stops compute billing, but its disk keeps billing until the machine is deleted. Infrawrench deletes it when the job ends, and again later if that fails.

Paperspace API keys carry no scopes, so opting in only checks that the key can read machines, startup scripts and OS templates, and that the Ubuntu template runs on `C5`.

## Quirks

- Paperspace only accepts fixed disk sizes (50 GB to 16 TB).
- Resizing a machine or making a template from it needs the machine to be off.
- The machine create form lists every machine type any template supports. Paperspace rejects combinations a template doesn't support or a region has no capacity for.
- You can't read a startup script back after saving it. The edit form only changes the script when you type a new one.
- Deployments are read-only here, apart from delete. Edit their spec through Paperspace's deployment config files.
- There's no Terraform export, since the Paperspace Terraform provider only supports the retired API.
