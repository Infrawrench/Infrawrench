---
title: Linode (Akamai Cloud)
description: Manage Akamai Cloud Computing (formerly Linode) compute, storage, Kubernetes, databases and networking, with billed spend from your invoices, the open month by resource, promotional credit burndown and live prices on every create form.
sidebar_order: 6
---

Akamai Cloud Computing is the platform formerly known as Linode. Infrawrench talks to the Linode API v4 with a personal access token: billed spend comes from your invoices, and every resource below can be listed, created, edited and acted on without leaving the app.

## What you can manage

- **Linodes**: create from an image with a plan picker priced for the chosen region, an SSH key, the Backups add-on, a private IPv4 address and a Cloud Firewall. Edit to rename, retag, toggle the shutdown watchdog or change the plan.
- **Block Storage volumes**: create (optionally attached to a Linode), grow, attach and detach. Drag a volume onto a Linode in the same region to attach it.
- **NodeBalancers**: create, add and remove ports (HTTP, HTTPS with your certificate, TCP, UDP, with an algorithm and health check), and add backend Linodes by picking them; their private address is filled in for you.
- **Kubernetes (LKE)**: create clusters with a Kubernetes version picker, a node plan and an optional high-availability control plane; add, resize and autoscale node pools; upgrade the version; recycle nodes; download or regenerate the kubeconfig. The cluster page opens the Kubernetes tab directly, with per-workload cost.
- **Object Storage buckets**: create with an access level, change the ACL and CORS, and browse, upload, create folders in and delete objects from the bucket page. No separate S3 keys are needed.
- **Managed Databases** (MySQL and PostgreSQL): create with an engine version, a node plan and one or three nodes; edit the label, allowed IPs and plan; suspend, resume, apply updates and reset the root password. The database page opens a PostgreSQL or MySQL tab with the connection filled in.
- **Cloud Firewalls**: create with SSH, web and ping toggles, then add and remove inbound and outbound rules, change the default policies, and remove protected devices. Drag a firewall onto a Linode or NodeBalancer to protect it.
- **DNS Manager**: domains and their records. Records pointing at a Linode, NodeBalancer or reserved IP can track that resource, so the record follows its address.
- **VPCs** with their subnets (add and remove subnets from the VPC page).
- **Reserved IPs**: reserve an address in a region, and drag it onto a Linode to assign it.
- **Images** you have captured, **StackScripts** you own (create, edit the script, compatible images and revision note), the **billing account** (balance, uninvoiced charges, promotions and the network transfer pool by region) and your **invoices** with every line item.

<insert [Linode account page showing the resource sections: Linodes, Volumes, NodeBalancers, Kubernetes Clusters, Buckets, Managed Databases] here>

## Credentials

In Cloud Manager, open your profile, then **API Tokens**, and **Create a Personal Access Token**. Give each area the access you want Infrawrench to have:

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

Choose **Read Only** everywhere for a read-only account; edits and actions are then refused by Linode. After adding the account, **Check credentials** probes every area and lists the scopes that are missing, and the template generator produces the exact scope list for the capabilities you pick ([credential preflight](../core-concepts/credential-preflight.md)).

<insert [Linode add-account form with the Personal Access Token field and the Check credentials panel showing one missing scope] here>

## Cost

Linode bills hourly up to a monthly cap per service, and invoices each month on or just after the 1st. Infrawrench reads cost two ways:

- **Closed months** come from your invoices. Each line item is spread over the days it covers (a Linode created on the 20th shows up from the 20th) and attributed by service, resource and region from the item itself. Tax is recorded as its own charge type, and promotional credits as credits, so the usage figures are not inflated or masked.
- **The current month** has no line items in Linode's API, only the running total Linode shows as **Uninvoiced charges**. Infrawrench uses that total, and breaks it down by pricing everything in your account for the hours it has existed this month at Linode's own published rates. Whatever the total holds beyond that (resources you deleted this month, transfer overage, images) appears as **Other uninvoiced charges**, so the month always adds up to Linode's figure. When the invoice arrives, those days are replaced by the invoice.

Breakdowns: service (Linodes, Backups, Block Storage, NodeBalancers, Kubernetes (LKE), Managed Databases, Object Storage, Reserved IPs, Network Transfer, ...), region and resource. Up to a year of invoices is backfilled when you add the account. All amounts are in US dollars.

<insert [Costs panel filtered to a Linode account, grouped by service, showing last month from the invoice and the current month with an Other uninvoiced charges slice] here>

### Credits

Active promotions (with their expiry dates) and any account credit appear in [credit burndown](../features/credit-burndown.md) with a burn rate and runway. A promotion that expires before it would run out shows the expiry as its runway.

### Live prices

Every create form shows the monthly price as you fill it in, at the regional rate for the region you pick: plans and the Backups add-on, volumes per GB, NodeBalancers, LKE node pools plus the high-availability control plane, Managed Databases per node count, reserved IPs and the Object Storage subscription. The same figure appears on each resource's page and in the edit dialog ("This change adds $12/month").

## Savings

- **Potential savings** flags powered-off Linodes (Linode bills them in full until they are deleted; LKE worker nodes are excluded), volumes not attached to anything, NodeBalancers with no backends and reserved IPs not assigned to anything.
- **Right-sizing** recommends a smaller plan in the same class for Linodes whose CPU stays low, with the monthly saving at the Linode's regional price, and applies it as a resize. Linode powers the instance off for the resize; moving to a smaller plan only works when the data fits on the smaller disk.
- **Carbon**: Linodes, LKE clusters and Managed Databases get an estimate from the region's grid (Jakarta has no figure and is left unestimated). See [carbon estimate](../features/carbon.md).

## Metrics

- **Linodes**: CPU (as a percentage of the whole Linode; Linode reports it per core), disk and swap I/O, and public, private and IPv6 network traffic. The last 24 hours come from the live statistics; older windows read Linode's monthly statistics.
- **NodeBalancers**: connections per second and traffic in and out.
- **Managed Databases**: CPU, memory and disk usage, and read and write IOPS from Akamai Cloud Pulse. Cloud Pulse is in limited availability; when your account does not have it the charts stay empty.

## Notable flows

- **SSH** into any running Linode, including through a jumpbox on its private address.
- **Linode actions** in the header: boot, shut down, reboot, resize with a plan picker, rebuild from an image, enable or cancel backups, take a snapshot and restore a backup.
- **Security posture** flags Linodes without a Cloud Firewall, Linodes without backups, publicly readable or writable buckets, unencrypted volumes, firewalls that accept all inbound traffic by default and databases open to 0.0.0.0/0.
- **Provider status**: incidents on status.linode.com are matched to your resources by product and region.
- **Domains**: Linode DNS Manager zones and records appear in the cross-provider [Domains](../features/domains.md) view, and records pointing at a bucket or NodeBalancer hostname nobody owns are flagged as dangling.
- **Export to Terraform** (`linode/linode` provider): Linodes, volumes, NodeBalancers, LKE clusters, buckets, firewalls, domains and records, VPCs, StackScripts, Managed Databases and reserved IPs, each with its import ID.

## Limitations

- The current month's breakdown is priced from what exists now, at list rates; only the total is Linode's. Charges that have no resource behind them (transfer overage, deleted resources) are grouped into one line until the invoice arrives.
- A Linode's plan cannot be changed from Infrawrench when it is an LKE worker node; change the node pool instead.
- Firewall rules are edited one at a time; Terraform export includes a firewall's policies but not its rules.
