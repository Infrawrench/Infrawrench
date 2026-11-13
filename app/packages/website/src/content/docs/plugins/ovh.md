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

Regions include the 3-AZ regions (EU-WEST-PAR, EU-SOUTH-MIL) and Local Zones. The pickers list whichever regions are activated on your project.

## Connect your account

Create API credentials on the [OVH API token page](https://www.ovh.com/auth/api/createToken) with the scopes you need, then paste:

- **Application Key** and **Application Secret**: identify your app to the OVH API.
- **Consumer Key**: the per-user grant you get when the token is validated.
- **API Endpoint**: your region, `eu` (Europe), `ca` (Canada) or `us` (United States).
- **Public Cloud Project ID**: the project to manage.

![OVH Add-account form with application key / secret / consumer key / endpoint / project fields](https://agent-assets.infrawrench.com/docs-screenshots/plugins/ovh/add-account.png)

## Things you can do

- **SSH terminal** on Public Cloud instances.
- **Attach block volumes** to instances in the same region.
- **Instance actions**: start, stop, soft and hard reboot, shelve and unshelve, and take a snapshot. Start and stop also drive sleep schedules. OVHcloud keeps billing a stopped instance at its full rate; shelving is what stops the compute charge.
- **Volume snapshots** from a volume's header. Snapshots are listed with their source volume and count toward backup coverage. Unattached volumes are flagged as orphans.
- **Kubernetes**: update to the latest patch release, upgrade to the next minor version when OVH offers one, and reset the admin kubeconfig. Each cluster shows whether it's up to date and how full its etcd quota is.
- **Create a managed database**: the form lists the engines, versions, plans, flavors and regions OVH currently offers. Backup retention is shown and counts toward backup coverage. Valkey services open the Redis tab.
- **Managed database Logs tab**: the cluster's most recent log messages (up to 1,000, tagged by node on multi-node clusters). OVHcloud has deprecated this in favour of Logs Data Platform subscriptions and plans to remove it on 1 January 2027.
- **Public Cloud Load Balancers** show lifetime counters (active and total connections, bytes in and out, request errors) on their dashboard.
- **Database client tabs**: PostgreSQL, MySQL, MongoDB, Redis, Kafka and [OpenSearch](./opensearch.md) clusters open the matching client tab with the endpoint filled in. OVH never returns user passwords after creation, so the tab works for users whose password Infrawrench saw when it created them. For older users, reset the password and paste it in.

## Run CI jobs

A OVHcloud connection can run [Infrawrench CI](../features/ci.md) cloud jobs once an organization admin opts it in. Each job gets a fresh Public Cloud instance in the job's `cloud.region` (`GRA11` when it names none), started with the job's bootstrap as user data, and deleted when the job ends:

| `cloud.kind` | Runs on                                       | Default `machine` | Default `image` |
| ------------ | --------------------------------------------- | ----------------- | --------------- |
| `vm`         | A Public Cloud instance on the public network | `b3-8`            | Ubuntu 24.04    |

The instance holds no OVHcloud credentials: your API keys never leave Infrawrench, and the instance gets no SSH key. Instances take no tags through the OVH API, so a job's instance is named `iwci-` followed by its tags.

As a backstop the instance powers itself off when the job's time is up. OVHcloud bills a stopped instance like a running one, by the second after the first minute. The instance has no way to delete itself, so billing stops only when Infrawrench deletes it at the end of the job, or when its cleanup later finds it by name.

Opting in reads the consumer key's access rules and names each call they don't allow: `POST`, `GET` and `DELETE` on `/cloud/project/{id}/instance`, and `GET` on its `flavor` and `image`. OVHcloud IAM policies can still refuse a call the rules allow.

## Tips & limits

- OVH's API is split by region (eu, us, ca). Make sure your token covers every region you plan to use.
- Consumer keys can expire. Check the expiry when you create one.
- Instances have no metrics tab, since OVHcloud removed per-instance monitoring. Managed databases keep theirs, with whatever metrics OVHcloud lists for the engine.
- Creating Public Cloud Load Balancers needs a private network, subnet and listeners, so do it in the OVHcloud Control Panel. You can rename, resize and delete existing ones here.

## Cost graphs

OVHcloud accounts feed [cost graphs & budgets](../features/cloud-costs.md) from your bills plus current unbilled usage: pre-tax amounts on bill dates, broken down by service.

- Your consumer key needs access rules for `GET /me/bill*` and `GET /me/consumption*`. Without the consumption rule, you still get invoiced history but not the current-period preview.
