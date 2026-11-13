---
title: CoreWeave
description: Track GPU-hours and estimated spend by cluster, instance type and capacity plan, manage CKS clusters, Node Pools, VPCs and AI Object Storage buckets, chart GPU utilization, and see per-namespace GPU cost inside each cluster.
sidebar_order: 51
---

Connect CoreWeave to manage your GPU clusters, Node Pools, networks and storage, and to see what your GPU capacity costs.

## What you can manage

- **Organization**: one row for the organization your token belongs to. Its page shows this month's billable GPU-hours and estimated spend, broken down by instance type (SKU), by cluster and by capacity plan (On-Demand, Reserved, Spot, Flex). The Metrics tab charts billable GPU-hours and estimated spend per day.
- **CKS clusters**: status, zone, Kubernetes version, VPC and network prefixes, API server endpoint, and a summary of Node Pools, Nodes, GPUs and the current hourly run rate. To create a cluster, pick a VPC, a Kubernetes version and the VPC prefixes to use for pods, services and internal load balancers (each a picker of that VPC's prefixes). **Edit** changes the Kubernetes version (one minor version at a time) and whether the API server is public. Delete removes the cluster.
- **Kubernetes tab on every cluster**: workloads, logs, exec and the rest of the [Kubernetes plugin](./kubernetes.md), with no kubeconfig to download. It also shows cost per namespace and per workload, idle capacity, and efficiency. For a private cluster (API server not public), the tab shows how to reach it instead.
- **Node Pools**: listed under their cluster, with instance type, GPU model, compute class, target, current, queued and booting Nodes, GPUs and run rate. **Create** one by picking an instance type (types offered in the cluster's zone come first, each with its GPUs and price), Reserved/On-Demand or Spot, and a size or autoscaler bounds. **Edit** to scale: target Nodes, autoscaling on or off, the autoscaler minimum and maximum, and the scale-down strategy. **Scale to zero** remembers the current size and **Restore size** brings it back. [Sleep/wake schedules](../features/sleep-schedules.md) use this to park GPU capacity overnight.
- **Instance types**: every CoreWeave GPU and CPU instance with its GPUs, GPU memory, vCPUs, RAM, local storage, the zones it's offered in, how many Nodes of it you run, and its price per instance-hour, per GPU-hour and per month.
- **VPCs**: zone, status, host prefixes and named VPC prefixes. Create one with the pod, service and internal load balancer prefixes from CoreWeave's own examples (edit them as needed), add prefixes later, and block public ingress or Internet egress.
- **AI Object Storage buckets**: zone, size, estimated monthly cost, audit logging, archiving and capacity cap. Browse, upload, download and delete objects in the storage browser. Create and delete buckets, and **Edit** audit logging, archiving of idle objects (and after how many days) and the capacity cap.
- **Object Storage access keys**: ID, name, owner, status and expiry. **Suspend owner's keys** and **Reactivate owner's keys** act on every key that owner holds, since that's how CoreWeave manages key status. Expiring keys appear on the [expiry radar](../features/expiry-radar.md).

Clusters and Node Pools chart GPU metrics: average GPU utilization, tensor core activity, GPUs reporting, idle GPUs, GPU memory used and power draw. Clusters also chart billable GPU-hours per day.

<insert [CoreWeave CKS cluster page showing the Node Pools table with instance type, target and current Nodes, GPUs and USD/hour, and the Metrics tab with GPU utilization] here>

## Credentials

- **API access token** (required): create one on the **Tokens** page of the CoreWeave Cloud Console. It starts with `CW-SECRET-`. One token covers everything: the Cloud API, each cluster's Kubernetes API, Object Storage (no separate access key needed) and GPU metrics. It has its owner's permissions.
- **Negotiated rates** (optional): your contract prices, used instead of published on-demand prices for cost estimates, run rates and workload costs in the Kubernetes tab. Put one entry per line, or separate them with commas:
  - `gd-8xh100ib-i128=35.50`: USD per instance-hour for an instance type (the instance IDs are listed under **Instance types**);
  - `reserved/gb200-4x=30`, `spot/gd-8xh100ib-i128=19.90`, `flex/…`, `on-demand/…`: a rate for one capacity plan only;
  - `storage=0.06` and `objectStorage=0.05`: USD per GB-month of Distributed File Storage and AI Object Storage;
  - `ip=4`: USD per public IP per month.

  You can change these any time by editing the account's credentials. The next cost collection uses the new rates.

<insert [CoreWeave Add-account form with the API access token filled and the Negotiated rates field showing a few instance-type rates] here>

### Permissions

CoreWeave grants permissions through IAM access policies, as roles assigned to the token's owner. Run **Check credentials** on the add-account form or the account page. It tests each capability, and its [least-privilege generator](../core-concepts/credential-preflight.md) lists the roles to grant.

| Capability               | Role                                                                |
| ------------------------ | ------------------------------------------------------------------- |
| CKS clusters and VPCs    | `CKS Viewer` to read; `CKS Admin` to create, edit, scale and delete |
| Usage and estimated cost | `Billing Viewer`, plus the FOCUS usage export enabled (see below)   |
| AI Object Storage        | `Object Storage Admin`                                              |
| GPU metrics              | `Observability Viewer`                                              |

Anything the token can't use shows as an empty list, and the rest of the account still works.

## Cost graphs

CoreWeave accounts feed [cost graphs & budgets](../features/cloud-costs.md) from CoreWeave's **FOCUS usage export**, the same billable usage the Cloud Console's Billing insights page shows, by the hour.

- **Turn on the export first.** It's in public preview, and CoreWeave Support enables it per organization. Until then, **Check credentials** says it isn't enabled and no costs are collected.
- **The amounts are estimates.** The export reports usage (GPU-hours, instance-hours, GiB-hours of storage, IP-hours) but no money. Each quantity is priced at your negotiated rate if you entered one, otherwise at CoreWeave's published on-demand price. Every row's `pricing` tag says which (`negotiated` or `list`). Instance types CoreWeave only prices on request (GB300, B300, Vera Rubin and a few others) show usage with no cost and are tagged `unpriced` until you add a rate. Credits, discounts you haven't entered, and tax aren't included.
- **Breakdowns**: service (GPU Compute, CPU Compute, Storage, Network), region (the Availability Zone), resource (the cluster), and the tags `cluster`, `sku`, `gpuModel`, `capacityPlan` and `pricing`. A Reserved hour is priced at your reserved rate and still counts toward the cluster that used it.
- **History** starts on 2026-01-01, the earliest the export holds. The last three days can change while hourly figures settle.

The export covers CKS usage only for now. Object Storage cost is estimated per bucket on the bucket page instead.

<insert [CoreWeave organization page showing this month's GPU-hours and estimated spend with the By instance type, By cluster and By capacity plan tables] here>

## Export to Terraform

Clusters, VPCs and buckets export to the official `coreweave/coreweave` provider as `coreweave_cks_cluster`, `coreweave_networking_vpc` and `coreweave_object_storage_bucket` blocks, each with its `terraform import` id. OIDC, webhook, audit-policy and kubelet settings and VPC host prefixes aren't included, so import and review the plan before you apply. Node Pools are Kubernetes objects and aren't exported. See [Export to Terraform](../features/terraform-export.md).

## CI jobs

To run [cloud jobs](../features/ci.md#cloud-jobs) on a CKS cluster, connect the cluster as a [Kubernetes](./kubernetes.md#ci-jobs) connection with its kubeconfig and opt that connection in. `gpu: nvidia:1` asks for a GPU node's `nvidia.com/gpu`.

## Tips & limits

- **Rack-scale instances come in racks.** GB200, GB300 and Vera Rubin NVL72 Node Pools need a target that's a multiple of 18 and can't autoscale. Other sizes are refused before they're sent.
- **Instance type is fixed.** You can't change a Node Pool's instance type; create a new pool instead.
- **Scale to zero doesn't hold capacity.** Nodes released by scaling to zero go back to CoreWeave, and **Restore size** waits for capacity like any scale-up.
- **Prices are dated.** List prices are CoreWeave's published North America on-demand rates at the time this version shipped. The instance type page shows the date. Negotiated rates always win.
- **Private clusters.** Node Pools and the Kubernetes tab need the cluster's API server to be reachable. In the web app, turn on **Public API Server**: the Kubernetes tab connects to the API server directly, not through a [bastion](../features/bastion-vms.md). The desktop app also works from a machine that can reach the private endpoint, such as one on the cluster's Tailscale proxy. Node Pools of a cluster Infrawrench can't reach keep their last values.
- **Provider status** follows CoreWeave's status page, including maintenance windows once they start.
