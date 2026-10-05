---
title: Kubernetes
description: Browse, edit, and run workloads against any kubeconfig-reachable cluster.
sidebar_order: 9
---

The Kubernetes plugin is the one other plugins pipe their secrets into — see [Secret export to Kubernetes](../features/secret-export-to-kubernetes.md).

## What you can manage

Namespaced resources (create / view / edit / delete):

- Pods
- Deployments
- StatefulSets
- DaemonSets
- Services
- Ingress
- ConfigMaps
- Secrets
- Jobs
- CronJobs

Cluster-scoped:

- Namespaces
- Nodes (read-only — capacity, allocatable, instance type, zone and region)

## Credentials

The form has two fields and both are plain text areas. Paste your cluster's kubeconfig YAML into **Kubeconfig**.

There is one optional second field, **Cluster hourly rates**, used only for cost allocation — see [Cost allocation](#cost-allocation) below. Leave it blank unless you are connecting a cluster that has no cloud account behind it in Infrawrench, or you want to price the parts of the cluster that are not node compute.

A third optional field, **GPU metrics source**, matters only on GPU clusters. Leave it blank and Infrawrench finds a Prometheus scraping NVIDIA's DCGM exporter on its own (or samples the exporter directly); set it to `namespace/service:port` to name one, or to `none` to turn GPU metrics off.

### Cloud accounts need inline credentials

In the web app (and for accounts synced to the cloud), the kubeconfig runs on Infrawrench's servers, so it must carry its credentials inline. Use one of:

- a bearer `token`
- `client-certificate-data` and `client-key-data`
- a `username` and `password`

The cluster's CA goes in `certificate-authority-data`. Anything that would make the server run a program or read a file is refused when you add the account, with an error naming the offending field: `exec` credential plugins (`gke-gcloud-auth-plugin`, `aws-iam-authenticator`, `kubelogin`, `aws eks get-token`), `auth-provider`, file paths (`tokenFile`, `client-certificate`, `client-key`, `certificate-authority`) and `proxy-url`. A service account token is the usual way to get a kubeconfig that qualifies.

The desktop app has no such restriction: there the kubeconfig runs on your own machine, so exec plugins and file paths work as they do with `kubectl`. A kubeconfig that uses them can still sync to the cloud, but the cluster only opens in the desktop app.

Clusters opened from their cloud account (below) are not affected. Infrawrench generates those kubeconfigs with a short-lived token already inlined, including for AKS clusters that use Microsoft Entra ID, where it mints the token for the Azure account's service principal instead of calling `kubelogin`. That service principal needs a Kubernetes RBAC role on the cluster.

### Clusters from a cloud account

For a cluster you already have in Infrawrench — EKS, AKS, GKE, DOKS, OVH Managed Kubernetes, Scaleway Kapsule, CoreWeave CKS — don't add an account here at all. Open the cluster resource and use its **Kubernetes** tab: the kubeconfig (and, where the provider reports them, the node prices) flow through from the cluster's own outputs as an [output reference](../core-concepts/output-references.md). There is no picker in this credential form.

![Kubernetes Add-account form with the Kubeconfig textarea and the optional Cluster hourly rates field](https://agent-assets.infrawrench.com/docs-screenshots/plugins/kubernetes/add-account.png)

### Kubeconfigs that run a command (desktop)

Some kubeconfigs authenticate by running a program on your computer: an `exec` entry such as `aws eks get-token`, `gke-gcloud-auth-plugin` or `kubelogin`, or a legacy `auth-provider`. The desktop app asks before it saves one, in a system dialog that shows the command. After that, connecting with the saved kubeconfig doesn't ask again.

A kubeconfig that isn't saved in an account, such as the one an AKS cluster with Microsoft Entra sign-in hands to its **Kubernetes** tab, gets the same dialog the first time you open a terminal, k9s, a port forward or the resource list in a session. If the dialog appears when you didn't just add or open a cluster, choose **Cancel**.

## Cost allocation

A cluster has no billing API — the money is charged to the cloud account that owns the nodes. So per-namespace and per-workload cost is **derived**: node capacity times each pod's share of it, plus the volumes and load balancers each workload owns.

The full explanation is on its own page: **[Kubernetes cost allocation](../features/kubernetes-costs.md)**. The short version:

- **Node prices** come from the parent cloud plugin when you open the cluster from its cloud account. DigitalOcean supplies the real node-pool price; AWS, Azure and GCP supply on-demand list prices (GCP per node pool, with attached GPUs priced separately); CoreWeave supplies your negotiated rates where you entered them on the CoreWeave account, otherwise its published on-demand prices; Scaleway and OVHcloud do not supply one yet. Otherwise fill in the **Cluster hourly rates** field (`s-2vcpu-4gb=0.0357, m5.large=0.096`).
- **Everything else the cluster costs is priced from the same field**, with reserved keys: `controlPlane=0.10` for the flat managed-cluster fee, `loadBalancer=0.0149` per provisioned `LoadBalancer` Service, and `storage/*=0.10` (or `storage/gp3=0.08`) per provisioned GiB-month. No cloud plugin supplies these automatically yet.
- **With no price at all, no number is invented.** You get capacity, volume sizes, load-balancer counts, requests and efficiency, and the pane explains what to do about it.
- **metrics-server is optional.** With it, a pod is charged the greater of its request and its actual usage, and you get efficiency figures. Without it, allocation falls back to requests alone and efficiency reads **unknown** — never 0%. A missing metrics-server never breaks the pane.
- **PersistentVolumeClaims** are charged to the workload that mounts them, or to the namespace when several do. A **bound claim nothing mounts** — the classic leftover from a scaled-down StatefulSet — gets its own waste bucket rather than a tenant's bill, and a claim that never bound is reported but never priced.
- **`LoadBalancer` Services** are charged to the workload behind their selector, or to the namespace when the selector is ambiguous. One that has not been provisioned yet is counted, not charged.
- **Idle capacity, the control-plane fee, system-reserved capacity and unattached volumes each get their own bucket**, never spread across namespaces — a cluster that is mostly idle is oversized, and burying that in per-team numbers hides it.
- **GPU nodes are split three ways.** The GPU share of the node's price is charged by GPU requests (`nvidia.com/gpu`, MIG profiles at their fraction of the card, time-sliced replicas at 1/replicas, AMD and other accelerators); unrequested GPUs get their own bucket; with DCGM or AMD exporter metrics, requested-but-idle GPUs are measured and whole-GPU workloads that fit a MIG profile are listed. See [GPUs](../features/kubernetes-costs.md#gpus).
- **Egress is not allocated.** The cluster API exposes no per-workload byte counters, so no apportionment is invented.
- **`kube-system` and the other control-plane namespaces are included**, even though the workload listings hide them. Their pods hold real capacity on the same nodes.

These are apportioned estimates, not billed amounts. Do not add a Kubernetes account's spend to its parent cloud account's spend.

![Namespace detail view with the "Cost by workload" table listing each Deployment with its pod count, requests, the Storage / LB column, efficiency and derived daily cost](https://agent-assets.infrawrench.com/docs-screenshots/plugins/kubernetes/namespace-cost-by-workload.png)

## Efficiency report

Clusters and namespaces have an **Efficiency** tab: requested vs used CPU and memory per namespace and per workload, the money the unused portion costs, worst offenders first, with a copyable plain-text rendering to paste into a ticket.

Workloads nothing measured read **unknown** rather than 0% and sort last. The report diagnoses rather than prescribing a request value — see [Right-sizing](../features/right-sizing.md) for why a Kubernetes recommendation is not folded into the VM Oversized list.

![Namespace Efficiency tab showing the summary, the by-workload table ordered by wasted cost, and the Share block with its copy button](https://agent-assets.infrawrench.com/docs-screenshots/plugins/kubernetes/namespace-efficiency.png)

## Notable flows

- **Manifest editor** — every resource type is editable as raw YAML in Monaco, applied with **Apply ⌘S**. See [Manifest editor](../features/manifest-editor.md).
- **Ephemeral scratch pods** — click **Launch scratch pod** on any namespace to get a throwaway debugging pod with a terminal, auto-deleted after 15 minutes (configurable up to 24 hours).
- **Terminal** into any pod (`kubectl exec` equivalent). Pick a container if there is more than one.
- **Log tail** on pods with follow and grep.
- **Secret import** from other plugins (drag a cloud resource onto a cluster).
- **Service picker on create** — when creating an Ingress (Backend Service) or a StatefulSet (Headless Service Name), pick an existing Service from a searchable dropdown instead of typing its name. The list is scoped to the namespace selected in the same form.
- **Cost and efficiency in the pane** — namespaces are ordered by cost, and every pod, deployment, statefulset and daemonset pill carries its derived daily cost and efficiency. Badly over-requested workloads are flagged amber, and the pane's banner calls out unattached volumes, never-bound claims and any component it could not price.

## Tips & limits

- Cluster connections use the kubeconfig’s context. If the kubeconfig has multiple contexts, pick one at add-time.
- Exec and port-forward in the web app proxy through our server. Long-running sessions are fine; heavily streaming ones (continuous log tail over days) may reconnect.
- RBAC applies — if the kubeconfig has limited permissions, some resource types will be hidden and some actions will fail. Cost allocation needs `list` on nodes and pods cluster-wide; without it the workload listing still renders, just without cost. Storage and load-balancer allocation additionally need `list` on `persistentvolumeclaims` and `services`, and each degrades on its own: a kubeconfig that may list pods but not PVCs still gets the complete compute allocation, with storage reported as unavailable rather than as zero.
- **Egress is not allocated**, and is not estimated. The Kubernetes API has no per-workload byte counters — `metrics.k8s.io` carries CPU and memory only — so a per-namespace network figure would have to be invented. It needs a flow-log source outside the cluster API.
- **Volume utilisation is not measured.** Storage is priced on provisioned size, which is what is billed; how full a disk actually is lives on the kubelet's Prometheus endpoint, not in the Kubernetes API.
- **PersistentVolumeClaims and load balancers are cost objects, not browsable resources.** They appear on the cluster's cost tables and its **Storage & load balancers** tab, not as sidebar entries with their own detail pages.
- There is no cost history to backfill — the Kubernetes API describes the present. Each daily collection appends one snapshot, so the series starts the day you connect the account.
