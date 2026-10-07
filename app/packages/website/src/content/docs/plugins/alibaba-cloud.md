---
title: Alibaba Cloud
description: Manage Alibaba Cloud ECS, disks, networking, load balancers, RDS, Tair (Redis), OSS, ACK, Function Compute, DNS and RAM users, with CloudMonitor metrics, daily billed spend, the account balance and Quota Center limits.
sidebar_order: 50
---

Connect an Alibaba Cloud account on the international site (alibabacloud.com) with a RAM user's AccessKey. Infrawrench lists resources in every region open to the account, reads metrics from CloudMonitor, and collects billed spend from the billing API.

## Credentials

1. In the [RAM console](https://ram.console.alibabacloud.com/users), open **Identities**, then **Users**, and create a user with **Using permanent AccessKey to access** (OpenAPI access) enabled. A dedicated user keeps what Infrawrench can do separate from people's accounts.
2. Create an AccessKey for it and copy the **AccessKey ID** (`LTAI…`) and the **AccessKey secret**. The secret is only shown once.
3. Pick a **default region**: new resources default to it, and account-wide calls (the region list, quotas) go there.
4. Optionally pick **regions to scan**. The list is loaded from your account once the key is entered; leave it empty to scan every region open to the account.

<insert [Alibaba Cloud add-account form with the AccessKey ID, AccessKey secret, default region and the regions-to-scan picker filled in] here>

### Permissions

Infrawrench can only do what the RAM user's policies allow. For a read-only connection attach these system policies:

- `ReadOnlyAccess` to list everything,
- `AliyunBSSReadOnlyAccess` for costs and the account balance,
- `AliyunQuotasReadOnlyAccess` for quota tracking.

Add the full-access policies of the services you want to create, edit, start and stop from Infrawrench, for example `AliyunECSFullAccess`, `AliyunVPCFullAccess`, `AliyunRDSFullAccess`, `AliyunKvstoreFullAccess`, `AliyunOSSFullAccess`, `AliyunCSFullAccess`, `AliyunFCFullAccess`, `AliyunDNSFullAccess` and `AliyunRAMFullAccess`. A region where the user lacks permission, or where a service is not activated, lists as empty rather than failing the account.

## What you can manage

- **Account**: the account id, the identity the key belongs to, the regions being scanned, spend billed this month and the account balance.
- **ECS instances**: create from an instance type (only types on sale in the chosen region are offered), an operating system, a system disk, an optional vSwitch and security group, public bandwidth and an SSH key; start, stop, reboot and force stop; rename, edit the description and change the instance type. Leave the vSwitch empty to use the region's default VPC in a zone that sells the type, and leave the security group empty to create or reuse an `infrawrench-ssh` group that allows SSH. Pay-as-you-go instances are stopped in economical mode, which stops compute billing.
- **Disks**: create in a zone, grow, rename, change whether a disk is deleted with its instance, take a snapshot, detach, and drag a disk onto an instance in the same zone to attach it.
- **Snapshots**: create from a disk, rename and change the retention period.
- **VPCs**, **vSwitches** and **security groups**: create and rename all three. New security groups can start with SSH, or SSH plus HTTP and HTTPS, open. Each group shows its inbound rules and which ports are open to the internet.
- **Elastic IPs**: allocate, rename, change the bandwidth, drag onto an instance to associate, and unassociate.
- **Classic Load Balancers (CLB)**: rename, start and stop; the detail page lists listeners and backend servers.
- **Application Load Balancers (ALB)**: rename and delete.
- **ApsaraDB RDS**: create MySQL, PostgreSQL, MariaDB or SQL Server instances (classes come from what is on sale in your default region, with Alibaba's reference prices), rename, change the class and storage, restart. The endpoint and port are outputs other resources can reference.
- **Tair (Redis OSS-compatible)**: create standard instances, rename, change the class, restart. Endpoint and port are outputs.
- **OSS buckets**: create with a storage class, redundancy and access level; change access and versioning; browse, upload, create folders and delete objects.
- **ACK clusters** and **node pools**: rename, upgrade the control plane to a newer Kubernetes version, rename and scale node pools, and download a kubeconfig. ACK kubeconfigs carry a client certificate, so the cluster also opens in the [Kubernetes](./kubernetes.md) tab.
- **Function Compute 3.0 functions**: change memory, vCPUs, timeout and description, disable or enable invocations, and see the HTTP trigger URL.
- **Alibaba Cloud DNS**: add domains, and add, edit, enable, disable and delete records.
- **RAM users**: create, edit the display name, email and comments, and delete. Each user shows its access keys, directly attached policies and last console login, and feeds the [access review](../features/access-review.md).

## Metrics

Metrics tabs read CloudMonitor:

- ECS instances: CPU, memory and load (memory and load need the CloudMonitor agent, installed by default on Alibaba's public images), network and disk throughput and IOPS.
- RDS: CPU, memory, disk, IOPS and connection utilisation, network traffic and queries.
- Tair (Redis): CPU, memory and connection utilisation, requests, hit rate, traffic and key count.
- CLB: active and new connections, traffic, requests, 5xx responses and response time.
- ALB: requests, connections, traffic, 5xx responses, request time, unhealthy backends and LCUs.
- OSS buckets: internet and private traffic, GetObject requests and availability.
- Functions: invocations, server, client and function errors, average and P99 duration and memory.

## Costs

Alibaba Cloud accounts feed [cost graphs & budgets](../features/cloud-costs.md) with the billed amount per day from the instance bill, broken down by product, region and resource, with resource tags, billing item, subscription type and resource group as tags. The amount is after discounts and coupons, and the original price is kept as the list amount. Refunds and adjustments are marked as such. Alibaba keeps 18 months of bills, reports each day about 24 hours later, and only finalises a month on the 3rd of the next, so the last five weeks are re-read on every collection.

The account balance appears in [credit burndown](../features/credit-burndown.md).

Price estimates in create forms come from Alibaba's own price API for the chosen region: instance type and system disk for ECS, size and category for disks, and class plus storage for RDS. Internet traffic is billed by usage and is not included.

## Savings, limits and security

- **Potential savings** flags instances stopped while still billing compute (subscription instances, or ones stopped without economical mode), unattached disks and unassociated Elastic IPs.
- **Right-sizing** recommends a smaller ECS instance type in the same family when CPU and memory stay low.
- **Quota & limit radar** tracks ECS and VPC quotas from Quota Center in the default region.
- **Posture checks** flag security groups that open SSH or RDP to the internet and OSS buckets that are publicly readable or writable.
- The status page shows Alibaba Cloud incidents in progress, matched to the regions you use.

## Tips & limits

- Alibaba Cloud's China mainland regions are included; finance and government clouds are not.
- New RDS instances only accept connections from the IPs you list (127.0.0.1 by default); add your VPC's CIDR block to reach them from ECS.
- Tair passwords and RDS accounts are set in the Alibaba Cloud console; Alibaba never returns them, so database connection strings are not offered as outputs.
- Function Compute functions are listed, edited and deleted here, but created with your deployment tooling, since a function needs its code.
- The [Terraform export](../features/terraform-export.md) maps instances, disks, snapshots, VPCs, vSwitches, security groups, Elastic IPs, CLBs, RDS and Tair instances, OSS buckets, DNS domains and records, and RAM users to the `aliyun/alicloud` provider.
