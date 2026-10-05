---
title: Kubernetes cost allocation
description: Work out what each namespace, workload, and pod in a cluster actually costs — compute, GPUs, volumes, load balancers and the control-plane fee — including the capacity nobody is using.
sidebar_order: 3
---

A Kubernetes cluster has no billing API. Nothing inside it knows what it costs, because the money is not charged to the cluster — it is charged to the **cloud account that owns the nodes**, as a pile of virtual machines, disks and load balancers.

So Infrawrench derives it. Node capacity, times what that node costs per hour, times each pod's share of it; plus each PersistentVolumeClaim charged to the workload that mounts it; plus each `LoadBalancer` Service charged to the workload behind its selector; plus the flat managed-cluster fee in a bucket of its own. All rolled up by workload and namespace. The result appears wherever the cluster already appears: in the Kubernetes pane on your DOKS/GKE/EKS/AKS/Kapsule/Managed Kubernetes cluster, on the resource cards, on the detail views, on the new **Efficiency** tab, and on the cluster's own **Metrics** tab.

> **These are derived allocations, not billed amounts.** Nobody invoices you per namespace. Everything on this page is the node bill, re-cut. Do not add a Kubernetes account's numbers to its parent cloud account's numbers — that double-counts the same money.

![Kubernetes peer pane on a DOKS cluster showing the Namespaces group ordered by cost, with each workload pill's subtitle reading "payments · 2/2 ready · ~$1.71/day · 18% mem"](https://agent-assets.infrawrench.com/docs-screenshots/features/kubernetes-costs/peer-pane-costs.png)

## What it needs

| Input                           | Where it comes from                                                       | Without it                                                              |
| ------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Node capacity and pod requests  | The Kubernetes API. Always available.                                     | Nothing works; this is the baseline.                                    |
| A per-node hourly price         | The parent cloud plugin, or the optional field on the account.            | Capacity and requests are still shown — the money is omitted.           |
| Live CPU/memory usage           | `metrics.k8s.io`, served by metrics-server.                               | Allocation falls back to requests alone. Efficiency reads **unknown**.  |
| PersistentVolumeClaims          | `/api/v1/persistentvolumeclaims`. Optional RBAC.                          | Storage is reported as unavailable, not as zero.                        |
| `LoadBalancer` Services         | `/api/v1/services`. Optional RBAC.                                        | Load balancers are reported as unavailable, not as zero.                |
| GPU utilization                 | NVIDIA's DCGM exporter or AMD's device metrics exporter.                  | GPUs are charged by request; requested-but-idle GPUs read **unknown**.  |
| Per-GiB-month and per-LB prices | The optional rates field (see below).                                     | Volume sizes and load-balancer counts are shown with no money attached. |
| The managed control-plane fee   | The optional rates field.                                                 | No control-plane bucket. A self-managed cluster genuinely has none.     |
| Per-pod network bytes           | The kubelet (`nodes/proxy`), Cilium Hubble, or the cloud's VPC flow logs. | No network costs for the cluster; everything else is unaffected.        |

A kubeconfig that may list pods but not PVCs still gets the complete compute allocation. Nothing about the new components is allowed to break what already worked.

### metrics-server is optional

Live utilization comes from the `metrics.k8s.io/v1beta1` aggregated API, which is served by **metrics-server**. It ships preinstalled on GKE, EKS, AKS and DOKS, but is genuinely absent on plenty of clusters — bare kubeadm, kind, k3s without the bundled chart.

Its absence never breaks anything. The pane notes it and falls back to requests-based allocation:

- **Not installed** — the API was never registered. You get costs, but no efficiency figures and no "this workload is over-requested" flags.
- **Registered but unreachable** — metrics-server is crash-looping or blocked from the control plane. Worth fixing; the pane says so specifically rather than lumping it in with "not installed".
- **Not permitted** — your kubeconfig cannot read `metrics.k8s.io`. An RBAC fix, not a cluster fix.

Install metrics-server and the numbers get sharper on the next refresh. Nothing needs reconfiguring.

## Where the node price comes from

Two sources, in order.

**1. The cloud account that owns the nodes.** When you open the Kubernetes pane from a managed cluster resource, the cloud plugin hands its node prices to the Kubernetes plugin along with the kubeconfig. What it can supply varies:

| Provider     | What it supplies                                                                                                      | Quality    |
| ------------ | --------------------------------------------------------------------------------------------------------------------- | ---------- |
| DigitalOcean | The published hourly price of each node pool's Droplet size — which is what DOKS worker nodes are actually billed at. | Real price |
| AWS          | On-demand hourly price of the managed node groups' instance types.                                                    | List price |
| Azure        | Retail pay-as-you-go hourly price of every node pool's VM size, GPU pools included.                                   | List price |
| GCP          | On-demand price of each node pool: its machine type's cores and RAM, plus each attached GPU at its own price.         | List price |
| Scaleway     | Not yet.                                                                                                              | None       |
| OVHcloud     | Not yet.                                                                                                              | None       |

List prices are exactly that: Savings Plans, Reserved Instances, committed-use discounts and Spot all move the real number, usually downward. The pane says which kind of price it used.

**2. Rates you supply.** A standalone Kubernetes account — one you added by pasting a kubeconfig, with no cloud account behind it — has an optional **Cluster hourly rates** field. List instance types and their hourly cost:

```
s-2vcpu-4gb=0.0357, m5.large=0.096
```

The instance type is matched against each node's `node.kubernetes.io/instance-type` label.

The same field prices everything else the cluster costs, using reserved keys:

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

Everything here is optional and independent. Fill in only the node prices and you get exactly what you got before; add `storage/*` and the volumes acquire a price without anything else changing.

**If a price is not available, none is invented.** You get capacity, volume sizes, load-balancer counts, requests, and (with metrics-server) efficiency, and the pane explains what to do about the missing money. A fabricated number is worse than no number, because it gets believed.

![Kubernetes peer pane showing the amber "Showing capacity and efficiency without cost" banner above the workload groups, with the suggestions listed](https://agent-assets.infrawrench.com/docs-screenshots/features/kubernetes-costs/peer-pane-unpriced.png)

## How attribution works

### The node's price is split between CPU and memory

A node is one price for two resources, so the price has to be divided before a pod's share of it means anything. Infrawrench splits it **65% CPU / 35% memory**.

That is not a round number picked for tidiness. Cloud providers that publish _component_ pricing charge separately per vCPU-hour and per GiB-hour, and a general-purpose instance's price is the sum. Taking those published rates for the mainstream general-purpose families — which run at roughly 4 GiB of RAM per vCPU — the CPU term is consistently a little under two thirds of the machine price. GCP's N2 family in `us-central1`, for instance, prices vCPUs at $0.031611/hour and RAM at $0.004237/GiB-hour; for an `n2-standard-4` that is $0.126 of CPU against $0.068 of RAM, a 65% CPU share.

The split only moves money _between_ tenants sharing a node. It never changes the cluster total, the idle bucket, or any efficiency figure — so a few points of error is not load-bearing.

### A pod is charged the greater of its request and its usage

Not the request. Not the usage. The larger of the two, per dimension.

- A pod that **under-requests** and then eats the machine is still consuming it. Charging its request would let a `BestEffort` pod monopolise a node for free.
- A pod that **requests generously and idles** has denied that capacity to everyone else. Charging its usage would make hoarding free.

Charging the greater of the two is the only rule that is fair in both directions. Where there is no utilization data the rule degrades to requests alone, and the pane says so.

Pod requests use the real Kubernetes rules, not a naive sum of containers: init containers are compared as a peak rather than added, sidecars (init containers with `restartPolicy: Always`) count toward both the init peak and the steady state, pod-level resources override the container aggregate, and pod overhead is added on top.

### Idle capacity is its own line

Whatever the workloads on a node do not hold is reported separately, in two buckets:

- **Idle** — schedulable capacity nobody asked for. This is the cluster being bigger than its workloads.
- **System reserved** — the gap between the node's capacity and its allocatable, which the kubelet keeps for itself. Never any workload's fault.

Neither is spread across the namespaces. Doing that would overcharge every tenant _and_ hide the actual finding, which is that you are paying for a cluster larger than what you run on it. A cluster where half the money is in the idle row is telling you something specific, and it is not "the `payments` namespace is expensive".

Two more buckets join them for the same reason: the **control-plane fee** and **unattached volumes**. All four sit at the bottom of the cluster's cost table, labelled as capacity rather than as anyone's spend.

![Cluster detail view showing the "Cost by namespace" table with per-namespace rows and the four distinct bucket rows at the bottom — "(idle · unallocated capacity)", "(system reserved · kubelet)", "(control plane · managed cluster fee)" and "(unattached volumes · mounted by nothing)"](https://agent-assets.infrawrench.com/docs-screenshots/features/kubernetes-costs/cost-by-namespace.png)

### Efficiency is used ÷ requested

Reported per workload for CPU and memory. A workload using under 20% of what it reserved on **both** dimensions is flagged as over-requested — its pill turns amber and its efficiency stat goes degraded.

Both dimensions have to be low. A workload using 5% of its CPU but 90% of its memory is correctly sized for memory, and shrinking it would break it.

Efficiency only appears when metrics-server does. Requests alone say nothing about waste — so a workload nothing measured reads **unknown**, never 0%.

## GPUs

A GPU node is one price for three things: GPUs, CPU and memory. Splitting it only 65/35 between CPU and memory would charge a CPU-only pod that lands on an eight-GPU machine as if it held a slice of the GPUs, and let the GPU workload ride for the price of its vCPUs. So on a node with accelerators the price is split three ways, and the GPU part is charged by GPU requests.

### Which nodes have GPUs, and how many

Infrawrench reads each node's extended resources and labels, the ones NVIDIA's device plugin and GPU feature discovery set:

| What you run                                                   | Advertised as                                         | One unit is worth                                 |
| -------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------- |
| Whole GPUs                                                     | `nvidia.com/gpu`                                      | One GPU.                                          |
| MIG, `mixed` strategy                                          | `nvidia.com/mig-1g.5gb`, `nvidia.com/mig-3g.40gb`, …  | Its compute slices out of 7 (out of 4 on an A30). |
| MIG, `single` strategy, or GKE GPU partitioning                | `nvidia.com/gpu`, with the profile in the node labels | The profile's compute slices out of 7.            |
| Time-slicing or MPS (`replicas: N`), including GKE GPU sharing | `nvidia.com/gpu` or `nvidia.com/gpu.shared`           | 1/N of a GPU.                                     |
| AMD, Intel, Habana Gaudi, AWS Neuron, Cloud TPU                | `amd.com/gpu`, `gpu.intel.com/i915`, …                | One device (or core, for Neuron cores).           |

The physical GPU count comes from GPU feature discovery's `nvidia.com/gpu.count` label (or the GKE, Karpenter and EKS Auto Mode equivalents). The model comes from `nvidia.com/gpu.product`, `cloud.google.com/gke-accelerator`, the Karpenter or EKS GPU-name label, or, on AKS and other nodes no GPU component labelled, the instance type (`p4d.24xlarge`, `Standard_NC24ads_A100_v4`, `a2-highgpu-1g`, CoreWeave's `gd-8xh100ib-i128`).

A pod's GPU request follows the scheduler's rules: a container that sets only a limit (the usual way to ask for a GPU) gets an equal request, and init containers peak rather than add.

### The GPU share of a node's price

In order:

1. **A per-GPU price.** GKE clusters get one automatically, because Compute Engine bills an attached GPU as its own line. Anywhere else, `gpu/<model>=<hourly price>` in the rates field sets one. The GPU share is that price times the node's GPUs, capped at the node's own price.
2. **A published reference ratio.** For a model with a published Compute Engine price (T4, P4, P100, V100, L4, A100 40GB and 80GB, H100, H200), the GPU share is the GPU's fraction of a reference machine made of those GPUs plus the node's vCPUs and memory at N2 component prices. The per-GPU figures come from Compute Engine's [accelerator-optimized pricing](https://cloud.google.com/products/compute/pricing/accelerator-optimized) in Iowa: T4, P4, P100 and V100 are listed per GPU; L4, A100 and H100/H200 are sold inside G2, A2 and A3 machines, so their figure is the machine price minus its vCPUs and memory at N2 rates, per GPU. It is a ratio, so it holds whatever the node really costs: list, billed or negotiated.
3. **The remainder.** For any other model (an A10G, an L40S, an AMD Instinct), the node's vCPUs and memory are priced at those component rates and everything else the node costs is the GPU. CPU and memory prices are similar across clouds; GPU prices are not, which is why the GPU is the side left to fall out.

The GPU tab on the cluster says which of the three priced each node.

### Idle GPUs, two kinds

- **Unrequested GPUs** are allocatable GPUs no pod asked for. Like idle CPU they are their own bucket, never spread across tenants: on a GPU cluster this is usually the most expensive line on the page.
- **Requested but idle** is GPU time a workload holds and does not use, measured from GPU utilization. It is that workload's waste, and it is added to the Efficiency report's waste column.

<insert [Cluster GPUs tab showing the GPU summary, the GPU nodes table with models, requested and unrequested GPUs and how each node's GPU share was priced, and the GPU workloads table] here>

### Where GPU utilization comes from

`metrics.k8s.io` has no GPU figures, so utilization comes from NVIDIA's **DCGM exporter** (the GPU operator installs it as `nvidia-dcgm-exporter`) or AMD's **device metrics exporter**, read through the Kubernetes API server's proxy:

1. **Your Prometheus**, if one scrapes the exporter. Infrawrench finds the Services the common installs create (`prometheus-operated`, `*-prometheus-server`, kube-prometheus-stack) or the one you name in the account's **GPU metrics source** field as `namespace/service:port`. This gives the last hour's average for idle cost, and a seven-day p95 for right-sizing.
2. **The DCGM exporter pods directly**, if no Prometheus has GPU series. An instant sample: enough to show idle GPUs now, not enough to recommend a smaller one.

The metrics are DCGM's `DCGM_FI_DEV_GPU_UTIL` and `DCGM_FI_DEV_FB_USED`, with `DCGM_FI_PROF_GR_ENGINE_ACTIVE` for MIG instances (where GPU utilization is not reported), and AMD's `gpu_gfx_activity` and `gpu_used_vram`. Set the field to `none` to turn GPU metrics off.

**Time-sliced and MPS GPUs read unknown.** DCGM cannot tell which of the containers sharing a GPU is doing the work, so no per-pod figure is invented.

<insert [Kubernetes account edit form with the optional "GPU metrics source" field filled in as monitoring/prometheus-operated:9090] here>

### GPU right-sizing

The Efficiency tab lists whole-GPU workloads that would fit a smaller MIG profile. Unlike CPU and memory, this one can be named: a MIG profile is a discrete choice, a GPU request is one number, and a Prometheus scraping the exporter has the history a p95 needs.

A workload is listed only when **every** one of its GPU pods holds whole, unshared NVIDIA GPUs on a MIG-capable model (A30, A100, H100, H200, B200), has a seven-day p95 from Prometheus, and is at least a day old. The suggestion is the smallest profile whose compute slices and memory both cover the busiest device's p95 utilization and peak memory with 25% headroom, and the saving is the GPU cost the other slices free up. On a GPU with no MIG (a T4, an L4) a workload under 30% p95 is pointed at time-slicing or MPS instead, without a figure.

Acting on one means repartitioning the node (the GPU operator's `nvidia.com/mig.config` label) and changing the workload's request to the profile's resource.

## Beyond node compute

A cluster's bill is not only machines. Three more things are attributed, each by the tightest honest scope.

### Persistent volumes

A PersistentVolumeClaim is namespaced and is mounted by pods, which makes it genuinely attributable. Infrawrench reads every claim and follows `spec.volumes[].persistentVolumeClaim.claimName` on the running pods back to the workload that owns them.

| Situation                               | Charged to                                                         |
| --------------------------------------- | ------------------------------------------------------------------ |
| Exactly one workload mounts the claim   | That workload.                                                     |
| Several workloads mount it (RWX)        | The namespace. Splitting one shared disk N ways would be invented. |
| **Bound, but no running pod mounts it** | Its own bucket — see below.                                        |
| Never bound (`Pending`, `Lost`)         | Nobody. It is counted and reported, and **never priced**.          |

The size charged is `status.capacity.storage` — what the provisioner actually made — and not the request, because providers round up to their own minimums and the bill follows what exists. A claim that has not bound yet has no provisioned size, so its request is shown and labelled as a request.

Storage is priced per **provisioned** GiB-month. That is how block storage bills: you pay for the disk you asked for, not the bytes you wrote to it. The monthly rate is converted at 730 hours, the same conversion every major provider's own calculator uses.

**Volumes nothing mounts are their own waste finding, not a tenant's cost.** They get a bucket beside idle capacity rather than being added to their namespace's total — but the row keeps its namespace tag, because whoever has to run `kubectl delete pvc` needs to know where.

The usual cause is invisible unless you know to look for it. A StatefulSet's `volumeClaimTemplates` PVCs default to `Retain` on **both** scale-down and delete, so shrinking a StatefulSet from five replicas to two leaves three disks behind, billing, indefinitely. Deleting the StatefulSet entirely leaves all five.

### Load balancers

A `Service` of type `LoadBalancer` provisions a real cloud load balancer with a real price. Its `spec.selector` is matched against pod labels to find the workload behind it.

Services take equality-based selectors only — a plain map, never `matchExpressions` — so the match is exact rather than approximate. Where it resolves to a single workload, the load balancer is charged there; where it resolves to several (a canary or blue/green pair sharing one Service) or to none, it is charged to the namespace instead.

A Service with **no address** in `status.loadBalancer.ingress` has not finished provisioning. It is counted, so a stuck one is visible, but not charged — there is nothing yet to be billed for.

`spec.loadBalancerClass` is reported but never used to decide a price. A non-default class might be an in-cluster implementation that costs nothing (MetalLB, kube-vip) or a cloud controller that costs plenty (the AWS Load Balancer Controller), and only you know which. Use a per-Service rate of `0` to exclude one.

### The control plane

Every managed offering charges a flat per-cluster fee, and all three of the big ones charge the same shape of thing: [EKS](https://aws.amazon.com/eks/pricing/) is "$0.10 per cluster per hour" on standard support and $0.60 on extended, [GKE](https://cloud.google.com/kubernetes-engine/pricing) charges "a flat cluster management fee of $0.10 per cluster per hour … irrespective of the mode of operation, cluster size, or topology", and [AKS](https://learn.microsoft.com/en-us/azure/aks/free-standard-pricing-tiers)'s Standard tier is $0.10 per cluster per hour.

**It is not attributable to a workload at all.** It is the same number for a cluster running one pod as for one running ten thousand — there is no per-workload quantity to divide it by even if you wanted to. So it gets its own bucket beside idle and system-reserved, and is never spread across tenants.

A self-managed cluster has no such fee, and correctly gets no bucket: its control plane runs on nodes that are already in `/api/v1/nodes` and already priced as compute. Adding a fee there would count the same machines twice.

### Network traffic is its own view

Pod traffic is attributed too, but not as one more cost row. See [Network costs](#network-costs) below: it re-cuts the data-transfer line the cloud account already bills, so it lives with the network figures rather than in this partition.

![Cluster detail view "What the cluster costs" section showing the per-component breakdown — Nodes, Control plane, Persistent volumes, Unattached volumes, Load balancers, Total](https://agent-assets.infrawrench.com/docs-screenshots/features/kubernetes-costs/what-the-cluster-costs.png)

## The efficiency report

Efficiency used to be a percentage on a pill. It is now a report you can open, share and act on: an **Efficiency** tab on the cluster and on every namespace.

It shows, per namespace and per workload: what was requested, what is actually used, the CPU and memory ratios, **what the unused portion costs**, and the total attributed cost. Worst offenders first.

![Cluster Efficiency tab showing the summary key-values above the "By workload — worst first" table, with the worst workload's wasted-per-day figure at the top and a row further down reading "unknown"](https://agent-assets.infrawrench.com/docs-screenshots/features/kubernetes-costs/efficiency-tab.png)

**The money is the point.** The percentage is the diagnosis; the money is the argument. Nobody schedules an afternoon of work off a ratio, so the ordering is by cost of waste, not by percentage — a workload at 4% efficiency on a tiny request matters less than one at 40% on half a node, and sorting by ratio would put them the wrong way round.

**Ordering, precisely.** Three tiers, because they are not comparable:

1. Rows with a priced waste figure, most expensive first. This is the list you act on.
2. Rows that were measured but sit on a node with no hourly rate — ranked by wasted CPU cores, the biggest thing they can honestly be compared by.
3. Rows nothing measured, alphabetically, at the bottom.

**A workload with no usage data reads `unknown`, not 0%.** This matters more than it sounds. If an unmeasured workload rendered as 0% efficient, then the day your metrics-server crash-looped, every workload in the cluster would appear to be wasting everything — a cluster-wide emergency that is actually a monitoring outage. Unknown is a different claim from zero, and the report keeps them apart everywhere: the ratio cells, the used column, the wasted column, and the sort order.

**Three kinds of waste, kept separate.** The summary states them side by side because they have different fixes:

- **Requested but unused** — workloads holding capacity they do not touch. Fixed by editing `resources.requests`.
- **Idle node capacity** — capacity nobody requested at all. Fixed by shrinking the cluster, not by editing any workload.
- **Unattached volumes** — disks no running pod mounts. Fixed by deleting them.

Folding any of them into another would hide all three.

### By node group

On the cluster's tab, a **By node group** table splits the machines by node pool and capacity type (spot, on-demand or reserved): how many nodes, what they cost per day, how much of that is idle, and how much is held by requests nothing uses. Idle capacity belongs to a pool, not to a workload, and the pool is what you resize, so this is the table that says "the spot pool is 40% idle" or "the on-demand pool carries all the waste". Nodes with no pool label are grouped by instance type. The same table is in the **Share** text.

<insert [Cluster Efficiency tab scrolled to the "By node group — most idle first" table, showing a spot pool and an on-demand pool with their idle percentages and idle cost per day] here>

### Sharing it

The tab ends with a **Share** block: the whole report as fixed-width text, with a copy button. Figures, caveats and the timestamp travel together, so it can be pasted into a ticket or a Slack thread without a screenshot that goes stale without saying so.

Each workload row also carries an **Open** link straight to that Deployment, StatefulSet or DaemonSet.

### Why it is not a saved cost report

[Saved cost reports](./cost-reports.md) are saved _queries over stored cost rows_ — a chart config, run against the daily cost warehouse, rendered as one money-over-time card. The numbers this report is about (requested, used, wasted CPU and memory) are computed live from the cluster API and are never written to that warehouse; only the money is. There is no report-kind discriminator to extend and no per-row usage columns to query, so it lives where its data lives: on the cluster.

The cost side of the allocation still lands in the cost warehouse as usual, so cluster spend charts and budgets like any other provider's.

### Right-sizing: what this does and does not do

Infrawrench's [right-sizing](./right-sizing.md) finds oversized **VMs**: it takes a p95 over 14 days of stored metrics and matches it against the provider's catalog of discrete instance sizes with live prices, then applies the resize through the resource's normal update path.

**A Kubernetes recommendation is deliberately not added there, and this report deliberately stops short of naming a new request value.** Every piece of the VM machinery is wrong for a workload:

- There is no catalog. A pod request is a continuous, two-dimensional quantity set per container, not a choice from a menu — there is no "next size down".
- There is no update path. Resizing a workload is a patch to `spec.template.spec.containers[].resources`, which is the [manifest editor](./manifest-editor.md)'s job.
- There is no p95. `metrics.k8s.io` reports usage over a window of seconds. A "recommended request" derived from a single instantaneous sample is exactly the confident-looking invented number the rest of this feature refuses to produce — a workload's 03:00 sample does not describe its lunchtime peak.

So the report gives you the argument, not the answer: the money, the ratio, and the worst offenders in order. Deciding the new number is yours to make, against a workload whose shape you know.

## System namespaces are included

The workload listings hide `kube-system`, `kube-public`, and the provider-managed namespaces, because someone browsing their own workloads does not want to wade through them.

**Cost allocation deliberately does not inherit that.** Those pods sit on the same nodes and hold real capacity. Dropping them would make their spend vanish and make every other namespace look proportionally larger than it is. They appear in the tables and in the cost rows, tagged `system=true` so you can filter them out yourself if you want to.

The **Namespaces group in the Kubernetes pane follows the listings, not the allocation** — it is a filter over the workloads the pane shows, and there are no `kube-system` workloads to filter to. So system namespaces are neither offered there nor included in the group's count: the number in `Namespaces (5) · by cost` is always the number of pills below it. Their money is on the **Cost by namespace** table and the **Efficiency** tab, where nothing is hidden.

## Where it shows up

- **The Kubernetes pane** on your cloud cluster resource — a Namespaces group ordered by cost, and per-item cost and efficiency appended to every pod, deployment, statefulset, daemonset and namespace pill. A namespace pill reads `Active · ~$4.20/day · 18% CPU`: the phase, the day's allocated cost, and the tighter of its two efficiency figures. Its banner also flags unattached volumes, never-bound claims and unpriced components.
- **Resource cards** — cost/day and efficiency stats for clusters, namespaces, pods, deployments, statefulsets and daemonsets. The cluster card also carries an **Idle** stat with its percentage (measured against node cost, not the whole bill), an **Over-requested** money figure, and **Volumes** / **Load balancers** counts. On a GPU cluster it adds **GPUs**, **Idle GPUs** and **Requested GPU idle**, and anything holding GPUs gets a **GPU** stat.
- **Detail views** — a **Cost by namespace** table on the cluster with a Storage/LB column (and a GPU column on a GPU cluster) and the idle, system-reserved, idle-GPU, control-plane and unattached-volume rows; a **What the cluster costs** per-component breakdown; and a **Cost by workload** table on each namespace.
- **The GPUs tab** — on a cluster with accelerators: every GPU node, how its GPU share was priced, and every GPU workload with its utilization.
- **The Efficiency tab** — on the cluster and on every namespace.
- **The Storage & load balancers tab** — every claim and every `LoadBalancer` Service, with what it is attributed to and what it costs.
- **Metrics tabs** — cost, each component, waste and efficiency as time series.
- **The cloud cluster's own Metrics tab** — the same cluster-level series are merged in next to the provider's node metrics, so cluster spend sits beside cluster CPU rather than one tab deeper.
- **[Cost graphs and budgets](./cloud-costs.md)** — the allocation is written as daily cost rows, so it charts and budgets like any other spend.

<insert [DOKS cluster Metrics tab showing the provider's node CPU series alongside the merged "Cluster cost", "Allocated to workloads" and "Idle capacity" series] here>

## In cost graphs

Kubernetes accounts collect a daily snapshot into the same store every other provider writes to, so the allocation is available to graphs, filters, budgets, and the `infrawrench costs` CLI.

The dimensions it reports:

| Dimension           | Values                                                                         |
| ------------------- | ------------------------------------------------------------------------------ |
| Service             | One of the seven labels below                                                  |
| Resource            | The object identity — `namespace/Kind/name`                                    |
| Tag `namespace`     | The Kubernetes namespace                                                       |
| Tag `workload`      | The owning Deployment / StatefulSet / DaemonSet / Job name, where there is one |
| Tag `workload_kind` | That owner's kind                                                              |
| Tag `system`        | `true` for the control-plane namespaces                                        |
| Tag `gpu_model`     | On GPU rows: the GPU model (`a100-80gb`, `t4`, …), or `mixed`                  |

Node and volume labels are dimensions too; see [Node and volume labels](#node-and-volume-labels) below.

The service labels **partition** the bill — every unit of money appears under exactly one, so they can be summed without double-counting:

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

Because they partition, a workload's `kubernetes-workload` row carries its **CPU and memory compute only** — its GPUs, disks and load balancers are separate rows under their own labels. Group by the `namespace` tag for a per-team view including storage; filter to `kubernetes-workload` alone for compute only; filter to `kubernetes-storage-idle` for a standing list of disks to delete.

GPU spend by model, from the terminal:

```bash
infrawrench costs --where "provider = 'kubernetes'" --group-by tag:gpu_model
```

The same allocation reaches the MCP tools: `query_costs` groups and filters by these services and tags, and `get_resource_stats` / `get_resource_metrics` on a cluster, namespace or workload return the GPU stats and series.

## Node and volume labels

A namespace is only one way to slice a cluster. The same money can be cut by what the pods ran **on** (a node pool, spot versus on-demand, a team's dedicated nodes) and by what the volumes **are** (the app a claim belongs to, its storage class). Each daily snapshot records both as tags, so every cost surface can group and filter by them: cost graphs, saved filters, budgets, allocation rules, billing rules, the query language, the CLI and the in-app agent.

### What is always recorded

Every row derived from a node (a workload's compute share, idle capacity, system-reserved capacity) carries the node's shape, read from whichever provider labels are present so you never need to know what EKS, GKE or AKS call them:

| Tag             | Value                                                                                                                        |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `node_pool`     | The node pool or node group: Karpenter NodePool, EKS node group, GKE node pool, AKS agent pool, DOKS, Kapsule, OVHcloud, LKE |
| `capacity_type` | `spot`, `on-demand` or `reserved`; absent when no provider label says                                                        |
| `instance_type` | The machine type                                                                                                             |
| `zone`          | The availability zone                                                                                                        |

Every volume row carries `storage_class`.

A workload whose pods run on several kinds of node is written as one row per kind, under the same resource, so its spot and on-demand compute can be told apart. The rows still add up to the same total: nothing is apportioned or estimated, each pod's share is simply filed under the node it was bought from. Idle and system-reserved capacity are split the same way, so "how much idle spot capacity are we paying for" is one group-by.

### Choosing which labels to record

Any node label or PersistentVolumeClaim label can become a dimension too. They are recorded as tags named `k8s_node_label:<label key>` and `k8s_pvc_label:<label key>`. Which keys are recorded is a per-cluster setting: open the Kubernetes account, choose **Update credentials**, and use the **Node labels for cost** and **Volume labels for cost** pickers. They list the label keys actually present on the cluster, most common first, with a few sample values, so there is nothing to look up.

<insert [Update credentials modal on a Kubernetes account with the "Node labels for cost" picker open, listing label keys like team and karpenter.sh/nodepool with their node counts and sample values] here>

Left blank, each uses a short default: the standard topology and architecture labels for nodes, the `app.kubernetes.io/*` labels for claims, and `team`, `owner`, `environment` and `cost-center` for both, wherever your objects carry them. Choose **none** to record no extra labels.

**Why there is a limit.** Node labels split rows, so a label that is different on every node (`kubernetes.io/hostname`, a node or instance id) would turn every workload into one row per node per day. Those per-node keys are never recorded and are not offered in the picker, and each setting is capped at 20 keys. Changing the setting takes effect from the next daily collection; earlier days keep the labels they were collected with.

### Using them

- **Cost graphs:** group by **Tag** and pick the key. The tag-key picker groups Kubernetes node and volume labels under their own headings.
- **Filters, saved filters and budgets:** add a **Tag** filter row; the key box suggests every key in your cost data.
- **Query language:** `k8s_node_label['team'] = 'payments'` is shorthand for `tag['k8s_node_label:team'] = 'payments'`, and `k8s_pvc_label['app.kubernetes.io/name'] = 'postgres'` likewise. The normalised tags are plain tags: `tag['capacity_type'] = 'spot'`.
- **Allocation rules:** match a cost centre on a node or volume label from the Tag Policy page, for example everything on nodes labelled `team=data`.
- **CLI:** `infrawrench costs --group-by tag:capacity_type` groups by a plain tag, and `--group-by k8s_node_label:team` or `--group-by k8s_pvc_label:app.kubernetes.io/name` by a label. `infrawrench costs tag-keys` lists every key with the `--group-by` value that selects it (add `--json` for scripts).

**There is no history to backfill.** The Kubernetes API describes what is running right now, not what ran last Tuesday. Each daily collection appends one honest snapshot, and the series builds up from the day you connect the account. Unlike a provider that can restate a week of invoices, there is nothing here to restate.

## Network costs

The **Kubernetes network costs** section on the [Costs panel](./cloud-costs.md#the-costs-panel)'s **Network** tab answers which workloads are moving bytes across which billing boundary: same zone (usually free), cross-zone, cross-region, and internet egress. Per cluster, it shows:

- **By traffic class**: bytes and money per boundary.
- **By namespace** and **by workload**: who sent it, with the boundaries each one mostly crossed and how it was measured.
- **Top talkers**: workload → peer pairs, largest first. A peer is another workload, the internet, or a boundary class when the peer itself was not observed.
- **Billed data transfer**: the cluster's real data-transfer bill split across the rows, when you have said which cost rows those are.

<insert [Costs panel, Kubernetes network costs section for one cluster: the headline with the estimate, billed and unallocated figures, the by-traffic-class list, and the by-workload table with a cross-zone workload at the top] here>

### Where the bytes come from

Nothing in the Kubernetes API counts bytes per workload, so Infrawrench reads three sources past it, each optional and detected on every collection, and uses the strongest one available for each pod:

| Source                                                                    | What it gives                                                                                                                                                                                                                           | Label             |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| **The cloud's VPC flow logs**, from the cloud account that owns the nodes | The exact boundary every byte leaving each node crossed. Each node's bytes are split across the pods on it by their own counters; bytes the pods do not account for (host-network pods, the kubelet) stay on the node as their own row. | Cloud flow logs   |
| **Cilium Hubble** flow metrics                                            | Which workload each workload talks to. The boundary follows from where the peer's replicas run: two of three replicas in your zone means two thirds of the traffic is free.                                                             | In-cluster flows  |
| **The kubelet's per-pod counters** (`/stats/summary`)                     | Bytes per pod, with no destination at all. The boundary is **unknown** and is never priced.                                                                                                                                             | Pod counters only |

The section says how much of the traffic came from each. A cluster where most bytes are "pod counters only" is ranked correctly by volume but cannot tell you which boundary is costing money; add one of the other two sources and the same rows acquire boundaries.

**What each source needs:**

- **Cloud flow logs**: [network flow collection](./network-costs.md) on for the AWS account that owns the nodes. Nothing more on the cluster: the node's `spec.providerID` names the instance the flow log already reports.
- **Cilium Hubble**: Hubble metrics on (port 9965, the chart default) with the `flow` metric's `labelsContext` including `source_namespace`, `source_workload`, `destination_namespace` and `destination_workload`. Hubble counts flows, not bytes, so its counts weight the kubelet's byte counter. Traffic Hubble reports as leaving the cluster is labelled **outside the cluster** rather than internet: the same label covers a managed database in your own VPC.
- **Pod counters**: `get` on `nodes/proxy` for the kubeconfig. metrics-server reads the same endpoint, so most clusters already allow it.

Collection runs once a day for the previous closed UTC day, behind the same [organization switch](./network-costs.md#turning-it-on) as VPC flow logs. Reading a cluster's own sources costs nothing on your cloud bill.

### How it is priced

Bytes are priced at the published transfer rates of the cloud the nodes run on (AWS, GCP, Azure or DigitalOcean, detected from the nodes), at the first paid tier, with no free allowance deducted. Azure has not charged for cross-zone transfer since 2024 and DigitalOcean has no zones, so cross-zone is free there.

Override any rate for one cluster in the account's **Cluster hourly rates** field, per GB:

```
network/cross_zone=0.008, network/internet_egress=0.05
```

The scopes are `intra_zone`, `cross_zone`, `cross_region`, `internet_egress`, `provider_service`, `nat_gateway` and `private_interconnect`. An override replaces the cloud's rate in every region for that cluster.

### Splitting the real bill

List prices are an estimate. To split the money you were actually billed, open **Billed data transfer** under the cluster and pick the cost rows that are its data transfer: usually the cloud account that owns the nodes and its data-transfer service (on AWS, `AWS Data Transfer`, plus `EC2 - Other` if you narrow it further by tag or region). It uses the same filter editor as cost graphs, so the values come from your own cost data.

Then, every day:

- If the bill is **above** the list estimate, each workload gets its estimate and the rest is shown as **unallocated**: traffic the cluster did not observe, or other resources billed on the same line.
- If the bill is **below** the estimate (a free allowance, a discount, a pooled bandwidth allowance), every workload is scaled down by the same factor, so the ranking does not change.
- If nothing in the range had a known boundary (pod counters only), the bill is split by bytes alone, and the section says so.

**The rows never add up to more than was billed**, and the remainder is never spread across workloads. A day with traffic but no billed rows yet (cost collection lags a day or two) allocates nothing rather than guessing.

### Why it is not a cost row

Every other Kubernetes figure on this page is written to the cost store under a `kubernetes-*` service. Network costs deliberately are not: the cloud account already reports the same bytes on its own data-transfer line, and the cluster's pods leave through the node interfaces its VPC flow log counts. For the same reason the cluster's flows are **left out of the org-wide network totals** and shown only per cluster. The dimensions you group and filter by here are the namespace, the workload and the traffic class.

### From the CLI and AI clients

```
infrawrench k8s-network
infrawrench k8s-network prod-cluster --last 30d
infrawrench k8s-network prod-cluster --json
```

AI clients get `get_kubernetes_network_costs` and `set_kubernetes_network_billed_source` over [MCP](./mcp.md). The billed source is also an [OpenTofu/Terraform resource](./terraform-provider.md), `infrawrench_kubernetes_network_settings`.

## Limitations

- **Scaleway and OVHcloud supply no node price yet.** Their clusters show capacity and efficiency without money unless you fill in the rates field yourself.
- **GKE Autopilot and Spot node pools are not priced.** Autopilot bills per pod rather than per node, and on-demand prices would overstate Spot several times over.
- **GPU reference prices are a ratio, not a price.** Without a per-GPU price, the GPU share of a node comes from published Compute Engine component prices; set `gpu/<model>=` for an exact split.
- **A MIG slice is priced by compute slices**, so a memory-heavy profile such as `1g.10gb` on an A100 40GB pays 1/7 of the card while using a quarter of its memory. Slices nobody configured or requested land in the idle-GPU bucket.
- **AWS and Azure prices are list prices.** Commitments and Spot are not reflected, so a heavily-committed cluster will read high.
- **No cloud plugin supplies the storage, load-balancer or control-plane prices automatically yet.** They arrive through the same rates field, so a cluster opened from its cloud account gets node prices for free but needs `storage/*`, `loadBalancer` and `controlPlane` filled in by hand. Until they are, volumes and load balancers are shown as capacity and counts with no money.
- **Network costs are a daily average for pods running at collection time.** A pod that ran yesterday and is gone now is invisible to the kubelet, and the in-cluster sources are counters since each pod started. See [Network costs](#network-costs).
- **Volume _utilisation_ is not measured.** Storage is priced on what is provisioned, which is what is billed — but the cluster API cannot tell you how full a 500Gi disk is, so a mostly-empty volume is not flagged the way an over-requested workload is. The kubelet exposes that on its Prometheus endpoint, which is not part of the Kubernetes API.
- **Volumes and load balancers do not appear as browsable resources.** They are cost objects here, on the cluster's tables and tabs, not entries in the sidebar with their own detail pages.
- **A pod on a node that has since been drained** is listed with its requests but carries no cost — there is no machine left to take the money from.
- **Labels are as of the collection.** A node relabelled at noon is recorded with whatever labels it had when the day's snapshot was taken.
- **Everything is still a snapshot.** The cluster has no history, so each daily collection appends one honest day. A volume deleted this morning simply stops appearing tomorrow.

## See also

- [Cost graphs & budgets](./cloud-costs.md)
- [Saved cost reports](./cost-reports.md)
- [Right-sizing](./right-sizing.md)
- [The Kubernetes plugin](../plugins/kubernetes.md)
- [Tag policy & showback](./tag-policy-and-showback.md)
