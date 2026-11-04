---
title: Kubernetes cost allocation
description: See what each namespace, workload and pod in a cluster actually costs, including compute, GPUs, volumes, load balancers, the control-plane fee and the capacity nobody is using.
sidebar_order: 3
---

A Kubernetes cluster has no billing API. The money isn't charged to the cluster. It's charged to the **cloud account that owns the nodes**, as virtual machines, disks and load balancers.

So Infrawrench works it out for you. Each pod gets its share of its node's hourly price, each PersistentVolumeClaim is charged to the workload that mounts it, each `LoadBalancer` Service is charged to the workload behind it, and the flat managed-cluster fee gets its own line. Everything is rolled up by workload and namespace. You'll see the results wherever the cluster already appears: the Kubernetes pane on your DOKS/GKE/EKS/AKS/Kapsule/Managed Kubernetes cluster, resource cards, detail views, the **Efficiency** tab, and the cluster's **Metrics** tab.

> **These are allocations, not billed amounts.** Nobody invoices you per namespace. Everything on this page is your node bill, divided up. Don't add a Kubernetes account's numbers to its parent cloud account's numbers, or you'll count the same money twice.

![Kubernetes peer pane on a DOKS cluster showing the Namespaces group ordered by cost, with each workload pill's subtitle reading "payments · 2/2 ready · ~$1.71/day · 18% mem"](https://agent-assets.infrawrench.com/docs-screenshots/features/kubernetes-costs/peer-pane-costs.png)

## What it needs

| Input                           | Where it comes from                                                       | Without it                                                              |
| ------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Node capacity and pod requests  | The Kubernetes API. Always available.                                     | Nothing works; this is the baseline.                                    |
| A per-node hourly price         | The parent cloud account, or the optional field on the account.           | Capacity and requests are still shown, but no money.                    |
| Live CPU/memory usage           | `metrics.k8s.io`, served by metrics-server.                               | Costs are based on requests alone. Efficiency reads **unknown**.        |
| PersistentVolumeClaims          | `/api/v1/persistentvolumeclaims`. Optional RBAC.                          | Storage shows as unavailable, not as zero.                              |
| `LoadBalancer` Services         | `/api/v1/services`. Optional RBAC.                                        | Load balancers show as unavailable, not as zero.                        |
| GPU utilization                 | NVIDIA's DCGM exporter or AMD's device metrics exporter.                  | GPUs are charged by request; requested-but-idle GPUs read **unknown**.  |
| Per-GiB-month and per-LB prices | The optional rates field (see below).                                     | Volume sizes and load-balancer counts are shown with no money attached. |
| The managed control-plane fee   | The optional rates field.                                                 | No control-plane line. A self-managed cluster genuinely has none.       |
| Per-pod network bytes           | The kubelet (`nodes/proxy`), Cilium Hubble, or the cloud's VPC flow logs. | No network costs for the cluster; everything else is unaffected.        |

A kubeconfig that can list pods but not PVCs still gets the full compute allocation.

### metrics-server is optional

Live usage comes from **metrics-server**. It's preinstalled on GKE, EKS, AKS and DOKS, but missing on many other clusters (bare kubeadm, kind, k3s without the bundled chart).

Without it, nothing breaks. The pane tells you, and costs are based on requests:

- **Not installed:** you get costs, but no efficiency figures and no "this workload is over-requested" flags.
- **Registered but unreachable:** metrics-server is crash-looping or blocked from the control plane. Worth fixing. The pane says so specifically.
- **Not permitted:** your kubeconfig can't read `metrics.k8s.io`. That's an RBAC fix, not a cluster fix.

Install metrics-server and the numbers get sharper on the next refresh. Nothing else needs changing.

## Where the node price comes from

There are two sources, checked in order.

**1. The cloud account that owns the nodes.** When you open the Kubernetes pane from a managed cluster, its cloud account supplies the node prices:

| Provider     | What it supplies                                                                                                    | Quality    |
| ------------ | ------------------------------------------------------------------------------------------------------------------- | ---------- |
| DigitalOcean | The published hourly price of each node pool's Droplet size, which is what DOKS worker nodes are actually billed at | Real price |
| AWS          | On-demand hourly price of the managed node groups' instance types.                                                  | List price |
| Azure        | Retail pay-as-you-go hourly price of every node pool's VM size, GPU pools included.                                 | List price |
| GCP          | On-demand price of each node pool: its machine type's cores and RAM, plus each attached GPU at its own price.       | List price |
| Scaleway     | Not yet.                                                                                                            | None       |
| OVHcloud     | Not yet.                                                                                                            | None       |

List prices don't include Savings Plans, Reserved Instances, committed-use discounts or Spot, which usually make the real number lower. The pane tells you which kind of price it used.

**2. Rates you enter.** A standalone Kubernetes account (one you added by pasting a kubeconfig, with no cloud account behind it) has an optional **Cluster hourly rates** field. List instance types and their hourly cost:

```
s-2vcpu-4gb=0.0357, m5.large=0.096
```

The instance type is matched against each node's `node.kubernetes.io/instance-type` label.

The same field prices everything else in the cluster, using these keys:

| Key                        | Means                                                                  | Example                                   |
| -------------------------- | ---------------------------------------------------------------------- | ----------------------------------------- |
| `controlPlane`             | The flat managed-cluster fee, per hour.                                | `controlPlane=0.10`                       |
| `loadBalancer`             | Per provisioned `LoadBalancer` Service, per hour.                      | `loadBalancer=0.0149`                     |
| `loadBalancer/<ns>/<name>` | One specific Service. Overrides the flat rate, **including with `0`**. | `loadBalancer/kube-system/metallb-demo=0` |
| `storage/<class>`          | Per **provisioned** GiB-month for one StorageClass.                    | `storage/gp3=0.08`                        |
| `storage/*`                | Per provisioned GiB-month for any class not named above.               | `storage/*=0.10`                          |
| `gpu/<model>`              | What one GPU costs per hour. Sets the GPU share of a GPU node's price. | `gpu/a100-80gb=3.93`                      |
| `gpu/*`                    | The same, for any GPU model not named above.                           | `gpu/*=2.50`                              |

```
s-2vcpu-4gb=0.0357, m5.large=0.096
controlPlane=0.10, loadBalancer=0.0149, storage/*=0.10
```

Every key is optional and independent. Add `storage/*` and your volumes get a price without anything else changing.

**If a price isn't available, none is made up.** You still get capacity, volume sizes, load-balancer counts, requests and (with metrics-server) efficiency, and the pane explains how to add the missing prices.

![Kubernetes peer pane showing the amber "Showing capacity and efficiency without cost" banner above the workload groups, with the suggestions listed](https://agent-assets.infrawrench.com/docs-screenshots/features/kubernetes-costs/peer-pane-unpriced.png)

## How costs are divided

### CPU and memory split

A node has one price for two resources, so Infrawrench splits it **65% CPU / 35% memory**, in line with how cloud providers price vCPUs and RAM separately on general-purpose machines. The split only moves money between workloads sharing a node. It never changes the cluster total, idle capacity or any efficiency figure.

### A pod pays the greater of its request and its usage

For CPU and memory separately, a pod is charged whichever is larger:

- A pod that **under-requests** and then uses the whole machine still pays for what it used.
- A pod that **requests a lot and sits idle** still pays for what it reserved.

Without usage data, pods are charged by request, and the pane says so.

Pod requests follow Kubernetes' own rules: init containers count as a peak rather than being added, sidecars (init containers with `restartPolicy: Always`) count toward both the init peak and the steady state, pod-level resources override the container total, and pod overhead is added on top.

### Idle capacity has its own line

Capacity no workload holds is shown separately, in two lines:

- **Idle:** schedulable capacity nobody asked for. Your cluster is bigger than its workloads.
- **System reserved:** capacity the kubelet keeps for itself. Never any workload's fault.

Neither is spread across namespaces, so each namespace shows what it actually uses and an oversized cluster stays visible.

The **control-plane fee** and **unattached volumes** get their own lines too. All four appear at the bottom of the cluster's cost table, labelled as capacity rather than anyone's spend.

![Cluster detail view showing the "Cost by namespace" table with per-namespace rows and the four distinct bucket rows at the bottom: "(idle · unallocated capacity)", "(system reserved · kubelet)", "(control plane · managed cluster fee)" and "(unattached volumes · mounted by nothing)"](https://agent-assets.infrawrench.com/docs-screenshots/features/kubernetes-costs/cost-by-namespace.png)

### Efficiency is used ÷ requested

Efficiency is shown per workload for CPU and memory. A workload using under 20% of what it reserved on **both** is flagged as over-requested: its pill turns amber and its efficiency stat shows as degraded.

Both have to be low. A workload using 5% of its CPU but 90% of its memory is sized correctly for memory.

Efficiency only appears with metrics-server. A workload with no usage data reads **unknown**, never 0%.

## GPUs

On a node with GPUs, the price is split three ways (GPU, CPU and memory), and the GPU part is charged by GPU requests. That way a CPU-only pod on an eight-GPU machine doesn't pay for GPUs, and GPU workloads pay their real share.

### Which nodes have GPUs, and how many

Infrawrench reads the resources and labels set by NVIDIA's device plugin and GPU feature discovery:

| What you run                                                   | Advertised as                                         | One unit is worth                                 |
| -------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------- |
| Whole GPUs                                                     | `nvidia.com/gpu`                                      | One GPU.                                          |
| MIG, `mixed` strategy                                          | `nvidia.com/mig-1g.5gb`, `nvidia.com/mig-3g.40gb`, …  | Its compute slices out of 7 (out of 4 on an A30). |
| MIG, `single` strategy, or GKE GPU partitioning                | `nvidia.com/gpu`, with the profile in the node labels | The profile's compute slices out of 7.            |
| Time-slicing or MPS (`replicas: N`), including GKE GPU sharing | `nvidia.com/gpu` or `nvidia.com/gpu.shared`           | 1/N of a GPU.                                     |
| AMD, Intel, Habana Gaudi, AWS Neuron, Cloud TPU                | `amd.com/gpu`, `gpu.intel.com/i915`, …                | One device (or core, for Neuron cores).           |

The physical GPU count comes from the `nvidia.com/gpu.count` label (or the GKE, Karpenter and EKS Auto Mode equivalents). The model comes from `nvidia.com/gpu.product`, `cloud.google.com/gke-accelerator`, the Karpenter or EKS GPU name label, or, on AKS and other unlabelled nodes, the instance type (`p4d.24xlarge`, `Standard_NC24ads_A100_v4`, `a2-highgpu-1g`, CoreWeave's `gd-8xh100ib-i128`).

A pod's GPU request follows the scheduler's rules: a container that only sets a limit (the usual way to ask for a GPU) gets an equal request, and init containers count as a peak rather than being added.

### The GPU share of a node's price

In order:

1. **A per-GPU price.** GKE clusters get one automatically, because Compute Engine bills attached GPUs separately. Anywhere else, set `gpu/<model>=<hourly price>` in the rates field. The GPU share is that price times the node's GPUs, capped at the node's own price.
2. **A published reference ratio.** For models with a published Compute Engine price (T4, P4, P100, V100, L4, A100 40GB and 80GB, H100, H200), the GPU share is the GPU's fraction of a reference machine with the same GPUs, vCPUs and memory, based on Compute Engine's [accelerator-optimized pricing](https://cloud.google.com/products/compute/pricing/accelerator-optimized) in Iowa. Because it's a ratio, it works whatever the node really costs: list, billed or negotiated.
3. **The remainder.** For any other model (an A10G, an L40S, an AMD Instinct), the node's vCPUs and memory are priced at standard rates and the rest of the node's price is the GPU.

The cluster's GPU tab shows which method priced each node.

### Two kinds of idle GPU

- **Unrequested GPUs** are GPUs no pod asked for. Like idle CPU they have their own line, never spread across workloads. On a GPU cluster this is usually the most expensive line on the page.
- **Requested but idle** is GPU time a workload holds but doesn't use, measured from GPU utilization. It counts as that workload's waste in the Efficiency report.

<insert [Cluster GPUs tab showing the GPU summary, the GPU nodes table with models, requested and unrequested GPUs and how each node's GPU share was priced, and the GPU workloads table] here>

### Where GPU utilization comes from

GPU utilization comes from NVIDIA's **DCGM exporter** (installed by the GPU operator as `nvidia-dcgm-exporter`) or AMD's **device metrics exporter**:

1. **Your Prometheus**, if one scrapes the exporter. Infrawrench finds common installs (`prometheus-operated`, `*-prometheus-server`, kube-prometheus-stack) automatically, or you can name one in the account's **GPU metrics source** field as `namespace/service:port`. This gives the last hour's average for idle cost, and a seven-day p95 for right-sizing.
2. **The DCGM exporter pods directly**, if no Prometheus has GPU data. This gives a snapshot: enough to show idle GPUs now, but not enough to recommend a smaller one.

The metrics used are DCGM's `DCGM_FI_DEV_GPU_UTIL` and `DCGM_FI_DEV_FB_USED`, with `DCGM_FI_PROF_GR_ENGINE_ACTIVE` for MIG instances, and AMD's `gpu_gfx_activity` and `gpu_used_vram`. Set the field to `none` to turn GPU metrics off.

**Time-sliced and MPS GPUs read unknown**, since DCGM can't tell which sharing container is doing the work.

<insert [Kubernetes account edit form with the optional "GPU metrics source" field filled in as monitoring/prometheus-operated:9090] here>

### GPU right-sizing

The Efficiency tab lists whole-GPU workloads that would fit a smaller MIG profile.

A workload is listed only when **every** one of its GPU pods holds whole, unshared NVIDIA GPUs on a MIG-capable model (A30, A100, H100, H200, B200), has a seven-day p95 from Prometheus, and is at least a day old. The suggestion is the smallest profile whose compute and memory both cover the busiest GPU's p95 utilization and peak memory with 25% headroom, and the saving is the GPU cost the other slices free up. On a GPU without MIG (a T4, an L4), a workload under 30% p95 is pointed at time-slicing or MPS instead, without a figure.

To act on one, repartition the node (the GPU operator's `nvidia.com/mig.config` label) and change the workload's request to the profile's resource.

## Beyond node compute

A cluster's bill isn't only machines. Three more things are allocated.

### Persistent volumes

Infrawrench reads every PersistentVolumeClaim and finds the workload whose running pods mount it.

| Situation                               | Charged to                                            |
| --------------------------------------- | ----------------------------------------------------- |
| Exactly one workload mounts the claim   | That workload.                                        |
| Several workloads mount it (RWX)        | The namespace.                                        |
| **Bound, but no running pod mounts it** | Its own line (see below).                             |
| Never bound (`Pending`, `Lost`)         | Nobody. It's counted and shown, but **never priced**. |

The size charged is `status.capacity.storage` (what was actually provisioned), not the request, since providers round up. A claim that hasn't bound yet shows its request, labelled as such.

Storage is priced per **provisioned** GiB-month, the way block storage is billed: you pay for the disk size, not the bytes written. Monthly rates use 730 hours, like the providers' own calculators.

**Volumes nothing mounts are shown as waste, not as a workload's cost.** They get their own line next to idle capacity, but keep their namespace tag so you know where to run `kubectl delete pvc`.

A common cause: a StatefulSet's `volumeClaimTemplates` PVCs are kept by default on **both** scale-down and delete. Scaling a StatefulSet from five replicas to two leaves three disks behind, still billing. Deleting the StatefulSet leaves all five.

### Load balancers

A `LoadBalancer` Service creates a real cloud load balancer with a real price. Its `spec.selector` is matched against pod labels to find the workload behind it. If it matches one workload, the load balancer is charged there. If it matches several (a canary or blue/green pair sharing one Service) or none, it's charged to the namespace.

A Service with **no address** in `status.loadBalancer.ingress` hasn't finished provisioning. It's counted, so you can spot a stuck one, but not charged.

`spec.loadBalancerClass` is shown but never used to set a price, since a non-default class might cost nothing (MetalLB, kube-vip) or plenty (the AWS Load Balancer Controller). Use a per-Service rate of `0` to exclude one.

### The control plane

Managed Kubernetes services charge a flat per-cluster fee: [EKS](https://aws.amazon.com/eks/pricing/) is "$0.10 per cluster per hour" on standard support and $0.60 on extended, [GKE](https://cloud.google.com/kubernetes-engine/pricing) charges "a flat cluster management fee of $0.10 per cluster per hour … irrespective of the mode of operation, cluster size, or topology", and [AKS](https://learn.microsoft.com/en-us/azure/aks/free-standard-pricing-tiers)'s Standard tier is $0.10 per cluster per hour.

This fee doesn't belong to any workload, so it gets its own line next to idle and system reserved, and is never spread across workloads.

A self-managed cluster has no such fee and no line for it. Its control plane runs on nodes that are already priced as compute.

### Network traffic has its own view

Pod traffic is allocated too, but separately. See [Network costs](#network-costs) below.

![Cluster detail view "What the cluster costs" section showing the per-component breakdown: Nodes, Control plane, Persistent volumes, Unattached volumes, Load balancers, Total](https://agent-assets.infrawrench.com/docs-screenshots/features/kubernetes-costs/what-the-cluster-costs.png)

## The efficiency report

Every cluster and namespace has an **Efficiency** tab you can open, share and act on.

It shows, per namespace and per workload: what was requested, what's actually used, the CPU and memory ratios, **what the unused part costs**, and the total cost. Worst first.

![Cluster Efficiency tab showing the summary key-values above the "By workload, worst first" table, with the worst workload's wasted-per-day figure at the top and a row further down reading "unknown"](https://agent-assets.infrawrench.com/docs-screenshots/features/kubernetes-costs/efficiency-tab.png)

**Sorted by money, not percentage.** A workload at 4% efficiency on a tiny request matters less than one at 40% on half a node. The order is:

1. Workloads with a priced waste figure, most expensive first. This is the list to act on.
2. Workloads with usage data on a node with no price, ranked by wasted CPU cores.
3. Workloads with no usage data, alphabetically, at the bottom.

**A workload with no usage data reads `unknown`, not 0%.** If metrics-server goes down, your cluster won't suddenly look like it's wasting everything.

**Three kinds of waste, shown separately,** because each has a different fix:

- **Requested but unused:** workloads holding capacity they don't use. Fix by editing `resources.requests`.
- **Idle node capacity:** capacity nobody requested. Fix by shrinking the cluster.
- **Unattached volumes:** disks no running pod mounts. Fix by deleting them.

### By node group

On the cluster's tab, the **By node group** table splits machines by node pool and capacity type (spot, on-demand or reserved): how many nodes, their daily cost, how much is idle, and how much is held by unused requests. Since you resize pools, not workloads, this table tells you things like "the spot pool is 40% idle". Nodes with no pool label are grouped by instance type. The same table is in the **Share** text.

<insert [Cluster Efficiency tab scrolled to the "By node group, most idle first" table, showing a spot pool and an on-demand pool with their idle percentages and idle cost per day] here>

### Share it

At the end of the tab, the **Share** block has the whole report as fixed-width text with a copy button. Figures, caveats and the timestamp come together, so you can paste it into a ticket or Slack thread.

Each workload row also has an **Open** link to that Deployment, StatefulSet or DaemonSet.

### Across clusters and over time

This tab covers one cluster, right now. For the same view across every cluster and over a time window, saved and shareable, use [Kubernetes efficiency reports](./kubernetes-efficiency.md).

### Right-sizing workloads

Infrawrench's [right-sizing](./right-sizing.md) is for **VMs**. It doesn't recommend new request values for Kubernetes workloads, because pod usage data only covers the last few seconds, and a single snapshot can't tell you a workload's peak.

So the report gives you the evidence (the money, the ratio, and the worst offenders in order) and leaves the new number to you. Change requests with the [manifest editor](./manifest-editor.md).

## System namespaces are included

Workload listings hide `kube-system`, `kube-public` and provider-managed namespaces so you don't have to scroll past them.

Cost allocation **includes** them, since those pods use real capacity on the same nodes. They appear in the tables and cost data tagged `system=true`, so you can filter them out if you like.

The **Namespaces group in the Kubernetes pane** follows the listings, so system namespaces aren't shown or counted there: the number in `Namespaces (5) · by cost` always matches the pills below it. Their costs are on the **Cost by namespace** table and the **Efficiency** tab.

## Where you'll see it

- **The Kubernetes pane** on your cloud cluster: a Namespaces group ordered by cost, and cost and efficiency on every pod, deployment, statefulset, daemonset and namespace pill. A namespace pill reads `Active · ~$4.20/day · 18% CPU`: the phase, the day's cost, and the lower of its two efficiency figures. Its banner also flags unattached volumes, never-bound claims and anything unpriced.
- **Resource cards:** cost per day and efficiency for clusters, namespaces, pods, deployments, statefulsets and daemonsets. The cluster card also shows **Idle** with its percentage (of node cost, not the whole bill), an **Over-requested** money figure, and **Volumes** and **Load balancers** counts. On a GPU cluster it adds **GPUs**, **Idle GPUs** and **Requested GPU idle**, and anything holding GPUs gets a **GPU** stat.
- **Detail views:** a **Cost by namespace** table on the cluster with a Storage/LB column (and a GPU column on GPU clusters) plus the idle, system reserved, idle GPU, control plane and unattached volume rows; a **What the cluster costs** breakdown; and a **Cost by workload** table on each namespace.
- **The GPUs tab** on clusters with GPUs: every GPU node, how its GPU share was priced, and every GPU workload with its utilization.
- **The Efficiency tab** on the cluster and every namespace.
- **The Storage & load balancers tab:** every claim and `LoadBalancer` Service, with who it's charged to and what it costs.
- **Metrics tabs:** cost, each component, waste and efficiency over time.
- **The cloud cluster's own Metrics tab:** the same cluster-level figures appear next to the provider's node metrics, so cluster spend sits beside cluster CPU.
- **[Cost graphs and budgets](./cloud-costs.md):** costs are recorded daily, so they chart and budget like any other spend.

<insert [DOKS cluster Metrics tab showing the provider's node CPU series alongside the merged "Cluster cost", "Allocated to workloads" and "Idle capacity" series] here>

## In cost graphs

Kubernetes costs are recorded daily alongside every other provider's, so you can use them in graphs, filters, budgets and the `infrawrench costs` CLI.

Dimensions:

| Dimension           | Values                                                                         |
| ------------------- | ------------------------------------------------------------------------------ |
| Service             | One of the labels below                                                        |
| Resource            | The object identity: `namespace/Kind/name`                                     |
| Tag `namespace`     | The Kubernetes namespace                                                       |
| Tag `workload`      | The owning Deployment / StatefulSet / DaemonSet / Job name, where there is one |
| Tag `workload_kind` | That owner's kind                                                              |
| Tag `system`        | `true` for the control-plane namespaces                                        |
| Tag `gpu_model`     | On GPU rows: the GPU model (`a100-80gb`, `t4`, …)                              |
| Tag `k8s_resource`  | `cpu`, `memory`, `gpu`, `storage`, `network` or `control_plane`                |
| Tag `k8s_usage`     | `used`, `unused`, `unmeasured`, `idle` or `overhead`                           |
| Region              | The node's region; on cluster-wide rows, only when all nodes agree             |

Pod, node and volume labels are dimensions too. See [Node and volume labels](#node-and-volume-labels) below. [Kubernetes efficiency reports](./kubernetes-efficiency.md) use the `k8s_resource` and `k8s_usage` tags.

Each unit of money appears under exactly one service label, so you can add them up without double counting:

| Service                      | Is                                                                    |
| ---------------------------- | --------------------------------------------------------------------- |
| `kubernetes-workload`        | A workload's share of node compute.                                   |
| `kubernetes-storage`         | A PersistentVolumeClaim, attributed to its workload or its namespace. |
| `kubernetes-load-balancer`   | A `LoadBalancer` Service.                                             |
| `kubernetes-idle`            | Schedulable node capacity nobody requested.                           |
| `kubernetes-system-reserved` | Node capacity the kubelet keeps.                                      |
| `kubernetes-storage-idle`    | A bound volume no running pod mounts.                                 |
| `kubernetes-control-plane`   | The flat managed-cluster fee.                                         |
| `kubernetes-gpu`             | A workload's share of GPU node price, charged by its GPU requests.    |
| `kubernetes-gpu-idle`        | Allocatable GPUs no pod requested, one row per GPU node.              |

A workload's `kubernetes-workload` rows cover **CPU and memory only** (one row each, split into used and unused where usage is measured). Its GPUs, disks and load balancers are under their own labels. Group by the `namespace` tag for a per-team view including storage, filter to `kubernetes-workload` for compute only, or filter to `kubernetes-storage-idle` for a list of disks to delete.

GPU spend by model, from the terminal:

```bash
infrawrench costs --where "provider = 'kubernetes'" --group-by tag:gpu_model
```

The MCP tools have the same data: `query_costs` groups and filters by these services and tags, and `get_resource_stats` / `get_resource_metrics` on a cluster, namespace or workload return GPU stats and series.

## Node and volume labels

You can also slice costs by what pods ran **on** (a node pool, spot versus on-demand, a team's dedicated nodes) and by what volumes **are** (the app a claim belongs to, its storage class). These are recorded as tags every day, so you can group and filter by them everywhere: cost graphs, saved filters, budgets, allocation rules, billing rules, the query language, the CLI and the in-app agent.

### Always recorded

Every row that comes from a node (a workload's compute share, idle capacity, system reserved capacity) includes the node's details, whatever your provider calls them:

| Tag             | Value                                                                                                                        |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `node_pool`     | The node pool or node group: Karpenter NodePool, EKS node group, GKE node pool, AKS agent pool, DOKS, Kapsule, OVHcloud, LKE |
| `capacity_type` | `spot`, `on-demand` or `reserved`; absent when no provider label says                                                        |
| `instance_type` | The machine type                                                                                                             |
| `zone`          | The availability zone                                                                                                        |

Every volume row includes `storage_class`.

A workload running on several kinds of node gets one row per kind, so you can tell its spot and on-demand compute apart. The rows still add up to the same total. Idle and system reserved capacity are split the same way, so "how much idle spot capacity are we paying for" is one group-by.

### Choose which labels to record

Any pod, node or PersistentVolumeClaim label can become a dimension too, recorded as `k8s_pod_label:<label key>`, `k8s_node_label:<label key>` and `k8s_pvc_label:<label key>`. To choose them, open the Kubernetes account, choose **Update credentials**, and use the **Pod labels for cost**, **Node labels for cost** and **Volume labels for cost** pickers. They list the label keys on your cluster, most common first, with sample values.

<insert [Update credentials modal on a Kubernetes account with the "Node labels for cost" picker open, listing label keys like team and karpenter.sh/nodepool with their node counts and sample values] here>

If you leave them blank, defaults are used: standard topology and architecture labels for nodes, the `app.kubernetes.io/*` labels for claims and pods (plus `app` for pods), and `team`, `owner`, `environment` and `cost-center` for all three, wherever your objects have them. Choose **none** to record no extra labels. Labels that change per pod or per rollout, such as `pod-template-hash`, are never recorded.

Labels that are different on every node (`kubernetes.io/hostname`, a node or instance id) aren't offered, since they'd split every workload into one row per node. Each setting can have up to 20 keys. Changes apply from the next daily collection. Earlier days keep the labels they were recorded with.

### Use them

- **Cost graphs:** group by **Tag** and pick the key. Kubernetes node and volume labels have their own headings in the picker.
- **Filters, saved filters and budgets:** add a **Tag** filter row. The key box suggests every key in your cost data.
- **Query language:** `k8s_node_label['team'] = 'payments'` is shorthand for `tag['k8s_node_label:team'] = 'payments'`, and `k8s_pvc_label['app.kubernetes.io/name'] = 'postgres'` and `k8s_pod_label['team'] = 'search'` work the same way. The standard tags are plain tags: `tag['capacity_type'] = 'spot'`.
- **Allocation rules:** match a cost centre on a node or volume label from the Tag Policy page, for example everything on nodes labelled `team=data`.
- **CLI:** `infrawrench costs --group-by tag:capacity_type` groups by a plain tag, and `--group-by k8s_node_label:team` or `--group-by k8s_pvc_label:app.kubernetes.io/name` by a label. `infrawrench costs tag-keys` lists every key with the `--group-by` value to use (add `--json` for scripts).

**History starts when you connect the account.** Kubernetes only reports what's running now, so each day adds one snapshot and there's nothing to backfill.

## Network costs

The **Kubernetes network costs** section on the [Costs panel](./cloud-costs.md#the-costs-panel)'s **Network** tab shows which workloads move bytes across which billing boundary: same zone (usually free), cross-zone, cross-region and internet egress. For each cluster you get:

- **By traffic class:** bytes and money per boundary.
- **By namespace** and **by workload:** who sent it, which boundaries each mostly crossed, and how it was measured.
- **Top talkers:** workload to peer pairs, largest first. A peer is another workload, the internet, or a boundary class when the peer itself wasn't seen.
- **Billed data transfer:** your cluster's real data transfer bill split across the rows, once you've said which cost rows those are.

<insert [Costs panel, Kubernetes network costs section for one cluster: the headline with the estimate, billed and unallocated figures, the by-traffic-class list, and the by-workload table with a cross-zone workload at the top] here>

### Where the traffic data comes from

There are three optional sources, and Infrawrench uses the best one available for each pod:

| Source                                                                    | What it gives                                                                                                                                                                              | Label             |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------- |
| **The cloud's VPC flow logs**, from the cloud account that owns the nodes | The exact boundary every byte leaving each node crossed, split across the pods on it. Bytes the pods don't account for (host-network pods, the kubelet) stay on the node as their own row. | Cloud flow logs   |
| **Cilium Hubble** flow metrics                                            | Which workload talks to which. The boundary follows from where the peer's replicas run: two of three replicas in your zone means two thirds of the traffic is free.                        | In-cluster flows  |
| **The kubelet's per-pod counters** (`/stats/summary`)                     | Bytes per pod, with no destination. The boundary is **unknown** and is never priced.                                                                                                       | Pod counters only |

The section shows how much traffic came from each source. If most bytes are "pod counters only", workloads are ranked correctly by volume but you can't see which boundary costs money. Add one of the other two sources to get boundaries.

**What each source needs:**

- **Cloud flow logs:** [network flow collection](./network-costs.md) turned on for the AWS account that owns the nodes. Nothing else is needed on the cluster.
- **Cilium Hubble:** Hubble metrics on (port 9965, the chart default) with the `flow` metric's `labelsContext` including `source_namespace`, `source_workload`, `destination_namespace` and `destination_workload`. Traffic Hubble reports as leaving the cluster is labelled **outside the cluster** rather than internet, since that also covers things like a managed database in your own VPC.
- **Pod counters:** `get` on `nodes/proxy` for the kubeconfig. metrics-server uses the same permission, so most clusters already allow it.

Collection runs once a day for the previous full UTC day, controlled by the same [organization switch](./network-costs.md#turning-it-on) as VPC flow logs. Reading a cluster's own sources costs nothing on your cloud bill.

### How it's priced

Bytes are priced at the published transfer rates of the cloud your nodes run on (AWS, GCP, Azure or DigitalOcean, detected automatically), at the first paid tier, with no free allowance deducted. Azure hasn't charged for cross-zone transfer since 2024 and DigitalOcean has no zones, so cross-zone is free there.

Override any rate for a cluster in the account's **Cluster hourly rates** field, per GB:

```
network/cross_zone=0.008, network/internet_egress=0.05
```

The scopes are `intra_zone`, `cross_zone`, `cross_region`, `internet_egress`, `provider_service`, `nat_gateway` and `private_interconnect`. An override replaces the cloud's rate in every region for that cluster.

### Split the real bill

List prices are an estimate. To split what you were actually billed, open **Billed data transfer** under the cluster and pick the cost rows that are its data transfer: usually the cloud account that owns the nodes and its data transfer service (on AWS, `AWS Data Transfer`, plus `EC2 - Other` if you narrow it further by tag or region). It uses the same filter editor as cost graphs.

Then, every day:

- If the bill is **higher** than the estimate, each workload gets its estimate and the rest shows as **unallocated**: traffic the cluster didn't see, or other resources on the same bill line.
- If the bill is **lower** (a free allowance, a discount, pooled bandwidth), every workload is scaled down by the same factor, so the ranking stays the same.
- If nothing had a known boundary (pod counters only), the bill is split by bytes alone, and the section says so.

**Rows never add up to more than you were billed**, and the remainder is never spread across workloads. A day with traffic but no billing data yet (cost data usually lags a day or two) allocates nothing rather than guessing.

### Not part of your cost data

Unlike the rest of this page, network costs aren't recorded as `kubernetes-*` cost rows, because your cloud account already reports the same bytes on its data transfer line. For the same reason, cluster traffic is **left out of the org-wide network totals** and shown only per cluster. You can group and filter here by namespace, workload and traffic class.

### Use the CLI and AI clients

```
infrawrench k8s-network
infrawrench k8s-network prod-cluster --last 30d
infrawrench k8s-network prod-cluster --json
```

AI clients get `get_kubernetes_network_costs` and `set_kubernetes_network_billed_source` over [MCP](./mcp.md). The billed source is also an [OpenTofu/Terraform resource](./terraform-provider.md), `infrawrench_kubernetes_network_settings`.

## Limits

- **Scaleway and OVHcloud don't supply node prices yet.** Their clusters show capacity and efficiency without money unless you fill in the rates field.
- **GKE Autopilot and Spot node pools aren't priced.** Autopilot bills per pod rather than per node, and on-demand prices would overstate Spot several times over.
- **GPU reference prices are a ratio, not a price.** Without a per-GPU price, the GPU share of a node comes from published Compute Engine prices. Set `gpu/<model>=` for an exact split.
- **A MIG slice is priced by compute slices**, so a memory-heavy profile such as `1g.10gb` on an A100 40GB pays 1/7 of the card while using a quarter of its memory. Slices nobody configured or requested count as idle GPU.
- **AWS and Azure prices are list prices.** Commitments and Spot aren't reflected, so a heavily committed cluster will look expensive.
- **Storage, load balancer and control-plane prices aren't filled in automatically yet.** A cluster opened from its cloud account gets node prices, but you need to add `storage/*`, `loadBalancer` and `controlPlane` in the rates field. Until then, volumes and load balancers show as sizes and counts with no money.
- **Network costs are a daily average for pods running at collection time.** A pod that ran yesterday and is gone now isn't seen. See [Network costs](#network-costs).
- **How full a volume is isn't measured.** Storage is priced on provisioned size, which is what you're billed for, but a mostly empty volume isn't flagged the way an over-requested workload is.
- **Volumes and load balancers aren't browsable resources.** They appear on the cluster's tables and tabs, not in the sidebar with their own pages.
- **A pod on a node that has since been drained** is listed with its requests but no cost.
- **Labels are as of collection time.** A node relabelled at noon is recorded with whatever labels it had when that day's snapshot was taken.
- **Everything is a daily snapshot.** A volume deleted this morning simply stops appearing tomorrow.

## See also

- [Cost graphs & budgets](./cloud-costs.md)
- [Saved cost reports](./cost-reports.md)
- [Right-sizing](./right-sizing.md)
- [The Kubernetes plugin](../plugins/kubernetes.md)
- [Tag policy & showback](./tag-policy-and-showback.md)
