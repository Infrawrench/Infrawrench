---
title: CoreWeave
description: Track GPU-hours and estimated spend by cluster, instance type and capacity plan, manage CKS clusters, Node Pools, VPCs and AI Object Storage buckets, chart GPU utilization, and see per-namespace GPU cost inside each cluster.
sidebar_order: 51
---

## What you can manage

- **Organization**: one row for the organization your token belongs to. Its page shows this month's billable GPU-hours and estimated spend, broken down by instance type (SKU), by cluster and by capacity plan (On-Demand, Reserved, Spot, Flex). The Metrics tab charts billable GPU-hours and estimated spend per day.
- **CKS clusters**: status, zone, Kubernetes version, VPC and network prefixes, API server endpoint, and a roll-up of Node Pools, Nodes, GPUs and the current hourly run rate. Create a cluster by picking a VPC, a Kubernetes version and the VPC prefixes to use for pods, services and internal load balancers (each a picker of that VPC's prefixes). **Edit** changes the Kubernetes version (one minor version at a time) and whether the API server is public. Delete removes the cluster.
- **Kubernetes tab on every cluster**: workloads, logs, exec and the rest of the [Kubernetes plugin](./kubernetes.md), with no kubeconfig to download. The cluster hands Infrawrench a kubeconfig built from your API token, plus its instance prices, so the tab also shows cost per namespace and per workload, idle capacity, and efficiency. A private cluster (API server not public) shows how to reach it instead.
- **Node Pools**: listed under their cluster, with instance type, GPU model, compute class, target, current, queued and booting Nodes, GPUs and run rate. **Create** one by picking an instance type (types offered in the cluster's zone come first, each with its GPUs and price), Reserved/On-Demand or Spot, and a size or autoscaler bounds. **Edit** to scale: target Nodes, autoscaling on or off, the autoscaler minimum and maximum, and the scale-down strategy. **Scale to zero** remembers the current size and **Restore size** brings it back, which is what [sleep/wake schedules](../features/sleep-schedules.md) use to park GPU capacity overnight.
- **Instance types**: every CoreWeave GPU and CPU instance with its GPUs, GPU memory, vCPUs, RAM, local storage, the zones it is offered in, how many Nodes of it you are running, and its price per instance-hour, per GPU-hour and per month.
- **VPCs**: zone, status, host prefixes and named VPC prefixes. Create one with the pod, service and internal load balancer prefixes CoreWeave's own examples use (edit them as needed), add prefixes later, and block public ingress or Internet egress.
- **AI Object Storage buckets**: zone, size, estimated monthly cost, audit logging, archiving and capacity cap. Browse, upload, download and delete objects in the storage browser. Create and delete buckets, and **Edit** audit logging, archiving of idle objects (and after how many days) and the capacity cap.
- **Object Storage access keys**: ID, name, owner, status and expiry. **Suspend owner's keys** and **Reactivate owner's keys** act on every key the owner holds, which is how CoreWeave manages key status. Expiring keys appear on the [expiry radar](../features/expiry-radar.md).

GPU metrics on clusters and Node Pools come from CoreWeave's metrics service: average GPU utilization, tensor core activity, GPUs reporting, idle GPUs, GPU memory used and power draw. Clusters also chart billable GPU-hours per day.

<insert [CoreWeave CKS cluster page showing the Node Pools table with instance type, target and current Nodes, GPUs and USD/hour, and the Metrics tab with GPU utilization] here>

## Credentials

- **API access token** (required): create one on the **Tokens** page of the CoreWeave Cloud Console (it starts with `CW-SECRET-`). One token covers everything: the Cloud API, each cluster's Kubernetes API, Object Storage (Infrawrench exchanges the token for short-lived S3 credentials itself, so there is no access key to create) and the metrics service. It carries its owner's permissions.
- **Negotiated rates** (optional): your contract prices, used instead of the published on-demand prices for cost estimates, run rates and the Kubernetes tab's workload costs. One entry per line or comma separated:
  - `gd-8xh100ib-i128=35.50`: USD per instance-hour for an instance type (the instance IDs are listed under **Instance types**);
  - `reserved/gb200-4x=30`, `spot/gd-8xh100ib-i128=19.90`, `flex/…`, `on-demand/…`: a rate for one capacity plan only;
  - `storage=0.06` and `objectStorage=0.05`: USD per GB-month of Distributed File Storage and AI Object Storage;
  - `ip=4`: USD per public IP per month.

  Edit the account's credentials to change them at any time; the next cost collection uses the new rates.

<insert [CoreWeave Add-account form with the API access token filled and the Negotiated rates field showing a few instance-type rates] here>

### Permissions

CoreWeave grants permissions through IAM access policies, as roles assigned to the token's owner. Run **Check credentials** on the add-account form or the account page: it probes one read per capability, and its [least-privilege generator](../core-concepts/credential-preflight.md) lists the roles to grant.

| Capability               | Role                                                                |
| ------------------------ | ------------------------------------------------------------------- |
| CKS clusters and VPCs    | `CKS Viewer` to read; `CKS Admin` to create, edit, scale and delete |
| Usage and estimated cost | `Billing Viewer`, plus the FOCUS usage export enabled (see below)   |
| AI Object Storage        | `Object Storage Admin`                                              |
| GPU metrics              | `Observability Viewer`                                              |

A capability the token cannot use lists empty rather than failing the whole account.

## Cost graphs

CoreWeave accounts feed [cost graphs & budgets](../features/cloud-costs.md) from CoreWeave's **FOCUS usage export**, the same billable usage the Cloud Console's Billing insights page shows, at hourly grain.

- **Turn on the export first.** It is in public preview and CoreWeave Support enables it per organization. Until then **Check credentials** says it is not enabled and no costs are collected.
- **The amounts are estimates.** The export reports usage (GPU-hours, instance-hours, GiB-hours of storage, IP-hours) but no money, so each quantity is multiplied by your negotiated rate where you entered one, otherwise by CoreWeave's published on-demand price. Every row's `pricing` tag says which (`negotiated` or `list`). Instance types CoreWeave only prices on request (GB300, B300, Vera Rubin and a few others) keep their usage with no money attached and are tagged `unpriced` until you add a rate. Credits, discounts you have not entered and tax are not included.
- **Breakdowns**: service (GPU Compute, CPU Compute, Storage, Network), region (the Availability Zone), resource (the cluster), and the tags `cluster`, `sku`, `gpuModel`, `capacityPlan` and `pricing`. Capacity plan comes from a second view of the same export and is apportioned to clusters by each day's plan mix for that SKU, so a Reserved hour can be priced at a reserved rate while still counting toward the cluster that used it.
- **History** starts on 2026-01-01, the earliest the export holds. The last three days are re-read on every collection while hourly figures settle.

The export currently covers CKS usage only. Object Storage cost is estimated per bucket on the bucket page instead.

<insert [CoreWeave organization page showing this month's GPU-hours and estimated spend with the By instance type, By cluster and By capacity plan tables] here>

## Export to Terraform

Clusters, VPCs and buckets export to the official `coreweave/coreweave` provider as `coreweave_cks_cluster`, `coreweave_networking_vpc` and `coreweave_object_storage_bucket` blocks, each with its `terraform import` id. OIDC, webhook, audit-policy and kubelet settings and VPC host prefixes are not carried over, so import and review the plan before applying. Node Pools are Kubernetes objects and are not exported. See [Export to Terraform](../features/terraform-export.md).

## Tips & limits

- **Rack-scale instances come in racks.** GB200, GB300 and Vera Rubin NVL72 Node Pools take a target that is a multiple of 18 and cannot autoscale; Infrawrench refuses other sizes before sending them.
- **Instance type is fixed.** A Node Pool's instance type cannot be changed; create a new pool instead.
- **Scale to zero does not hold capacity.** Nodes released by scaling to zero go back to CoreWeave, and **Restore size** queues for capacity like any scale-up.
- **Prices are dated.** List prices are CoreWeave's published North America on-demand rates as read when this version shipped; the instance type page says which date. Negotiated rates always win.
- **Private clusters.** Node Pools and the Kubernetes tab need the cluster's API server to be reachable: make it public, or attach a [bastion](../features/bastion-vms.md) in the cluster's VPC to the account.
- **Provider status** follows CoreWeave's status page, including maintenance windows once they start.
