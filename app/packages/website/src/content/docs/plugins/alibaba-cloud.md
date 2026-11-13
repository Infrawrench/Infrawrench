---
title: Alibaba Cloud
description: Manage Alibaba Cloud ECS, disks, networking, load balancers, RDS, Tair (Redis), OSS, ACK, Function Compute, DNS and RAM users, with CloudMonitor metrics, daily billed spend, the account balance and Quota Center limits.
sidebar_order: 50
---

Connect an Alibaba Cloud account on the international site (alibabacloud.com) with a RAM user's AccessKey. You get resources from every region open to the account, CloudMonitor metrics and your billed spend.

## Connect your account

1. In the [RAM console](https://ram.console.alibabacloud.com/users), open **Identities**, then **Users**, and create a user with **Using permanent AccessKey to access** (OpenAPI access) enabled. A dedicated user keeps what Infrawrench can do separate from people's accounts.
2. Create an AccessKey for it and copy the **AccessKey ID** (`LTAI…`) and the **AccessKey secret**. The secret is only shown once.
3. Pick a **default region**. New resources default to it, and the region list and quotas are read from it.
4. Optionally pick **regions to scan**. The list loads from your account once you enter the key. Leave it empty to scan every region open to the account.

<insert [Alibaba Cloud add-account form with the AccessKey ID, AccessKey secret, default region and the regions-to-scan picker filled in] here>

### Permissions

Infrawrench can only do what the RAM user's policies allow. For a read-only connection, attach these system policies:

- `ReadOnlyAccess` to list everything,
- `AliyunBSSReadOnlyAccess` for costs and the account balance,
- `AliyunQuotasReadOnlyAccess` for quota tracking.

To create, edit, start and stop resources, add the full-access policies of those services, for example `AliyunECSFullAccess`, `AliyunVPCFullAccess`, `AliyunRDSFullAccess`, `AliyunKvstoreFullAccess`, `AliyunOSSFullAccess`, `AliyunCSFullAccess`, `AliyunFCFullAccess`, `AliyunDNSFullAccess` and `AliyunRAMFullAccess`. If the user lacks permission in a region, or a service isn't activated there, that region shows as empty instead of breaking the account.

## What you can manage

- **Account**: the account id, the identity the key belongs to, the regions being scanned, spend billed this month and the account balance.
- **ECS instances**: create from an instance type (you only see types on sale in the chosen region), an operating system, a system disk, an optional vSwitch and security group, public bandwidth and an SSH key. Start, stop, reboot and force stop. Rename, edit the description and change the instance type. Leave the vSwitch empty to use the region's default VPC in a zone that sells the type. Leave the security group empty to create or reuse an `infrawrench-ssh` group that allows SSH. Pay-as-you-go instances stop in economical mode, which stops compute billing.
- **Disks**: create in a zone, grow, rename, choose whether a disk is deleted with its instance, take a snapshot and detach. Drag a disk onto an instance in the same zone to attach it.
- **Snapshots**: create from a disk, rename and change the retention period.
- **VPCs**, **vSwitches** and **security groups**: create and rename all three. New security groups can start with SSH open, or SSH plus HTTP and HTTPS. Each group shows its inbound rules and which ports are open to the internet.
- **Elastic IPs**: allocate, rename, change the bandwidth, drag onto an instance to associate, and unassociate.
- **Classic Load Balancers (CLB)**: rename, start and stop. The detail page lists listeners and backend servers.
- **Application Load Balancers (ALB)**: rename and delete.
- **ApsaraDB RDS**: create MySQL, PostgreSQL, MariaDB or SQL Server instances (you pick from classes on sale in your default region, with Alibaba's reference prices), rename, change the class and storage, and restart. The endpoint and port are outputs other resources can reference.
- **Tair (Redis OSS-compatible)**: create standard instances, rename, change the class and restart. Endpoint and port are outputs.
- **OSS buckets**: create with a storage class, redundancy and access level. Change access and versioning. Browse, upload, create folders and delete objects.
- **ACK clusters** and **node pools**: rename, upgrade the control plane to a newer Kubernetes version, rename and scale node pools, and download a kubeconfig. The cluster also opens in the [Kubernetes](./kubernetes.md) tab.
- **Function Compute 3.0 functions**: change memory, vCPUs, timeout and description, disable or enable invocations, and see the HTTP trigger URL.
- **Alibaba Cloud DNS**: add domains, and add, edit, enable, disable and delete records.
- **RAM users**: create, edit the display name, email and comments, and delete. Each user shows its access keys, directly attached policies and last console login, and appears in the [access review](../features/access-review.md).

## Metrics

Metrics tabs show CloudMonitor data:

- ECS instances: CPU, memory and load, network and disk throughput, and IOPS. Memory and load need the CloudMonitor agent, which Alibaba's public images install by default.
- RDS: CPU, memory, disk, IOPS and connection utilisation, network traffic and queries.
- Tair (Redis): CPU, memory and connection utilisation, requests, hit rate, traffic and key count.
- CLB: active and new connections, traffic, requests, 5xx responses and response time.
- ALB: requests, connections, traffic, 5xx responses, request time, unhealthy backends and LCUs.
- OSS buckets: internet and private traffic, GetObject requests and availability.
- Functions: invocations, server, client and function errors, average and P99 duration, and memory.

## Costs

Your billed amount per day shows up in [cost graphs & budgets](../features/cloud-costs.md), broken down by product, region and resource. Resource tags, billing item, subscription type and resource group are available as tags. Amounts are after discounts and coupons, and the original price is kept as the list amount. Refunds and adjustments are marked as such.

Alibaba keeps 18 months of bills. Each day appears about 24 hours later, and a month is only final on the 3rd of the next month, so recent figures can still change.

The account balance appears in [credit burndown](../features/credit-burndown.md).

Create forms show price estimates from Alibaba for the chosen region: instance type and system disk for ECS, size and category for disks, and class plus storage for RDS. Internet traffic is billed by usage and isn't included.

## Savings, limits and security

- **Potential savings** flags instances stopped while still billing compute (subscription instances, or ones stopped without economical mode), unattached disks and unassociated Elastic IPs.
- **Right-sizing** suggests a smaller ECS instance type in the same family when CPU and memory stay low.
- **Quota & limit radar** tracks ECS and VPC quotas from Quota Center in the default region.
- **Posture checks** flag security groups that open SSH or RDP to the internet, and OSS buckets that are publicly readable or writable.
- The status page shows Alibaba Cloud incidents in progress, matched to the regions you use.

## Run CI jobs

An Alibaba Cloud connection can run [Infrawrench CI](../features/ci.md) cloud jobs once an organization admin opts it in. Each job gets fresh compute in the region's default VPC, in the job's `cloud.region` (the default region when it names none), which is removed when the job ends:

| `cloud.kind` | Runs on                                       | Default `machine` | Default `image`                               |
| ------------ | --------------------------------------------- | ----------------- | --------------------------------------------- |
| `vm`         | A pay-as-you-go ECS instance with a public IP | `ecs.g8i.large`   | Ubuntu 24.04                                  |
| `container`  | An ECI container group with an EIP            | `2vcpu-4gb`       | `docker.io/library/buildpack-deps:noble-curl` |

A `vm` `machine` is an instance type; a GPU type such as `ecs.gn7i-c8g1.2xlarge` brings its GPU. A `vm` image other than the default is an image ID. A container `machine` is `<vCPUs>vcpu-<GB>gb`; ECI rounds a size it doesn't offer up to the next one. ECI isn't offered in every region.

The first job in a region makes a security group named `infrawrench-ci` in the default VPC: an advanced (enterprise) group that lets nothing in and everything out, so jobs reach the internet and don't reach each other. A region with no default VPC can't run jobs until you create one.

The job's compute has no RAM role, so it holds no Alibaba Cloud credentials. Every job also ends on its own: an instance has an automatic release time at the job's deadline (at least 30 minutes after it starts), and a container group has a deadline of its own. An instance that shuts itself down keeps billing until it is released. Pay-as-you-go instances bill per second with a minimum of 10 minutes at 1 vCPU, 5 at 2 and 2 at 4 or more. When a container group is deleted, any public address it had that is left unbound is released.

RAM has no call that checks a permission without using it. Opting a connection in reads what it can and makes dry runs, and names any action that is refused, but a passed dry run of a launch doesn't prove the action is granted. Grant the RAM user:

- **`vm`**: `ecs:RunInstances`, `ecs:DescribeInstances`, `ecs:DeleteInstances`, `ecs:DescribeImages`, `ecs:DescribeInstanceTypes`, `ecs:DescribeAvailableResource` and `ecs:TagResources`.
- **`container`**: `eci:CreateContainerGroup`, `eci:DescribeContainerGroups`, `eci:DeleteContainerGroup`, `vpc:DescribeEipAddresses` and `vpc:ReleaseEipAddress`, plus `ram:CreateServiceLinkedRole` once, if ECI's service-linked role `AliyunServiceRoleForECI` doesn't exist yet.
- **Both**: `vpc:DescribeVpcs`, `vpc:DescribeVSwitches`, `ecs:DescribeSecurityGroups` and `ecs:DescribeSecurityGroupAttribute`, plus `ecs:CreateSecurityGroup` and `ecs:AuthorizeSecurityGroupEgress` until the region's CI group exists.

## Tips & limits

- China mainland regions are included. Finance and government clouds are not.
- New RDS instances only accept connections from the IPs you list (127.0.0.1 by default). Add your VPC's CIDR block to reach them from ECS.
- Set Tair passwords and RDS accounts in the Alibaba Cloud console. Alibaba never returns them, so database connection strings aren't offered as outputs.
- You can list, edit and delete Function Compute functions here, but create them with your deployment tooling, since a function needs its code.
- The [Terraform export](../features/terraform-export.md) maps instances, disks, snapshots, VPCs, vSwitches, security groups, Elastic IPs, CLBs, RDS and Tair instances, OSS buckets, DNS domains and records, and RAM users to the `aliyun/alicloud` provider.
