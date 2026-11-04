---
title: OpenStack
description: Manage any OpenStack cloud through Keystone, including Nova servers, Cinder volumes, Neutron networking, Octavia load balancers, Swift containers, Designate DNS and Heat stacks, with quotas, console logs and Terraform export.
sidebar_order: 50
---

One plugin covers every OpenStack cloud, public or private. You sign in through Keystone, and Infrawrench shows whichever services your cloud runs. Services your cloud doesn't offer (Octavia, Swift, Designate, Heat, Gnocchi) are simply left out.

## What you can manage

- **Servers** (Nova): start, stop, soft and hard reboot, pause, suspend, shelve and unshelve, lock, resize (then confirm or revert), snapshot to an image, associate and disassociate floating IPs, attach volumes, add and remove security groups, open the noVNC console, and read the console log. **Edit** renames the server and sets its description.
- **Flavors**, **images** (rename, visibility, protection, minimum disk and RAM, delete) and **key pairs** (import, delete).
- **Volumes** (Cinder): create empty, from an image or from a snapshot. Extend, snapshot, back up, detach and delete. Drag a volume onto a server to attach it. **Volume snapshots** and **volume backups** count toward backup coverage.
- **Networks**, **subnets**, **routers** (connect and disconnect subnets, set the external gateway), **floating IPs** (drag onto a server to associate) and **security groups** with their **rules** (add and delete).
- **Load balancers** (Octavia) with **listeners** and **pools**: create, edit, fail over, add and remove pool members.
- **Containers** (Swift): create them, toggle public read, and browse, upload and delete objects in the Storage tab.
- **DNS zones** and **record sets** (Designate), shown on the Domains page.
- **Stacks** (Heat): launch from a HOT template with parameters, suspend, resume, check, cancel an update, and see outputs, parameters, resources and events.

## Create a server

In **Create Server**, choose a flavor (with vCPU and RAM), an image, a network (or auto-allocation), a key pair or an SSH key to import, a security group and an availability zone. You can also add a boot volume, a floating IP from an external network, and cloud-init user data.

<insert [OpenStack Create Server form showing the flavor size picker, image picker, network and floating IP selects] here>

## Connect your cloud

You'll find the values in Horizon under **Project > API Access** (download the OpenStack RC file or clouds.yaml).

- **Application credential (recommended)**: in Horizon, go to **Identity > Application Credentials > Create**. Enter the Keystone URL, the credential ID and the secret. It's already tied to a project.
- **Username and password**: enter the Keystone URL, username, password and user domain (usually `Default`), then pick your project from the list.
- Pick a **Region** if your cloud has more than one. **Endpoint Interface** (advanced) switches between public and internal endpoints.

<insert [OpenStack add-account form with Keystone URL, application credential fields and the region picker] here>

## Quotas, metrics and logs

- **Quotas** shows Nova (instances, vCPUs, RAM, server groups), Cinder (volumes, storage, snapshots, backups) and Neutron (networks, subnets, ports, routers, floating IPs, security groups and rules) limits against usage. Unlimited quotas are skipped.
- **Metrics** for servers show CPU utilisation and memory use when your cloud runs Ceilometer and Gnocchi.
- **Logs** shows a server's console log and a stack's events.
- **Export to Terraform** writes `terraform-provider-openstack/openstack` blocks for servers, key pairs, volumes, networks, subnets, routers, floating IPs, security groups and rules, load balancers, containers, DNS zones and record sets, each with its import id.

<insert [OpenStack server detail view with power actions, Addresses section and the console log in the Logs tab] here>

## Tips and limits

- Every endpoint in your cloud's service catalog must be reachable from where Infrawrench runs. A bastion covers all of them. An SSH tunnel on the account only covers the Keystone URL, so it won't help if the other services are private too.
- There's no cost data. OpenStack has no standard billing API (CloudKitty is optional and rarely exposed to projects).
- You see what's in the project you signed in to. Shared and external networks from other projects are listed too, so you can use them as pools and attachment targets.
- Servers need compute API microversion 2.47, available since the Pike release.
