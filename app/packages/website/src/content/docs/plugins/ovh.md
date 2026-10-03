---
title: OVHcloud
description: Manage OVHcloud Public Cloud instances, Kubernetes, databases, volumes, snapshots, load balancers, networking and the Managed Private Registry.
sidebar_order: 7
---

## What you can manage

- Public Cloud instances (edit to rename or resize to another flavor)
- Managed Kubernetes (edit the name, update policy and node count)
- Block Storage volumes (edit the name and description, or grow the volume)
- Volume snapshots
- Object Storage
- Public Cloud Load Balancers (OpenStack Octavia; edit to rename or change the size)
- Load Balancers from the older, configuration-versioned API
- Private Networks
- Floating IPs
- Gateways
- Managed Private Registry (Harbor)
- Public Cloud Databases (PostgreSQL, MySQL, MongoDB, Valkey, Kafka, Kafka Connect, Kafka MirrorMaker, OpenSearch, ClickHouse, Grafana; edit the description, version, plan, flavor and deletion protection)

Regions include the 3-AZ regions (EU-WEST-PAR, EU-SOUTH-MIL) and Local Zones; the pickers list whichever regions are activated on the project.

## Credentials

Generate API credentials at the [OVH API token page](https://www.ovh.com/auth/api/createToken) with the scopes you need, then paste:

- **Application Key** and **Application Secret** — identify your app to the OVH API.
- **Consumer Key** — the per-user grant returned when the token is validated.
- **API Endpoint** — region: `eu` (Europe), `ca` (Canada), or `us` (United States).
- **Public Cloud Project ID** — the project to manage.

![OVH Add-account form with application key / secret / consumer key / endpoint / project fields](https://agent-assets.infrawrench.com/docs-screenshots/plugins/ovh/add-account.png)

## Notable flows

- **SSH terminal** on public cloud instances.
- **Block volume attachment** to instances in the same region.
- **Instance actions**: start, stop, soft and hard reboot, shelve and unshelve, and take a snapshot. Start and stop also drive sleep schedules. OVHcloud keeps billing a stopped instance at its full rate; shelving is what stops the compute charge.
- **Volume snapshots** from a volume's header; snapshots are listed with their source volume and count towards backup coverage. Unattached volumes are flagged as orphans.
- **Kubernetes**: update to the latest patch release, upgrade to the next minor version when OVH offers one, and reset the admin kubeconfig. Each cluster shows whether it is up to date and how full its etcd quota is.
- **Managed database create form** lists the engines, versions, plans, flavors and regions OVH currently offers. Backup retention is shown and counts towards backup coverage. Valkey services open the Redis tab.
- **Public Cloud Load Balancers** show lifetime counters (active and total connections, bytes in and out, request errors) on their dashboard.
- **Peer-plugin tabs** on managed databases — PostgreSQL, MySQL, MongoDB, Redis, Kafka, and [OpenSearch](./opensearch.md) clusters open the matching client plugin's tab with the endpoint pre-filled. OVH never returns user passwords after creation, so the peer tab works for users whose password Infrawrench captured at create time; pre-existing users need a rotated password pasted in.

## Tips & limits

- OVH’s API is organized by region (eu, us, ca). Make sure the token has scope for every region you plan to use.
- Consumer keys can be time-limited — pay attention to expiry when creating.
- OVHcloud removed the per-instance monitoring endpoint, so instances have no metrics tab. Managed databases keep theirs.
- Creating Public Cloud Load Balancers needs a private network, subnet and listeners, so it stays in the OVHcloud Control Panel; existing ones can be renamed, resized and deleted here.

## Cost graphs

OVHcloud accounts feed [cost graphs & budgets](../features/cloud-costs.md) from bills (`/me/bill`) plus current unbilled consumption — pre-tax amounts on bill dates, broken down by service.

- The consumer key needs access rules for `GET /me/bill*` and `GET /me/consumption*`. Without the consumption rule, invoiced history still collects and only the current-period preview is missing.
