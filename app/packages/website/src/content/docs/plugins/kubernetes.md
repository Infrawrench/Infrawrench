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

Paste a kubeconfig YAML, or an output reference from an EKS / AKS / GKE / DOKS / Kapsule cluster resource.

There is one optional second field, **Node hourly rates**, used only for cost allocation — see [Cost allocation](#cost-allocation) below. Leave it blank unless you are connecting a cluster that has no cloud account behind it in Infrawrench.

<insert [Kubernetes Add-account form with kubeconfig textarea and output-ref picker] here>

## Cost allocation

A cluster has no billing API — the money is charged to the cloud account that owns the nodes. So per-namespace and per-workload cost is **derived**: node capacity, times what that node costs per hour, times each pod's share of it.

The full explanation is on its own page: **[Kubernetes cost allocation](../features/kubernetes-costs.md)**. The short version:

- **Node prices** come from the parent cloud plugin when you open the cluster from its cloud account. DigitalOcean supplies the real node-pool price; AWS and Azure supply on-demand list prices; GCP, Scaleway and OVHcloud do not supply one yet. Otherwise fill in the **Node hourly rates** field (`s-2vcpu-4gb=0.0357, m5.large=0.096`).
- **With no price at all, no number is invented.** You get capacity, requests and efficiency, and the pane explains what to do about it.
- **metrics-server is optional.** With it, a pod is charged the greater of its request and its actual usage, and you get efficiency figures. Without it, allocation falls back to requests alone and says so. A missing metrics-server never breaks the pane.
- **Idle capacity is reported as its own bucket**, never spread across namespaces — a cluster that is mostly idle is oversized, and burying that in per-team numbers hides it.
- **`kube-system` and the other control-plane namespaces are included**, even though the workload listings hide them. Their pods hold real capacity on the same nodes.

These are apportioned estimates, not billed amounts. Do not add a Kubernetes account's spend to its parent cloud account's spend.

<insert [Namespace detail view with the "Cost by workload" table listing each Deployment with its pod count, requests, efficiency and derived daily cost] here>

## Notable flows

- **Manifest editor** — every resource type is editable as raw YAML with schema-aware autocomplete. See [Manifest editor](../features/manifest-editor.md).
- **Ephemeral scratch pods** — click **Launch scratch pod** on any namespace to get a throwaway debugging pod with a terminal, auto-deleted after 15 minutes (configurable up to 24 hours).
- **Terminal** into any pod (`kubectl exec` equivalent). Pick a container if there is more than one.
- **Log tail** on pods with follow and grep.
- **Secret import** from other plugins (drag a cloud resource onto a cluster).
- **Service picker on create** — when creating an Ingress (Backend Service) or a StatefulSet (Headless Service Name), pick an existing Service from a searchable dropdown instead of typing its name. The list is scoped to the namespace selected in the same form.
- **Cost and efficiency in the pane** — namespaces are ordered by cost, and every pod, deployment, statefulset and daemonset pill carries its derived daily cost and efficiency. Badly over-requested workloads are flagged amber.

## Tips & limits

- Cluster connections use the kubeconfig’s context. If the kubeconfig has multiple contexts, pick one at add-time.
- Exec and port-forward in the web app proxy through our server. Long-running sessions are fine; heavily streaming ones (continuous log tail over days) may reconnect.
- RBAC applies — if the kubeconfig has limited permissions, some resource types will be hidden and some actions will fail. Cost allocation additionally needs `list` on nodes and pods cluster-wide; without it the workload listing still renders, just without cost.
- Cost figures cover **node compute only**. PersistentVolumes, `LoadBalancer` Services and egress cost real money and appear on the parent cloud account's bill, not in the allocation.
- There is no cost history to backfill — the Kubernetes API describes the present. Each daily collection appends one snapshot, so the series starts the day you connect the account.
