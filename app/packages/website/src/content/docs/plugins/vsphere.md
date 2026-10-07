---
title: VMware vSphere
description: Manage vCenter Server inventory - VMs with power actions, clone, migrate and deploy from content libraries, hosts, clusters, datastores, networks, resource pools, content libraries and tags.
sidebar_order: 50
---

The vSphere plugin talks to vCenter Server through the vSphere Automation REST API (`/api`, vCenter 7.0 and later). Standalone ESXi hosts do not serve this API, so add the vCenter that manages them.

## What you can manage

- **Virtual machines**: power on, power off, suspend and reset; shut down or restart the guest through VMware Tools; upgrade VMware Tools; clone (to any host, resource pool, datastore or folder, optionally with a guest customization spec); migrate with vMotion; add a disk; mount an ISO from a content library; attach and detach tags; open the VMware Remote Console. **Edit** changes vCPUs, cores per socket, memory and CPU or memory hot add.
- **ESXi hosts**: connection and power state, cluster, VMs on the host; connect, disconnect, remove from inventory, and SSH to the host.
- **Clusters**: HA and DRS state, hosts and VMs.
- **Datastores**: type, capacity and usage, shared access, thin provisioning.
- **Networks**: standard and distributed port groups and NSX networks.
- **Resource pools**: create, edit CPU and memory reservations, limits, shares and expandable reservations, delete.
- **Content libraries** and their **items**: create a local library or subscribe to a published one, rename, delete; deploy VMs from VM template and OVF items.
- **Tag categories** and **tags**: create, rename, delete.
- **Datacenters**, **folders**, **guest customization specs**, and the **vCenter Server** appliance's version and health.

## Creating VMs

**Create Virtual Machine** builds a VM from a content library VM template, an OVF package, a clone of an existing VM, or from scratch (guest OS, vCPUs, memory, disk size, network and an optional installation ISO from a content library). Clusters, hosts, resource pools, datastores, folders, networks, templates and ISOs are all pickers.

<insert [vSphere Create Virtual Machine form with "Content library VM template" selected, showing the template, cluster, datastore and network pickers] here>

## Credentials

1. In the vSphere Client open **Administration → Single Sign On → Users and Groups** and create a user, for example `svc-infrawrench@vsphere.local`.
2. Open **Administration → Access Control → Global Permissions** and give that user a role on the vCenter root, with **Propagate to children** checked: **Read-only** to browse, or a role that includes virtual machine, resource, datastore, content library and vSphere tagging privileges to manage.
3. Enter the vCenter URL, the username and the password.

vCenter signs its certificate with the VMware Certificate Authority by default. Download the root CA from the vCenter landing page (**Download trusted root CA certificates**) and paste the PEM into **CA Certificate** under advanced options.

<insert [vSphere add-account form with vCenter URL, username, password and the expanded CA Certificate field] here>

## Consoles and Terraform

- **SSH** works for ESXi hosts (by host name) and for powered-on VMs whose IP address VMware Tools reports.
- **Open remote console** launches the VMware Remote Console application with a one-time ticket; it needs VMRC installed.
- **Export to Terraform** writes `vmware/vsphere` blocks for tag categories, tags, content libraries, datacenters and resource pools.

<insert [vSphere VM detail view showing the power and guest actions, the Guest section with IP address and VMware Tools state, and attached tags] here>

## Tips and limits

- Snapshots, alarms and performance charts are not available: the REST API has no snapshot or alarm endpoints, and its performance statistics service (vStats) is a Technology Preview that VMware advises against using in production.
- The REST API cannot rename VMs, put hosts into maintenance mode or create folders; use the vSphere Client for those.
- vCenter caps VM lists at 4,000 results per call.
- Reaching a private vCenter: the desktop app connects directly; the cloud app needs a bastion or an SSH tunnel on the account. Through an SSH tunnel the connection goes to `127.0.0.1`, so certificate verification fails unless vCenter's certificate covers that address.
