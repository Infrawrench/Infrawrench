---
title: Oracle Cloud
description: Manage Oracle Cloud Infrastructure (OCI) compute, storage, networking, Autonomous Databases, OKE and budgets, with billed spend by service, SKU, region, resource and compartment.
sidebar_order: 8
---

Connect an Oracle Cloud Infrastructure tenancy with an API signing key. You'll see resources in every region your tenancy subscribes to and every compartment the key's user can see, plus your billed spend.

## Connect your tenancy

You need four values from the OCI Console, plus the region your tenancy was created in:

1. **Tenancy OCID**: open the Profile menu, then **Tenancy**, and copy the OCID (`ocid1.tenancy.oc1..…`).
2. **User OCID**: Profile menu, then **My profile**, and copy your OCID (`ocid1.user.oc1..…`). Use a dedicated user if you want to limit what Infrawrench can do.
3. **API key fingerprint** and **private key**: on **My profile**, open **API keys** and choose **Add API key**. Let the Console generate the key pair, download the private key, then copy the fingerprint the Console shows. Paste the whole private key file, including the `BEGIN` and `END` lines. Keys with a passphrase aren't supported. Export an unencrypted copy with `openssl rsa -in key.pem -out key-unencrypted.pem`.
4. **Home region**: pick it from the list (it's shown on the Tenancy page). Resources are still listed in every subscribed region.

<insert [Oracle Cloud add-account form with the tenancy OCID, user OCID, fingerprint, private key and home region fields filled in] here>

### Grant permissions

Infrawrench can do whatever the key's user is allowed to do. For read-only access, add these policy statements to a group the user belongs to:

```
Allow group Infrawrench to read all-resources in tenancy
Allow group Infrawrench to read usage-report in tenancy
Allow group Infrawrench to inspect resource-availability in tenancy
```

Add `manage` grants for the resource families you want to create, edit, start and stop from Infrawrench (for example `manage instance-family`, `manage volume-family`, `manage autonomous-database-family`, `manage usage-budgets`). A compartment the user can't read shows as empty, not as an error.

## What you can manage

- **Tenancy**: home region, subscribed regions, spend this month with OCI's own month-end forecast, Universal Credits remaining per subscription line, and the carbon emissions OCI reports for the month by service.
- **Compartments**: create, rename and edit the description. Each shows its full path.
- **Compute instances**: create from a shape, image, subnet and SSH key. Start, graceful stop, reboot, force stop and reset. Edit to rename or resize. Flexible shapes are offered at common OCPU counts with OCI's default memory per OCPU, priced from Oracle's public price list. Resizing a running instance reboots it.
- **Boot volumes** and **block volumes**: grow the size and change the performance level (VPUs per GB). Create block volumes and drag them onto an instance in the same availability domain to attach.
- **VCNs**, **subnets** and **security lists**: create VCNs and subnets, and rename all three. Security lists show their rules and which ports are open to the internet.
- **Reserved public IPs**: reserve, rename and release.
- **Load balancers** (flexible shape): create in a subnet, rename, and change the minimum and maximum bandwidth. Health comes from OCI's load balancer health summary.
- **Object Storage buckets**: create them, change public access, versioning and auto-tiering, and browse, upload, create folders and delete objects.
- **Autonomous Databases**: create (paid or Always Free), start, stop, restart, and scale ECPUs, storage and auto scaling.
- **OKE clusters** and **node pools**: rename, upgrade the Kubernetes version, upgrade a basic cluster to enhanced, scale node pools, and download a kubeconfig. OKE kubeconfigs get their token through the OCI CLI, so the machine that uses one needs the OCI CLI set up.
- **Budgets** and **budget alert rules**: create a monthly budget on a compartment or a cost-tracking tag (both picked from lists), with an optional alert rule in the same step. Edit the amount, and add, edit and delete email alert rules on actual or forecast spend.

## Metrics

Metrics tabs show data from OCI Monitoring:

- Instances: CPU and memory utilisation, load average, network and disk throughput and operations. These need the Oracle Cloud Agent, which is on by default for platform images.
- Block volumes: read and write throughput and operations, throttled I/Os.
- Load balancers: HTTP requests, active connections, bytes in and out, peak bandwidth, unhealthy backends.
- Buckets: stored bytes and object count (hourly).
- Autonomous Databases: CPU and storage utilisation, sessions, allocated ECPUs, executions, query latency, failed connections.
- OKE clusters: API server requests and unschedulable pods.

## Costs

Oracle Cloud accounts feed [cost graphs & budgets](../features/cloud-costs.md) with your billed amount per day, broken down by service, SKU, region and resource, with each resource's compartment path as a tag. Amounts are in your tenancy's billing currency, after your rate card and discounts. OCI keeps twelve months of history and can take up to 48 hours to report a day, so recent days may still change.

Universal Credits commitments appear in [credit burndown](../features/credit-burndown.md) with the remaining amount, the committed amount and the end date of each subscription line. Tenancies on Oracle's older subscription system show no commitments.

Price estimates in create and edit forms use Oracle's public pay-as-you-go list prices in USD, before Always Free allowances or negotiated rates.

## Savings, limits and carbon

- **Potential savings** flags stopped instances (their boot and block volumes keep billing), stopped Autonomous Databases (storage keeps billing), unattached boot and block volumes, unassigned reserved IPs, and load balancers with no backend sets.
- **Right-sizing** suggests a smaller size in the same shape series for instances whose CPU and memory stay low, and you can apply it in one step.
- **Quota & limit radar** tracks regional service limits in your home region for networking, load balancing, block storage, databases, OKE and Object Storage.
- **Carbon estimates** cover instances in regions whose country has a published grid figure. Other regions show no estimate rather than a guess. The tenancy page also shows OCI's own reported emissions.
- **Posture checks** flag public buckets and security lists that open SSH or RDP to the internet.

## Tips & limits

- A resource you created outside Infrawrench a few seconds ago may need a refresh to appear.
- Create forms ask for availability domain 1, 2 or 3 in the chosen region. Single-AD regions only have AD 1.
- Manage load balancer listeners, backend sets and certificates in the OCI Console.
- The [Terraform export](../features/terraform-export.md) covers compartments, instances, block volumes, VCNs, subnets, reserved IPs, load balancers, buckets, Autonomous Databases, OKE clusters, budgets and alert rules, using the `oracle/oci` provider.
