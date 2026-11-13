---
title: Hetzner Cloud
description: Manage Hetzner Cloud servers, volumes, networks, load balancers, certificates, DNS zones, Storage Boxes, images, and IP resources, with estimated spend priced from the published rate card.
sidebar_order: 5
---

Connect a Hetzner Cloud project to manage its servers, storage, networking and DNS, and see an estimate of what it costs.

## What you can manage

- Servers (create with image, size, location and SSH key; edit to rename or change the server type)
- Volumes (create; edit to rename or grow)
- Floating IPs
- Firewalls
- Networks (create with a first subnet in a network zone)
- Load balancers (create with a type and balancing algorithm)
- Primary IPs (create unassigned in a location; edit the name and auto-delete setting)
- SSH keys
- Images, including snapshots and backups
- Placement groups
- Certificates for load balancers: managed (Hetzner issues and renews them through Let's Encrypt) or uploaded
- DNS zones and record sets on Hetzner DNS
- Storage Boxes

You can rename floating IPs, primary IPs, firewalls, networks, load balancers, placement groups, SSH keys and certificates with the **Edit** button.

## Connect an account

1. In Hetzner Console, select a project.
2. Go to **Security > API tokens > Generate API token**.
3. Give it Read + write access and paste it into Infrawrench.

![Hetzner Add-account form with API token field](https://agent-assets.infrawrench.com/docs-screenshots/plugins/hetzner/add-account.png)

Each API token belongs to one project, so add one Infrawrench account per Hetzner project. The same token covers Hetzner Cloud, Hetzner DNS and Storage Boxes, so you don't need a second credential.

## What you can do

- **SSH terminal** on servers.
- **SSH keys at server creation**: pick a key from Infrawrench and it's uploaded to Hetzner if it isn't there already.
- **Load balancer and network inventory**, so you can see how your services connect without leaving the app.
- **Secret export to K8s** isn't available for Hetzner resources, since they don't hold secrets.
- **Server actions**: power on or off, graceful shutdown, reboot, hard reset, take a snapshot, turn daily backups on or off, and toggle delete and rebuild protection, all from the server's header.
- **Server metrics**: CPU (shown as 0 to 100% of the whole server), disk IOPS and throughput, and network bandwidth and packets. **Load balancer metrics**: open connections, new connections per second, requests per second and bandwidth.
- **Certificates**: you see a managed certificate's issuance and renewal status, can retry a failed issuance from the header, and expiry dates feed the expiry radar. Managed certificates only work for domains hosted on Hetzner DNS.
- **DNS**: zones show their record count, assigned nameservers and whether the registrar delegates to them. Records are grouped the way Hetzner does it: one record set per name and type, holding every value. Enter several values one per row (quote TXT values). Leave a record's TTL empty to use the zone default.
- **Storage Boxes**: capacity, usage, snapshot usage and the snapshot plan. Edit to rename, change the type, or turn SSH, Samba, WebDAV, the ZFS snapshot folder and external reachability on or off. Header actions take a snapshot, toggle delete protection and switch off the snapshot plan. A box with Samba on and reachable from outside Hetzner is flagged on the security posture page.

## Cost

Hetzner Cloud has no billing API, and your project API token can't reach your invoices. So Infrawrench estimates your spend instead: it lists everything in the project and prices it against Hetzner's published rate card.

Hetzner costs are labelled **estimated** throughout the app. Read them as "what this inventory costs at list price", not "what Hetzner charged".

There's nothing extra to set up. The project API token you already added is all it needs.

![Costs panel for a Hetzner account, with the estimated-costs notice visible above the chart and the service breakdown showing Server, Volume and Traffic](https://agent-assets.infrawrench.com/docs-screenshots/plugins/hetzner/cost-graph.png)

### What gets priced

| Service       | Basis                                                                                        |
| ------------- | -------------------------------------------------------------------------------------------- |
| Server        | Hourly rate, capped at the monthly price (Hetzner never bills a server past its monthly cap) |
| Server Backup | The rate card's backup percentage (currently 20%) of that server's own cost                  |
| Load Balancer | Hourly rate, capped at the monthly price                                                     |
| Primary IP    | Hourly rate, capped at the monthly price. IPv6 primary IPs are free and produce no rows      |
| Floating IP   | Monthly price, spread across the month                                                       |
| Volume        | Size × price per GB-month, spread across the month                                           |
| Snapshot      | Compressed size × price per GB-month, spread across the month                                |
| Traffic       | Outgoing traffic beyond the server or load balancer's included allowance, at the per-TB rate |

Networks, firewalls, placement groups, SSH keys, certificates and DNS zones are free and aren't priced. Storage Boxes are billed separately from Cloud resources and aren't included in the estimate.

A powered-off server is still billed in full, and Infrawrench shows it that way. Hetzner charges for a server as long as it exists, so stopping it doesn't lower this figure. Only deleting it does.

### Why it won't match your invoice

The estimate can differ from your invoice in these ways:

- **Deleted resources are missing.** The estimate is built from what exists right now. A server that ran for three weeks and was deleted on the 22nd no longer shows up, so those three weeks of cost are missing. This is why the estimate reads low, and it's the biggest difference for accounts that create and delete a lot.
- **History starts when you connect the account.** Months before you added it show a gap, not zero spend.
- **Traffic has no history.** Hetzner's traffic counters only cover the current billing period. The overage figure is the running total for the current month, recorded against the start of that month. If Infrawrench isn't collecting on the last day of a month, that month keeps the last figure it saw.
- **VAT is excluded.** Every amount is net, so you can apply your own tax treatment.
- **List prices only.** Negotiated prices, credits, refunds and one-off charges can't appear.

Amounts are shown in the currency of the project's rate card, usually EUR.

## Run CI jobs

A Hetzner Cloud connection can run [Infrawrench CI](../features/ci.md) cloud jobs once an organization admin opts it in. Each job gets a fresh server in the job's `cloud.region` (`fsn1` when it names none), started with the job's bootstrap as cloud-init user data, and deleted when the job ends:

| `cloud.kind` | Runs on                                  | Default `machine` | Default `image` |
| ------------ | ---------------------------------------- | ----------------- | --------------- |
| `vm`         | A cloud server with its own IPv4 address | `cpx22`           | `ubuntu-24.04`  |

The server holds no Hetzner credentials: no API token, and no SSH key of yours. Each job gets a throwaway SSH key (its private half is never kept, so no root password is made) that is removed as soon as the server exists, and an IPv4 Primary IP with auto delete, so the address goes with the server. Everything is labelled `infrawrench-ci`, so an address a failed start left behind is found and removed too.

As a backstop the server powers itself off when the job's time is up. Hetzner bills a server until it is deleted, whatever its state, and by the hour, rounded up: a job of a few minutes costs a full hour. The server has no way to delete itself, so billing stops only when Infrawrench deletes it at the end of the job, or when its cleanup later finds it by label.

Opting in needs a **Read & Write** token. A token can't tell what it may do, so the check reads the project and asks to delete an SSH key that doesn't exist: a read-only token is refused, which names the missing permission.

## Tips and limits

- Hetzner's API has a limit of 3600 requests per hour per project, so refreshing a large account may briefly slow down.
- The server type picker only offers types you can still order in at least one location. Since January 2026 the older CX22 to CX52 types and, in Europe and Singapore, CPX11 to CPX51 can't be ordered. Existing servers keep running and can still be resized.
- Volumes can only grow. Primary and floating IPs must be unassigned before Hetzner lets you delete them.
- Cost collection only uses a handful of requests per day from that same limit.
