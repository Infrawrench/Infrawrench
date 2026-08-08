---
title: Kubernetes cost allocation
description: Work out what each namespace, workload, and pod in a cluster actually costs — including the idle capacity nobody is using.
sidebar_order: 3
---

A Kubernetes cluster has no billing API. Nothing inside it knows what it costs, because the money is not charged to the cluster — it is charged to the **cloud account that owns the nodes**, as a pile of virtual machines.

So Infrawrench derives it. Node capacity, times what that node costs per hour, times each pod's share of it, rolled up by workload and namespace. The result appears wherever the cluster already appears: in the Kubernetes pane on your DOKS/GKE/EKS/AKS/Kapsule/Managed Kubernetes cluster, on the resource cards, on the detail views, and on the cluster's own **Metrics** tab.

> **These are derived allocations, not billed amounts.** Nobody invoices you per namespace. Everything on this page is the node bill, re-cut. Do not add a Kubernetes account's numbers to its parent cloud account's numbers — that double-counts the same money.

<insert [Kubernetes peer pane on a DOKS cluster showing the Namespaces group ordered by cost, each pill's subtitle reading "Active · ~$4.20/day · 18% CPU"] here>

## What it needs

| Input                     | Where it comes from                                    | Without it                                                     |
| ------------------------- | ------------------------------------------------------ | -------------------------------------------------------------- |
| Node capacity and pod requests | The Kubernetes API. Always available.             | Nothing works; this is the baseline.                            |
| A per-node hourly price   | The parent cloud plugin, or the optional field on the account. | Capacity and requests are still shown — the money is omitted.   |
| Live CPU/memory usage     | `metrics.k8s.io`, served by metrics-server.            | Allocation falls back to requests alone. Efficiency is hidden.  |

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

| Provider     | What it supplies                                                         | Quality       |
| ------------ | ------------------------------------------------------------------------ | ------------- |
| DigitalOcean | The published hourly price of each node pool's Droplet size — which is what DOKS worker nodes are actually billed at. | Real price    |
| AWS          | On-demand hourly price of the managed node groups' instance types.        | List price    |
| Azure        | Retail pay-as-you-go hourly price of the cluster's node VM size.          | List price    |
| GCP          | Not yet — see [Limitations](#limitations).                                | None          |
| Scaleway     | Not yet.                                                                  | None          |
| OVHcloud     | Not yet.                                                                  | None          |

List prices are exactly that: Savings Plans, Reserved Instances, committed-use discounts and Spot all move the real number, usually downward. The pane says which kind of price it used.

**2. Rates you supply.** A standalone Kubernetes account — one you added by pasting a kubeconfig, with no cloud account behind it — has an optional **Node hourly rates** field. List instance types and their hourly cost:

```
s-2vcpu-4gb=0.0357, m5.large=0.096
```

The instance type is matched against each node's `node.kubernetes.io/instance-type` label.

**If neither is available, no price is invented.** You get capacity, requests, and (with metrics-server) efficiency, and the pane explains what to do about the missing money. A fabricated number is worse than no number, because it gets believed.

<insert [Kubernetes peer pane showing the amber "Showing capacity and efficiency without cost" banner above the workload groups, with the three suggestions listed] here>

## How attribution works

### The node's price is split between CPU and memory

A node is one price for two resources, so the price has to be divided before a pod's share of it means anything. Infrawrench splits it **65% CPU / 35% memory**.

That is not a round number picked for tidiness. Cloud providers that publish *component* pricing charge separately per vCPU-hour and per GiB-hour, and a general-purpose instance's price is the sum. Taking those published rates for the mainstream general-purpose families — which run at roughly 4 GiB of RAM per vCPU — the CPU term is consistently a little under two thirds of the machine price. GCP's N2 family in `us-central1`, for instance, prices vCPUs at $0.031611/hour and RAM at $0.004237/GiB-hour; for an `n2-standard-4` that is $0.126 of CPU against $0.068 of RAM, a 65% CPU share.

The split only moves money *between* tenants sharing a node. It never changes the cluster total, the idle bucket, or any efficiency figure — so a few points of error is not load-bearing.

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

Neither is spread across the namespaces. Doing that would overcharge every tenant *and* hide the actual finding, which is that you are paying for a cluster larger than what you run on it. A cluster where half the money is in the idle row is telling you something specific, and it is not "the `payments` namespace is expensive".

<insert [Cluster detail view showing the "Cost by namespace" table with per-namespace rows and the distinct "(idle · unallocated capacity)" and "(system reserved · kubelet)" rows at the bottom] here>

### Efficiency is used ÷ requested

Reported per workload for CPU and memory. A workload using under 20% of what it reserved on **both** dimensions is flagged as over-requested — its pill turns amber and its efficiency stat goes degraded.

Both dimensions have to be low. A workload using 5% of its CPU but 90% of its memory is correctly sized for memory, and shrinking it would break it.

Efficiency only appears when metrics-server does. Requests alone say nothing about waste.

## System namespaces are included

The workload listings hide `kube-system`, `kube-public`, and the provider-managed namespaces, because someone browsing their own workloads does not want to wade through them.

**Cost allocation deliberately does not inherit that.** Those pods sit on the same nodes and hold real capacity. Dropping them would make their spend vanish and make every other namespace look proportionally larger than it is. They appear in the tables and in the cost rows, tagged `system=true` so you can filter them out yourself if you want to.

## Where it shows up

- **The Kubernetes pane** on your cloud cluster resource — a Namespaces group ordered by cost, and per-item cost and efficiency appended to every pod, deployment, statefulset, daemonset and namespace pill.
- **Resource cards** — cost/day and efficiency stats for clusters, namespaces, pods, deployments, statefulsets and daemonsets. The cluster card also carries an **Idle** stat with its percentage.
- **Detail views** — a **Cost by namespace** table on the cluster (including the idle rows) and a **Cost by workload** table on each namespace.
- **Metrics tabs** — cost and efficiency as time series.
- **The cloud cluster's own Metrics tab** — the same cluster-level series are merged in next to the provider's node metrics, so cluster spend sits beside cluster CPU rather than one tab deeper.
- **[Cost graphs and budgets](./cloud-costs.md)** — the allocation is written as daily cost rows, so it charts and budgets like any other spend.

<insert [DOKS cluster Metrics tab showing the provider's node CPU series alongside the merged "Cluster cost", "Allocated to workloads" and "Idle capacity" series] here>

## In cost graphs

Kubernetes accounts collect a daily snapshot into the same store every other provider writes to, so the allocation is available to graphs, filters, budgets, and the `infrawrench costs` CLI.

The dimensions it reports:

| Dimension            | Values                                                                          |
| -------------------- | ------------------------------------------------------------------------------- |
| Service              | `kubernetes-workload`, `kubernetes-idle`, `kubernetes-system-reserved`           |
| Resource             | The workload identity, `namespace/Kind/name`                                     |
| Tag `namespace`      | The Kubernetes namespace                                                         |
| Tag `workload`       | The owning Deployment / StatefulSet / DaemonSet / Job name                        |
| Tag `workload_kind`  | That owner's kind                                                                |
| Tag `system`         | `true` for the control-plane namespaces                                          |

Group by the `namespace` tag for a per-team view; filter `service is not kubernetes-idle` to see only what workloads hold.

**There is no history to backfill.** The Kubernetes API describes what is running right now, not what ran last Tuesday. Each daily collection appends one honest snapshot, and the series builds up from the day you connect the account. Unlike a provider that can restate a week of invoices, there is nothing here to restate.

## Limitations

- **GCP, Scaleway and OVHcloud supply no node price yet.** GKE clusters show capacity and efficiency without money unless you fill in the rates field yourself. GCP's Cloud Billing SKUs price vCPU-hours and GiB-hours separately rather than per machine type, so producing a per-node rate needs a machine-type → (vCPU, GiB) lookup that is not built yet.
- **AWS and Azure prices are list prices.** Commitments and Spot are not reflected, so a heavily-committed cluster will read high.
- **Storage, load balancers, and egress are not allocated.** Only node compute is. A PersistentVolume or a `LoadBalancer` Service costs real money and appears on the parent cloud account's bill, not in this allocation.
- **The control plane is not included** where a provider charges for it separately (EKS, and AKS on the paid tiers). That charge is on the cloud account.
- **A pod on a node that has since been drained** is listed with its requests but carries no cost — there is no machine left to take the money from.

## See also

- [Cost graphs & budgets](./cloud-costs.md)
- [The Kubernetes plugin](../plugins/kubernetes.md)
- [Tag policy & showback](./tag-policy-and-showback.md)
