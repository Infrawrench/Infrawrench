---
title: VMware vSphere
description: Manage vCenter Server inventory, including VMs with power actions, clone, migrate and deploy from content libraries, hosts, clusters, datastores, networks, resource pools, content libraries and tags.
sidebar_order: 50
---

Connect to vCenter Server 7.0 or later. Standalone ESXi hosts can't be added directly, so add the vCenter that manages them.

## What you can manage

- **Virtual machines**: power on, power off, suspend and reset. Shut down or restart the guest through VMware Tools, and upgrade VMware Tools. Clone (to any host, resource pool, datastore or folder, optionally with a guest customization spec), migrate with vMotion, add a disk, mount an ISO from a content library, attach and detach tags, and open the VMware Remote Console. **Edit** changes vCPUs, cores per socket, memory and CPU or memory hot add.
- **ESXi hosts**: connection and power state, cluster and VMs on the host. Connect, disconnect, remove from inventory, and SSH to the host.
- **Clusters**: HA and DRS state, hosts and VMs.
- **Datastores**: type, capacity and usage, shared access, thin provisioning.
- **Networks**: standard and distributed port groups and NSX networks.
- **Resource pools**: create, edit CPU and memory reservations, limits, shares and expandable reservations, delete.
- **Content libraries** and their **items**: create a local library or subscribe to a published one, rename, delete. Deploy VMs from VM template and OVF items.
- **Tag categories** and **tags**: create, rename, delete.
- **Datacenters**, **folders**, **guest customization specs**, and the **vCenter Server** appliance's version and health.

## Create a VM

**Create Virtual Machine** builds a VM from:

- a content library VM template,
- an OVF package,
- a clone of an existing VM, or
- scratch (guest OS, vCPUs, memory, disk size, network and an optional installation ISO from a content library).

Clusters, hosts, resource pools, datastores, folders, networks, templates and ISOs are all picked from lists.

<insert [vSphere Create Virtual Machine form with "Content library VM template" selected, showing the template, cluster, datastore and network pickers] here>

## Connect vCenter

1. In the vSphere Client, open **Administration > Single Sign On > Users and Groups** and create a user, for example `svc-infrawrench@vsphere.local`.
2. Open **Administration > Access Control > Global Permissions** and give that user a role on the vCenter root, with **Propagate to children** checked. Use **Read-only** to browse, or a role that includes virtual machine, resource, datastore, content library and vSphere tagging privileges to manage.
3. Enter the vCenter URL, the username and the password.

By default vCenter signs its certificate with the VMware Certificate Authority. Download the root CA from the vCenter landing page (**Download trusted root CA certificates**) and paste the PEM into **CA Certificate** under advanced options.

<insert [vSphere add-account form with vCenter URL, username, password and the expanded CA Certificate field] here>

## Consoles and Terraform

- **SSH** works for ESXi hosts (by host name) and for powered-on VMs whose IP address VMware Tools reports.
- **Open remote console** launches the VMware Remote Console app with a one-time ticket. You need VMRC installed.
- **Export to Terraform** writes `vmware/vsphere` blocks for tag categories, tags, content libraries, datacenters and resource pools.

<insert [vSphere VM detail view showing the power and guest actions, the Guest section with IP address and VMware Tools state, and attached tags] here>

## CI jobs

vCenter can run [cloud jobs](../features/ci.md#cloud-jobs) of kind `vm`: each job clones a VM from a template, powered off, hands it the job as cloud-init user data, powers it on, and deletes it when the job ends.

```yaml
jobs:
  test:
    cloud: { provider: vsphere, kind: vm, image: ubuntu-ci-template, region: Cluster-A }
    run: make test
```

- `image` is the template's name or id (`vm-42`). It needs open-vm-tools 11.3 or later, cloud-init 21.1 or later with `disable_vmware_customization: false`, `bash` and `curl`, and vCenter 7.0 U3 or later.
- `region` is the cluster, resource pool or host to place the clone in; with one cluster it can be left out. The template decides the size: the clone API can't change CPUs or memory, so `machine` isn't accepted.
- The VM is named `iwci-<job>` and tagged in the `infrawrench-ci` tag category, powers itself off once the job's time is up, and is deleted by Infrawrench afterwards.
- vCenter can't say ahead of time whether a user holds a privilege, so **Check permissions** only checks it can reach vCenter. The role needs `VirtualMachine.Provisioning.Clone`, `VirtualMachine.Provisioning.DeployTemplate`, `VirtualMachine.Provisioning.Customize`, `VirtualMachine.Inventory.CreateFromExisting`, `VirtualMachine.Inventory.Delete`, `VirtualMachine.Interact.PowerOn`, `VirtualMachine.Interact.PowerOff`, `Resource.AssignVMToPool`, `Datastore.AllocateSpace` and the tagging privileges `InventoryService.Tagging.CreateCategory`, `CreateTag`, `AttachTag` and `ObjectAttachable`. A job that is denied one names them.

## Tips and limits

- Snapshots, alarms and performance charts aren't available. vCenter doesn't offer snapshots or alarms this way, and VMware advises against using its performance statistics preview in production.
- You can't rename VMs, put hosts into maintenance mode or create folders here. Use the vSphere Client for those.
- vCenter lists at most 4,000 VMs.
- To reach a private vCenter, the desktop app connects directly. The cloud app needs an SSH tunnel on the account. A bastion only reaches public addresses. Through an SSH tunnel the connection goes to `127.0.0.1`, so certificate checks fail unless vCenter's certificate also covers that address.
