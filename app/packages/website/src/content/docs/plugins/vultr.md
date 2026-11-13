---
title: Vultr
description: Manage Vultr instances, bare metal, block storage, Kubernetes, Managed Databases, load balancers, firewalls, VPCs, DNS and Object Storage, with billed spend from your invoices and month-to-date charges, account credit and live plan prices.
sidebar_order: 6
---

Connect Vultr with an API key. You can list, create, edit and act on everything below without leaving the app, and see your billed spend from invoices and this month's pending charges.

## What you can manage

- **Instances**: create with a region, a plan picker that only shows plans available (and priced) in that region, an OS, one-click app, marketplace app or one of your snapshots, an SSH key, a startup script, cloud-init user data, automatic backups, IPv6, DDoS protection, a firewall group and a VPC. Start, stop, reboot, reinstall, rebuild with another image, upgrade the plan, take a snapshot, restore from a backup or snapshot, set the automatic backup schedule, attach and detach VPCs and change the firewall group. SSH straight in from the instance page.
- **Bare metal servers**: start, stop, reboot, reinstall, rename and retag.
- **Block Storage**: create NVMe or HDD volumes (optionally attached to an instance), rename, grow, attach and detach. Drag a volume onto an instance in the same region to attach it.
- **Snapshots** and **automatic backups**: take snapshots, rename and delete them, and see each instance's backups.
- **Kubernetes (VKE)**: create clusters with a version picker, an optional HA control plane and managed firewall, and a first node pool. Add, resize and autoscale node pools, recycle or remove individual nodes, upgrade the Kubernetes version, and download the kubeconfig. The cluster page opens the Kubernetes tab directly.
- **Managed Databases** (PostgreSQL, MySQL, Valkey and Kafka): create with an engine version, a plan for that engine, trusted IPs, a VPC and a maintenance window. Edit the label, plan, trusted IPs and maintenance window. Upgrade the engine version, restore or fork from a backup (latest or point in time), add a read replica, and start maintenance. Users and logical databases are listed under each database, where you can create, edit (reset a user's password) and delete them. The database page opens a PostgreSQL, MySQL, Valkey or Kafka tab with the connection filled in.
- **Load balancers**: create with a forwarding rule, health check and backend instances picked from a list. Add and remove forwarding rules and firewall rules. Change backends, the health check, the algorithm, the node count, HTTPS redirect and proxy protocol. Upload or remove an SSL certificate.
- **Firewall groups**: create with SSH, web and ping presets, then add and remove rules (from anywhere, a specific range, or Cloudflare's ranges). Drag a firewall group onto an instance to protect it.
- **VPCs**: create with an optional IPv4 range, rename, and see what's attached. Drag a VPC onto an instance to attach it.
- **Reserved IPs**: reserve an IPv4 address or IPv6 subnet, attach and detach it, or drag it onto an instance.
- **DNS**: domains (DNSSEC and SOA are editable) and their records. A, AAAA and CNAME records can follow another resource's address.
- **Object Storage**: create a subscription by picking a location and tier, regenerate its S3 keys, and create and delete buckets. Bucket pages have a file browser (upload, create folders, delete) that uses the subscription's own keys, so you don't paste any.
- **SSH keys**, **startup scripts** (create, rename, edit the script), the **billing account** (balance, month-to-date charges with every line item, bandwidth pool and projected overage) and **invoices** with their line items.

<insert [Vultr account page showing the resource sections: Instances, Block Storage, Kubernetes Clusters, Managed Databases, Load Balancers, Object Storage] here>

## Connect your account

In the Vultr customer portal, open **Account**, then **API** (under Other), and enable the API to get your key.

- The key has its user's permissions. The account owner's key can do everything. A sub-user's key is limited to that user's permissions, and costs need **Billing**.
- Under **Access Control**, Vultr only accepts the key from the addresses you list. New keys allow any IPv4 and IPv6 address. If you narrow the list, add the address Infrawrench connects from (or your bastion's).

Click **Check credentials** after adding the account to see which areas the key can reach.

<insert [Add account dialog for Vultr with the API Key field and the credential check results] here>

## Costs and credit

- Past months come from your invoices, with each line item spread evenly over the days it covers, by product.
- The current month comes from Vultr's pending charges, spread from the first of the month to today. It updates daily until the invoice replaces it.
- Negative line items (promotional credit, refunds) show as credits.
- A negative account balance shows as credit, after this month's pending charges, so the credit burndown shows how long it lasts.
- The create forms show plan prices for the region you pick, including regions Vultr charges more for. The estimate includes automatic backups (20% of the plan).

## Metrics

Vultr doesn't provide CPU or memory graphs for instances, so the Metrics tab shows daily inbound and outbound transfer (outbound is what draws on your bandwidth pool). Managed Databases show their current CPU, memory and disk use.

## Savings and security findings

- Stopped instances are flagged, since Vultr bills them in full until they're destroyed.
- Detached volumes, unattached reserved IPs, load balancers with no backends and firewall groups protecting nothing are flagged as potential savings.
- Instances with no firewall group, firewall groups that open ports other than 80 and 443 to the internet, databases with no trusted IPs, and instances without automatic backups are flagged on the posture page.

## Status

Incidents from [status.vultr.com](https://status.vultr.com) show against your resources by region.

## Terraform

Instances, block storage, Kubernetes clusters, databases, load balancers, firewall groups, VPCs, reserved IPs, DNS domains and records, Object Storage, SSH keys and startup scripts export to the official `vultr/vultr` provider, each with its import id.

## Run CI jobs

A Vultr connection can run [Infrawrench CI](../features/ci.md) cloud jobs once an organization admin opts it in. Each job gets a fresh Cloud Compute instance in the job's `cloud.region` (`ewr` when it names none), started with the job's bootstrap as cloud-init user data, and deleted when the job ends:

| `cloud.kind` | Runs on                  | Default `machine` | Default `image`             |
| ------------ | ------------------------ | ----------------- | --------------------------- |
| `vm`         | A Cloud Compute instance | `vc2-2c-4gb`      | Ubuntu 24.04 (`os_id` 2284) |

`cloud.image` takes an OS id from Vultr's OS list or a Marketplace image id. The instance holds no Vultr credentials: no API key and no SSH key.

As a backstop the instance powers itself off when the job's time is up. Vultr bills a stopped instance, by the hour, at least an hour per instance. The instance has no way to destroy itself, so billing stops only when Infrawrench destroys it at the end of the job, or when its cleanup later finds it by tag.

Opting in reads the API user's permissions from the account: a user who isn't an administrator needs `provisioning` and `subscriptions`.

## Limits

- Container Registry, CDN, Serverless Inference, ISOs and organization and IAM settings aren't covered yet.
- Manage load balancer forwarding rules on the load balancer page. The Terraform export lists them as a note, not as blocks.
- Vultr doesn't publish a list of database engine versions, so the version picker offers the versions Vultr currently documents. Upgrades offer exactly what Vultr says is available for that cluster.
