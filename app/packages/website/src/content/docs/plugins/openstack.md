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

## Run CI jobs

A OpenStack connection can run [Infrawrench CI](../features/ci.md) cloud jobs once an organization admin opts it in. Each job gets a fresh Nova server in the job's `cloud.region` (the connection's region when it names none), started with the job's bootstrap as cloud-init user data, and deleted when the job ends:

| `cloud.kind` | Runs on                                                         | Default `machine`                          | Default `image`              |
| ------------ | --------------------------------------------------------------- | ------------------------------------------ | ---------------------------- |
| `vm`         | A Nova server, booted from a volume when the flavor has no disk | The smallest flavor with 2 vCPUs and 4 GiB | An active Ubuntu 24.04 image |

`cloud.machine` takes a flavor name or id, and `cloud.image` an image name or id. The server joins the project's one network, else the one shared network, else Nova's automatic network; a project with several networks a server could join can't run jobs yet, since a job can't name one. A boot volume is deleted with the server.

The server holds no OpenStack credentials: no key pair, no application credential.

As a backstop the server powers itself off when the job's time is up. Whether a stopped server is still billed depends on your cloud. The server has no way to delete itself, so billing stops only when Infrawrench deletes it at the end of the job, or when its cleanup later finds it.

Opting in reads the token's roles from Keystone. Nova's default policy needs the `member` role to create and delete servers, so a token with only `reader` is refused; a cloud with roles of its own is not judged by their names.

## Tips and limits

- Every endpoint in your cloud's service catalog must be reachable from where Infrawrench runs. A bastion lets through the Keystone URL's host and, if your catalog puts Nova, Neutron or other services on other hostnames, the hosts you pick under **Service Endpoint Hosts** in the account's **Advanced options**. The picker lists the catalog hosts for the account's region and interface. A bastion only reaches public addresses. An SSH tunnel on the account only covers the Keystone URL, so it won't help if the other services are private too.
- There's no cost data. OpenStack has no standard billing API (CloudKitty is optional and rarely exposed to projects).
- You see what's in the project you signed in to. Shared and external networks from other projects are listed too, so you can use them as pools and attachment targets.
- Servers need compute API microversion 2.47, available since the Pike release.
