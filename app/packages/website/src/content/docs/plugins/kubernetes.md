---
title: Kubernetes
description: Browse, edit, and run workloads against any kubeconfig-reachable cluster.
sidebar_order: 9
---

Connect a Kubernetes cluster to browse and edit its workloads, open terminals and logs, and see what each namespace and workload costs. Other plugins can also send their secrets into your cluster, see [Secret export to Kubernetes](../features/secret-export-to-kubernetes.md).

## What you can manage

Namespaced resources (create, view, edit, delete):

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
- Nodes (read-only: capacity, allocatable, instance type, zone and region)

## Connect your account

Paste your cluster's kubeconfig YAML into **Kubeconfig**. The other fields are optional:

- **Cluster hourly rates** is only used for cost allocation (see [Cost allocation](#cost-allocation) below). Leave it blank unless the cluster has no cloud account behind it in Infrawrench, or you want to price the parts of the cluster that aren't node compute.
- **GPU metrics source** only matters on GPU clusters. Leave it blank and Infrawrench finds a Prometheus scraping NVIDIA's DCGM exporter by itself (or reads the exporter directly). Set it to `namespace/service:port` to name one, or to `none` to turn GPU metrics off.

If the kubeconfig has more than one context, pick one when you add it.

### Web app: credentials must be inline

In the web app (and for accounts synced to the cloud), the kubeconfig is used on Infrawrench's servers, so it must include its credentials directly. Use one of:

- a bearer `token`
- `client-certificate-data` and `client-key-data`
- a `username` and `password`

Put the cluster's CA in `certificate-authority-data`. Anything that would make the server run a program or read a file is refused when you add the account, with an error naming the field: `exec` credential plugins (`gke-gcloud-auth-plugin`, `aws-iam-authenticator`, `kubelogin`, `aws eks get-token`), `auth-provider`, file paths (`tokenFile`, `client-certificate`, `client-key`, `certificate-authority`) and `proxy-url`. A service account token is the usual way to get a kubeconfig that works.

The desktop app has no such restriction. There the kubeconfig is used on your own machine, so exec plugins and file paths work just like they do with `kubectl`. A kubeconfig that uses them can still sync to the cloud, but the cluster only opens in the desktop app.

Clusters you open from their cloud account (below) aren't affected. Infrawrench creates those kubeconfigs with a short-lived token already included. That also covers AKS clusters that use Microsoft Entra ID, where the token comes from the Azure account's service principal. That service principal needs a Kubernetes RBAC role on the cluster.

### Clusters from a cloud account

If the cluster is already in Infrawrench through EKS, AKS, GKE, DOKS, OVH Managed Kubernetes, Scaleway Kapsule or CoreWeave CKS, don't add an account here. Open the cluster resource and use its **Kubernetes** tab. The kubeconfig (and node prices, where the provider reports them) come from the cluster itself as an [output reference](../core-concepts/output-references.md).

![Kubernetes Add-account form with the Kubeconfig textarea and the optional Cluster hourly rates field](https://agent-assets.infrawrench.com/docs-screenshots/plugins/kubernetes/add-account.png)

### Kubeconfigs that run a command (desktop)

Some kubeconfigs sign in by running a program on your computer: an `exec` entry such as `aws eks get-token`, `gke-gcloud-auth-plugin` or `kubelogin`, or a legacy `auth-provider`. The desktop app asks before saving one, in a system dialog that shows the command. After that, it doesn't ask again for the saved kubeconfig.

A kubeconfig that isn't saved in an account, like the one an AKS cluster with Microsoft Entra sign-in uses on its **Kubernetes** tab, shows the same dialog the first time you open a terminal, k9s, a port forward or the resource list in a session. If the dialog appears when you didn't just add or open a cluster, choose **Cancel**.

## Cost allocation

A cluster has no bill of its own: the cloud account that owns the nodes is charged. So per-namespace and per-workload cost is **worked out** from node capacity and each pod's share of it, plus the volumes and load balancers each workload owns.

The full explanation is on **[Kubernetes cost allocation](../features/kubernetes-costs.md)**. The short version:

- **Node prices** come from the cloud account when you open the cluster from there. DigitalOcean gives the real node-pool price. Akamai (Linode) gives the real node-plan price for LKE, plus the control-plane, NodeBalancer and Block Storage prices. AWS, Azure and GCP give on-demand list prices (GCP per node pool, with attached GPUs priced separately). CoreWeave gives your negotiated rates if you entered them on the CoreWeave account, otherwise its published on-demand prices. Scaleway and OVHcloud don't give one yet. Otherwise fill in the **Cluster hourly rates** field (`s-2vcpu-4gb=0.0357, m5.large=0.096`).
- **Everything else the cluster costs is priced from the same field**, using reserved keys: `controlPlane=0.10` for the flat managed-cluster fee, `loadBalancer=0.0149` per provisioned `LoadBalancer` Service, and `storage/*=0.10` (or `storage/gp3=0.08`) per provisioned GiB-month. No cloud account fills these in automatically yet.
- **With no price at all, no number is made up.** You still get capacity, volume sizes, load-balancer counts, requests and efficiency, and the pane tells you what to do.
- **metrics-server is optional.** With it, a pod is charged the greater of its request and its actual usage, and you get efficiency figures. Without it, cost is based on requests alone and efficiency reads **unknown**, never 0%.
- **PersistentVolumeClaims** are charged to the workload that mounts them, or to the namespace when several do. A **bound claim nothing mounts** (often left over from a scaled-down StatefulSet) gets its own waste bucket instead of landing on a team's bill. A claim that never bound is reported but not priced.
- **`LoadBalancer` Services** are charged to the workload behind their selector, or to the namespace when that's unclear. One that hasn't been provisioned yet is counted, not charged.
- **Idle capacity, the control-plane fee, system-reserved capacity and unattached volumes each get their own bucket**, never spread across namespaces, so an oversized cluster stays visible.
- **GPU nodes are split three ways.** The GPU share of the node's price is charged by GPU requests (`nvidia.com/gpu`, MIG profiles at their fraction of the card, time-sliced replicas at 1/replicas, AMD and other accelerators). Unrequested GPUs get their own bucket. With DCGM or AMD exporter metrics, requested but idle GPUs are measured, and whole-GPU workloads that would fit a MIG profile are listed. See [GPUs](../features/kubernetes-costs.md#gpus).
- **Network costs by traffic class.** Pod traffic comes from the kubelet's per-pod counters, Cilium Hubble, or the cloud's VPC flow logs for the nodes, and is split into same-zone, cross-zone, cross-region and internet. See [Kubernetes network costs](../features/kubernetes-costs.md#network-costs).
- **`kube-system` and the other control-plane namespaces are included**, even though the workload lists hide them, because their pods use real capacity.

These are estimates, not billed amounts. Don't add a Kubernetes account's spend to its cloud account's spend.

![Namespace detail view with the "Cost by workload" table listing each Deployment with its pod count, requests, the Storage / LB column, efficiency and derived daily cost](https://agent-assets.infrawrench.com/docs-screenshots/plugins/kubernetes/namespace-cost-by-workload.png)

## Check efficiency

Clusters and namespaces have an **Efficiency** tab. It shows requested vs used CPU and memory per namespace and per workload, and what the unused part costs, worst first. You can copy it as plain text to paste into a ticket.

Workloads with no measurements read **unknown** instead of 0% and sort last. The report shows the problem but doesn't suggest a request value. See [Right-sizing](../features/right-sizing.md) for more.

![Namespace Efficiency tab showing the summary, the by-workload table ordered by wasted cost, and the Share block with its copy button](https://agent-assets.infrawrench.com/docs-screenshots/plugins/kubernetes/namespace-efficiency.png)

## What you can do

- **Manifest editor**: edit any resource as raw YAML and apply it with **Apply ⌘S**. See [Manifest editor](../features/manifest-editor.md).
- **Scratch pods**: click **Launch scratch pod** on any namespace for a throwaway debugging pod with a terminal. It's deleted after 15 minutes (you can set up to 24 hours).
- **Terminal** into any pod (like `kubectl exec`). Pick a container if there's more than one.
- **Log tail** on pods, with follow and grep.
- **Secret import** from other plugins (drag a cloud resource onto a cluster).
- **Service picker on create**: when you create an Ingress (Backend Service) or a StatefulSet (Headless Service Name), pick an existing Service from a searchable list instead of typing its name. The list only shows Services in the namespace you picked.
- **Cost and efficiency in the pane**: namespaces are sorted by cost, and every pod, deployment, statefulset and daemonset shows its daily cost and efficiency. Badly over-requested workloads are flagged amber, and a banner calls out unattached volumes, claims that never bound and anything that couldn't be priced.

## Just-in-time access

[Just-in-time access](../features/just-in-time-access.md) on Kubernetes creates one **RoleBinding** in the chosen namespace (or a **ClusterRoleBinding** when the scope is the whole cluster) per grant. It's named `iw-jit-…` after the request and labelled `app.kubernetes.io/managed-by: infrawrench`, with the expiry as an annotation. Ending the grant deletes that binding and nothing else, so access from other bindings is never touched.

The role picker offers the cluster's ClusterRoles (except the `system:` ones) and the namespace's own Roles. Kubernetes has no user directory, so the subject is the user name your cluster's authenticator assigns, which is the email address on most managed clusters with OIDC. If yours is different, requesters pick themselves from the users and groups already named in the cluster's bindings.

The kubeconfig needs permission to create, get and delete RoleBindings and ClusterRoleBindings, to list namespaces, ClusterRoles and Roles, and `bind` on the roles offered (or to already hold them).

## Troubleshooting a cluster

When a workload misbehaves, start with the pod's status, its logs and the namespace's events. The [Kubernetes troubleshooting guide for pods, logs and events](https://infrawrench.com/blog/kubernetes-troubleshooting-pods-logs-and-events) walks through that routine and links a guide for each symptom. The most common ones:

- [CrashLoopBackOff](https://infrawrench.com/blog/kubernetes-crashloopbackoff)
- [ImagePullBackOff](https://infrawrench.com/blog/kubernetes-imagepullbackoff)
- [OOMKilled](https://infrawrench.com/blog/kubernetes-oomkilled)
- [Pod stuck in Pending](https://infrawrench.com/blog/kubernetes-pod-pending)
- [Service has no endpoints](https://infrawrench.com/blog/kubernetes-service-no-endpoints)
- [kubectl can't connect to the server](https://infrawrench.com/blog/kubectl-unable-to-connect-to-the-server)

## CI jobs

A cluster can run [cloud jobs](../features/ci.md#cloud-jobs) of kind `cluster`: each job is a Kubernetes Job in a namespace, removed when the job ends.

```yaml
jobs:
  integration:
    cloud: { provider: kubernetes, kind: cluster, region: ci, machine: 4vcpu-8gb }
    run: make integration
```

- `region` is the namespace (default: the kubeconfig context's namespace, or `default`). It has to exist.
- `machine` is CPUs and memory, like `2vcpu-4gb` (the default) or `0.5vcpu-1gb`; the pod requests and is limited to that.
- `image` is any image with a POSIX shell (default `buildpack-deps:noble-curl`). Images without `bash` or `curl` get them installed with their package manager when the job starts.
- `gpu: nvidia:1` asks for `nvidia.com/gpu`; `amd:1` for `amd.com/gpu`; a full resource name such as `example.com/tpu:4` is used as written.
- The pod gets no service account token and no service links, so the job cannot use the cluster's API with the connection's credentials. To deploy from a job, lend the connection with `connections:` instead.
- The Job has `activeDeadlineSeconds` set to the job's time limit and is deleted with its pods when the job ends; a finished Job the cluster still has is removed after ten minutes.
- The connection needs `create`, `get`, `list` and `delete` on `jobs.batch` in the namespace. **Check permissions** names any that are missing.

A CoreWeave CKS, EKS, GKE, AKS or DOKS cluster runs jobs the same way once it's connected as a Kubernetes connection with its kubeconfig.

## Tips and limits

- In the web app, terminals and port forwards go through Infrawrench's servers. Long sessions are fine, but heavy streaming over days (a continuous log tail, say) may reconnect.
- RBAC applies. If the kubeconfig has limited permissions, some resource types are hidden and some actions fail. Cost allocation needs `list` on nodes and pods cluster-wide. Without it the workload list still works, just without cost. Storage and load-balancer costs also need `list` on `persistentvolumeclaims` and `services`. Each works on its own, so a kubeconfig that can list pods but not PVCs still gets full compute costs, with storage shown as unavailable, not zero.
- **Network costs need `get` on `nodes/proxy`** or the cloud account's VPC flow logs. Without either, the cluster shows no network figures and says why. Nothing else is affected.
- **How full a volume is isn't measured.** Storage is priced on provisioned size, which is what you're billed for.
- **PersistentVolumeClaims and load balancers show up in cost, not the sidebar.** You'll find them in the cluster's cost tables and its **Storage & load balancers** tab, not as entries with their own detail pages.
- Cost history starts the day you connect the account. There's one snapshot per day and nothing earlier.
