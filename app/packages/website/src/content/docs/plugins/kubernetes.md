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

## Credentials

Paste a kubeconfig YAML, or an output reference from an EKS / AKS / GKE / DOKS / Kapsule cluster resource.

![Kubernetes Add-account form with kubeconfig textarea and output-ref picker](https://agent-assets.infrawrench.com/docs/screenshots/plugins/kubernetes-add-account.png)

## Notable flows

- **Manifest editor** — every resource type is editable as raw YAML with schema-aware autocomplete. See [Manifest editor](../features/manifest-editor.md).
- **Ephemeral scratch pods** — click **Launch scratch pod** on any namespace to get a throwaway debugging pod with a terminal, auto-deleted after 15 minutes (configurable up to 24 hours).
- **Terminal** into any pod (`kubectl exec` equivalent). Pick a container if there is more than one.
- **Log tail** on pods with follow and grep.
- **Secret import** from other plugins (drag a cloud resource onto a cluster).
- **Service picker on create** — when creating an Ingress (Backend Service) or a StatefulSet (Headless Service Name), pick an existing Service from a searchable dropdown instead of typing its name. The list is scoped to the namespace selected in the same form.

## Tips & limits

- Cluster connections use the kubeconfig’s context. If the kubeconfig has multiple contexts, pick one at add-time.
- Exec and port-forward in the web app proxy through our server. Long-running sessions are fine; heavily streaming ones (continuous log tail over days) may reconnect.
- RBAC applies — if the kubeconfig has limited permissions, some resource types will be hidden and some actions will fail.
