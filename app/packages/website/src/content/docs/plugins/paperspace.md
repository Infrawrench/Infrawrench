---
title: Paperspace
description: Manage Paperspace machines, snapshots, custom templates, shared drives, private networks, static IPs, startup scripts, projects, deployments and registry credentials.
sidebar_order: 50
---

Paperspace, part of DigitalOcean since 2023, rents GPU and CPU virtual machines and runs container deployments. The plugin uses Paperspace's current API (the one that replaced the retired Core and Gradient APIs in May 2024).

## What you can manage

- **Machines**: create with a region, template (Paperspace's OS templates and your own), machine type, disk size, public IP type, private network, startup script and auto shutdown. Start, stop, restart and take a snapshot from the header. Edit the name, machine type (resizing needs the machine off), public IP type, auto shutdown and auto snapshot settings; delete.
- **Snapshots**: create from any machine, rename, restore (a safety snapshot of the current disk is taken first), delete.
- **Custom templates**: make one from a machine, rename, delete. They appear in the machine create form under My Templates.
- **Shared drives**: create on a private network with a size picker, rename, delete. The mount point and username are shown; the SMB password is fetched from Paperspace when you reference it and never stored.
- **Private networks**: create in a region (optionally moving that region's machines into it), rename, delete.
- **Public IPs**: claim a static IP in a region, drag it onto a machine in the same region to assign it, release it with delete.
- **Startup scripts**: create, edit the name, script, enabled flag and whether it runs once; drag one onto a machine to assign it, or unassign it from every machine from the header.
- **Projects** and their **deployments**: create, rename and delete projects; each deployment shows its image, machine type, replicas and endpoint URL, with request rate, request duration, CPU, memory and GPU charts, and can be deleted.
- **Container registry credentials**: create, edit (including replacing the password), test the connection from the header, delete.

<insert [The Paperspace create machine form with the template picker open showing OS templates and My Templates, and the machine type select] here>

<insert [A Paperspace deployment detail page showing the endpoint URL and the request rate and GPU utilization charts] here>

## Credentials

In the Paperspace console click your profile icon, then **Team Settings**, then the **API Keys** tab. Enter a name and click **Add**, and copy the key; it is shown once.

Keys are team-scoped: the account sees every machine and deployment in that team. Add one account per team.

<insert [The Add account form for Paperspace with the API Key field] here>

## Cost

Paperspace billing moved to DigitalOcean's billing system and the Paperspace API has no billing endpoints, so the plugin does not report spend. Each machine shows the usage and storage rates Paperspace reports for it.

## Savings and governance

- **Orphan finder**: machines that are off (their disk keeps billing) and static IPs not assigned to a machine.
- **Sleep schedules**: machines can be stopped and started on a schedule; Paperspace's own auto shutdown is editable on each machine.
- **Provider status**: incidents on [status.paperspace.com](https://status.paperspace.com) are matched to the regions (NY2, CA1, AMS1) your machines run in, and to deployments and the streaming desktop.

## Quirks

- Paperspace only accepts fixed disk sizes (50 GB to 16 TB).
- Resizing a machine or making a template from it needs the machine to be off.
- The machine create form lists every machine type any template supports; Paperspace rejects combinations a template does not support or a region has no capacity for.
- Startup script bodies are write-only: Paperspace never returns them, so the edit form only changes a script when you type a new one.
- Deployments are read-only here apart from delete: their spec is edited through Paperspace's deployment config files.
- The Paperspace Terraform provider targets the retired legacy API, so there is no Terraform export.
