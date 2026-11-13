---
title: IBM Cloud
description: Manage IBM Cloud VPC servers, volumes and networking, Kubernetes Service and OpenShift clusters, Code Engine, Cloud Object Storage, Cloud Databases and service instances, with monthly billed spend and promotional credit.
sidebar_order: 50
---

Connect an IBM Cloud account with an API key to manage servers, networking, clusters, storage and databases in every VPC region, and to track billed spend and credit.

## Connect your account

1. In the IBM Cloud console, open **Manage > Access (IAM) > API keys** and choose **Create**. For a key that isn't tied to a person, create a **service ID** under **Access (IAM)** and give it an API key instead.
2. Paste the key. It's shown only once.
3. Pick a **default region**. New resources use it by default.
4. Optionally pick **regions to scan**. The list loads from your account once you enter the key. Leave it empty to scan every VPC region.

<insert [IBM Cloud add-account form with the API key, default region and the regions-to-scan picker filled in] here>

### Access you need to grant

Infrawrench can only do what the key's user or service ID is allowed to do:

- **Viewer** on VPC Infrastructure Services, Kubernetes Service, Code Engine, Cloud Object Storage, the Cloud Databases services and All Resource Groups, to list everything.
- **Editor** (and **Operator** for start and stop) on the services you want to create, edit and delete from Infrawrench.
- **Viewer** on Billing, for costs and credits.

A region where the key has no access just shows as empty.

## What you can manage

- **Account**: the account id, the key's owner, the regions being scanned, and billable spend this month.
- **Resource groups**: create, rename and delete.
- **Virtual Servers for VPC**: create from a profile, operating system, subnet and SSH key, with an optional floating IP. Start, stop, reboot and force stop. Rename and change the profile (IBM Cloud only allows a profile change while the server is stopped). The SSH key is registered in the region the first time you use it.
- **Block Storage volumes**: create in a zone with a performance tier, grow, rename, and drag onto a server in the same zone to attach.
- **VPCs**, **subnets**, **security groups**, **floating IPs** and **SSH keys**: create, rename and delete. New security groups allow all outbound traffic and can start with SSH, or SSH plus HTTP and HTTPS, open. Each group shows its inbound rules and which ports are open to the internet. Drag a floating IP onto a server to bind it.
- **Load balancers**: rename and delete. Each shows its hostname, listeners and pools.
- **Kubernetes Service and Red Hat OpenShift clusters**: update the master version, resize and delete worker pools, and delete clusters.
- **Code Engine**: create and delete projects. Create apps from a container image, change the image, port, scaling and CPU and memory, and delete them. The app URL is an output other resources can reference.
- **Cloud Object Storage buckets**: create in a cross-region or regional location with a storage class, delete, and browse, upload, create folders and delete objects. Each bucket shows its object count and stored size.
- **Cloud Databases** (PostgreSQL, MySQL, Redis, MongoDB, Elasticsearch, etcd, RabbitMQ): rename, scale memory, disk and dedicated CPU per member, and delete. Host and port are outputs.
- **Other service instances** (Key Protect, Event Streams, watsonx and so on): rename and delete. The dashboard link is an output.

## Costs

IBM Cloud billed usage shows in [cost graphs and budgets](../features/cloud-costs.md), per resource instance, plan and metric. IBM only reports usage by month, so every row is dated to the 1st of its month. Amounts are after discounts, and the price before discounts is kept as the list amount. The current and previous month keep updating while IBM finalizes them.

Promotional credit shows in [credit burndown](../features/credit-burndown.md) with its starting balance and expiry.

## Savings and security

- **Potential savings** flags stopped servers, unattached volumes, unbound floating IPs and load balancers with no pools.
- **Posture checks** flag security groups that open SSH or RDP to the internet.
- The status page shows IBM Cloud incidents and maintenance in the regions you use.

## Run CI jobs

An IBM Cloud connection can run [Infrawrench CI](../features/ci.md) cloud jobs once an organization admin opts it in. Each job gets fresh compute in the job's `cloud.region` (the default region when it names none), which is removed when the job ends:

| `cloud.kind` | Runs on                  | Default `machine` | Default `image`                               |
| ------------ | ------------------------ | ----------------- | --------------------------------------------- |
| `vm`         | A Virtual Server for VPC | `bx2-2x8`         | Ubuntu 24.04                                  |
| `container`  | A Code Engine job run    | `2vcpu-4gb`       | `docker.io/library/buildpack-deps:noble-curl` |

A `vm` `machine` is an instance profile; a GPU profile such as `gx3-16x80x1l4` brings its GPU. A `vm` image other than the default is an image ID or an image name. A container `machine` is `<vCPUs>vcpu-<GB>gb` from Code Engine's [supported combinations](https://cloud.ibm.com/docs/codeengine?topic=codeengine-mem-cpu-combo), such as `1vcpu-4gb`, `2vcpu-8gb` or `4vcpu-16gb`, and its disk is as large as its memory. A Code Engine job run lasts at most 24 hours.

The first `vm` job in a region makes a network for CI jobs: a VPC named `infrawrench-ci`, a public gateway and a subnet in its first zone, and a security group that lets nothing in and everything out. Jobs reach the internet and nothing of your own networks, and they don't reach each other. IBM bills the public gateway's address like a floating IP, by the month, and the VPC counts toward the region's quota of 10. The first `container` job in a region makes a Code Engine project named `infrawrench-ci`, which costs nothing and takes a minute or two to become active.

The job's compute holds no IBM Cloud credentials: an instance has no trusted profile and its metadata service is off, and a job run has no service account and no compute resource token. An instance's tags are written so they read back exactly, which is why they look escaped (`org__01_h...`) in the console; a job run's tags are in its `INFRAWRENCH_CI_TAGS` environment variable.

VPC has no time limit for an instance. A `vm` powers itself off when the job ends or its time is up, and Infrawrench deletes it, with its boot volume and network interface, when the job ends (and again later if that fails). A job run ends at the job's time limit.

IBM Cloud has no call that checks a permission without using it, so opting a connection in can only name a role when one of its reads is refused. Give the API key's owner (or service ID):

- **`vm`**: **Editor** (platform role) on VPC Infrastructure Services, which also covers tagging its instances.
- **`container`**: **Editor** (platform role) on Code Engine until the region's `infrawrench-ci` project exists, and **Writer** (service role) on it.

Code Engine builds aren't offered as a `build` kind: a build run builds an image from a Dockerfile or with buildpacks and pushes it with a registry secret; it can't run a script. Run Docker builds as a `vm` job instead.

## Tips and limits

- Resources have no metrics tab, because IBM Cloud only offers metrics through an IBM Cloud Monitoring instance.
- Kubernetes Service kubeconfigs aren't offered here. Download one with `ibmcloud ks cluster config`.
- Create clusters, databases and other service instances in the IBM Cloud console or catalog.
- The [Terraform export](../features/terraform-export.md) covers resource groups, servers, volumes, VPCs, subnets, security groups, floating IPs, load balancers, and Code Engine projects and apps, for the `IBM-Cloud/ibm` provider.
