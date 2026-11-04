---
title: Linode (Akamai Cloud)
description: Manage Akamai Cloud Computing (formerly Linode) compute, storage, Kubernetes, databases and networking, with billed spend from your invoices, the open month by resource, promotional credit burndown and live prices on every create form.
sidebar_order: 6
---

Connect Akamai Cloud Computing (formerly Linode) with a personal access token to create, edit and run every resource below without leaving the app, and see your billed spend from your invoices.

## What you can manage

- **Linodes**: create from an image with a plan picker priced for the region you chose, an SSH key, the Backups add-on, a private IPv4 address and a Cloud Firewall. Edit to rename, retag, turn the shutdown watchdog on or off, or change the plan.
- **Block Storage volumes**: create (optionally attached to a Linode), grow, attach and detach. Drag a volume onto a Linode in the same region to attach it.
- **NodeBalancers**: create, add and remove ports (HTTP, HTTPS with your certificate, TCP, UDP, with an algorithm and health check), and add backend Linodes by picking them. Their private address is filled in for you.
- **Kubernetes (LKE)**: create clusters with a Kubernetes version picker, a node plan and an optional high-availability control plane. Add, resize and autoscale node pools, upgrade the version, recycle nodes, and download or regenerate the kubeconfig. The cluster page opens the Kubernetes tab directly, with per-workload cost.
- **Object Storage buckets**: create with an access level, change the ACL and CORS, and browse, upload, create folders in and delete objects from the bucket page. You don't need separate S3 keys.
- **Managed Databases** (MySQL and PostgreSQL): create with an engine version, a node plan and one or three nodes. Edit the label, allowed IPs and plan, and suspend, resume, apply updates and reset the root password. The database page opens a PostgreSQL or MySQL tab with the connection filled in.
- **Cloud Firewalls**: create with SSH, web and ping toggles, then add and remove inbound and outbound rules, change the default policies, and remove protected devices. Drag a firewall onto a Linode or NodeBalancer to protect it.
- **DNS Manager**: domains and their records. Records pointing at a Linode, NodeBalancer or reserved IP can follow that resource, so the record keeps up with its address.
- **VPCs** with their subnets (add and remove subnets from the VPC page).
- **Reserved IPs**: reserve an address in a region, and drag it onto a Linode to assign it.
- **Images** you've captured, **StackScripts** you own (create, edit the script, compatible images and revision note), the **billing account** (balance, uninvoiced charges, promotions and the network transfer pool by region) and your **invoices** with every line item.

<insert [Linode account page showing the resource sections: Linodes, Volumes, NodeBalancers, Kubernetes Clusters, Buckets, Managed Databases] here>

## Connect your account

In Cloud Manager, open your profile > **API Tokens** > **Create a Personal Access Token**. Give each area the access you want Infrawrench to have:

| Area           | For                                                       |
| -------------- | --------------------------------------------------------- |
| Account        | Costs, invoices, promotions (Read Only is enough)         |
| Linodes        | Linodes, their statistics, backups and resizes            |
| Volumes        | Block Storage                                             |
| NodeBalancers  | NodeBalancers                                             |
| Kubernetes     | LKE clusters and node pools (kubeconfigs need Read/Write) |
| Object Storage | Buckets and the object browser                            |
| Databases      | Managed Databases                                         |
| Firewalls      | Cloud Firewalls                                           |
| Domains        | DNS Manager                                               |
| VPCs           | VPCs                                                      |
| IPs            | Reserved IPs                                              |
| Images         | Images                                                    |
| StackScripts   | StackScripts                                              |
| Monitor        | Managed Database metrics (Read Only)                      |

For a read-only account, choose **Read Only** everywhere. Linode then refuses edits and actions. After adding the account, **Check credentials** tests every area and lists the scopes that are missing, and the template generator gives you the exact scope list for the features you pick ([credential preflight](../core-concepts/credential-preflight.md)).

<insert [Linode add-account form with the Personal Access Token field and the Check credentials panel showing one missing scope] here>

## Cost

Linode bills hourly up to a monthly cap per service, and invoices each month on or just after the 1st. Infrawrench shows cost two ways:

- **Past months** come from your invoices. Each line item is spread over the days it covers (a Linode created on the 20th shows up from the 20th), by service, resource and region. Tax is shown as its own charge type and promotional credits as credits, so your usage figures aren't inflated or hidden.
- **The current month** uses the running total Linode shows as **Uninvoiced charges**. Infrawrench breaks it down by pricing everything in your account for the hours it has existed this month at Linode's published rates. Anything left over (resources you deleted this month, transfer overage, images) appears as **Other uninvoiced charges**, so the month always adds up to Linode's figure. When the invoice arrives, it replaces those days.

You can break costs down by service (Linodes, Backups, Block Storage, NodeBalancers, Kubernetes (LKE), Managed Databases, Object Storage, Reserved IPs, Network Transfer, ...), region and resource. Up to a year of invoices is loaded when you add the account. All amounts are in US dollars.

<insert [Costs panel filtered to a Linode account, grouped by service, showing last month from the invoice and the current month with an Other uninvoiced charges slice] here>

### Credits

Active promotions (with their expiry dates) and any account credit appear in [credit burndown](../features/credit-burndown.md) with a burn rate and runway. If a promotion expires before it would run out, its runway is the expiry date.

### Live prices

Every create form shows the monthly price as you fill it in, at the rate for the region you pick: plans and the Backups add-on, volumes per GB, NodeBalancers, LKE node pools plus the high-availability control plane, Managed Databases per node count, reserved IPs and the Object Storage subscription. The same figure appears on each resource's page and in the edit dialog ("This change adds $12/month").

## Savings

- **Potential savings** flags powered-off Linodes (Linode bills them in full until they're deleted; LKE worker nodes are excluded), volumes not attached to anything, NodeBalancers with no backends and reserved IPs not assigned to anything.
- **Right-sizing** suggests a smaller plan in the same class for Linodes whose CPU stays low, with the monthly saving at the Linode's regional price, and applies it as a resize. Linode powers the instance off for the resize, and moving to a smaller plan only works when the data fits on the smaller disk.
- **Carbon**: Linodes, LKE clusters and Managed Databases get an estimate from the region's grid (Jakarta has no figure, so it isn't estimated). See [carbon estimate](../features/carbon.md).

## Metrics

- **Linodes**: CPU (as a percentage of the whole Linode), disk and swap I/O, and public, private and IPv6 network traffic.
- **NodeBalancers**: connections per second and traffic in and out.
- **Managed Databases**: CPU, memory and disk usage, and read and write IOPS from Akamai Cloud Pulse. Cloud Pulse is in limited availability, so if your account doesn't have it, the charts stay empty.

## What you can do

- **SSH** into any running Linode, including through a jumpbox on its private address.
- **Linode actions** in the header: boot, shut down, reboot, resize with a plan picker, rebuild from an image, enable or cancel backups, take a snapshot and restore a backup.
- **Security posture** flags Linodes without a Cloud Firewall, Linodes without backups, publicly readable or writable buckets, unencrypted volumes, firewalls that accept all inbound traffic by default and databases open to 0.0.0.0/0.
- **Provider status**: incidents on status.linode.com are matched to your resources by product and region.
- **Domains**: Linode DNS Manager zones and records appear in the cross-provider [Domains](../features/domains.md) view, and records pointing at a bucket or NodeBalancer hostname nobody owns are flagged as dangling.
- **Export to Terraform** (`linode/linode` provider): Linodes, volumes, NodeBalancers, LKE clusters, buckets, firewalls, domains and records, VPCs, StackScripts, Managed Databases and reserved IPs, each with its import ID.

## Tips and limits

- The current month's breakdown is priced from what exists now, at list rates. Only the total comes from Linode. Charges with no resource behind them (transfer overage, deleted resources) are grouped into one line until the invoice arrives.
- You can't change the plan of a Linode that's an LKE worker node. Change the node pool instead.
- Firewall rules are edited one at a time. Terraform export includes a firewall's policies but not its rules.
