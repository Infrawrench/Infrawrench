---
title: "kubectl drain stuck on a PodDisruptionBudget: find the blocking budget and fix it safely"
description: "Fix a kubectl drain that keeps retrying evictions by finding the PodDisruptionBudget with zero allowed disruptions, checking for unready pods, single replicas and overlapping selectors, and choosing a safe way through."
date: "2026-11-06"
kind: guide
---

You run `kubectl drain` before node maintenance or an upgrade, and instead of finishing it keeps printing that it cannot evict a pod and will retry. The node is cordoned, most pods have gone, and one or two refuse to leave. Almost always a PodDisruptionBudget is doing exactly what it was written to do: refusing an eviction that would take an application below its budget. This guide shows how to find which budget is blocking, work out why it allows zero disruptions, and get the drain through without taking the application down by accident.

Prerequisites: kubectl installed, access to the cluster and permission to read and evict pods, read and edit PodDisruptionBudgets, and cordon and drain nodes. Everything here follows the official [Kubernetes documentation](https://kubernetes.io/docs/tasks/administer-cluster/safely-drain-node/). Placeholders used throughout: CONTEXT_NAME, NAMESPACE, NODE_NAME, POD_NAME, PDB_NAME and KEY=VALUE (a label from the budget selector). Replace them before running a command. For pods that are failing on their own rather than refusing to leave, start with the [Kubernetes troubleshooting guide for pods, logs and events](/blog/kubernetes-troubleshooting-pods-logs-and-events).

## How drain and PodDisruptionBudgets interact

`kubectl drain` marks the node unschedulable, then asks the API server to evict each pod on it through the Eviction API. Evictions respect PodDisruptionBudgets. The API server answers each eviction request in one of three ways:

- `200 OK`: the eviction is allowed and the pod is deleted, with its normal grace period.
- `429 Too Many Requests`: the eviction is not allowed right now because of a PodDisruptionBudget. It may be allowed later. You can also see 429 from API rate limiting.
- `500 Internal Server Error`: the eviction is not allowed because of a misconfiguration, for example several PodDisruptionBudgets selecting the same pod.

A pod that no PodDisruptionBudget covers is always allowed to go. So a drain that loops on one pod is getting 429 or 500 for it, and kubectl keeps retrying until the budget allows it or you stop the command. By default drain has no timeout and will wait forever.

A PodDisruptionBudget sets either `minAvailable` (pods that must still be available after the eviction) or `maxUnavailable` (pods that may be unavailable), never both. The disruption controller turns that into one number you can read: allowed disruptions. When it is 0, every eviction for that budget is refused.

## Step 1: Find the pods the drain is waiting on

Check you are pointed at the right cluster, then list what is still on the node:

```
kubectl config current-context
kubectl --context CONTEXT_NAME get pods --all-namespaces --field-selector spec.nodeName=NODE_NAME -o wide
```

Ignore DaemonSet pods: drain never evicts those, and needs `--ignore-daemonsets` to proceed at all. The pods named in drain's retry messages are the ones to follow. Note the namespace and name of each.

## Step 2: Find the PodDisruptionBudget that covers the pod

List the budgets in the pod's namespace:

```
kubectl --context CONTEXT_NAME -n NAMESPACE get poddisruptionbudgets
```

The output looks like this:

```
NAME     MIN AVAILABLE   MAX UNAVAILABLE   ALLOWED DISRUPTIONS   AGE
zk-pdb   2               N/A               0                     7d
```

A budget only covers the pod if its selector matches the pod's labels. Compare them:

```
kubectl --context CONTEXT_NAME -n NAMESPACE get pod POD_NAME --show-labels
kubectl --context CONTEXT_NAME -n NAMESPACE get poddisruptionbudget PDB_NAME -o jsonpath='{.spec.selector}{"\n"}'
```

An empty selector `{}` matches every pod in the namespace, which is easy to miss. If two budgets match the same pod, that is your answer: the Eviction API refuses to evict any pod covered by more than one budget, and returns 500 rather than 429. Remove the overlap so each pod has one budget.

## Step 3: Read why allowed disruptions is 0

Read the budget's status:

```
kubectl --context CONTEXT_NAME -n NAMESPACE get poddisruptionbudget PDB_NAME -o yaml
```

Look at the `status` block:

```
status:
  currentHealthy: 2
  desiredHealthy: 2
  disruptionsAllowed: 0
  expectedPods: 2
```

`currentHealthy` is how many selected pods count as healthy right now, meaning their `Ready` condition is `True`. `desiredHealthy` is the minimum the budget requires. Evictions are allowed only while removing one more pod would keep `currentHealthy` at or above `desiredHealthy`. Compare the two numbers and you are in one of the cases below.

## Step 4: Match the cause

**The budget can never allow a disruption.** If `minAvailable` equals the number of replicas, or `maxUnavailable` is 0, then `disruptionsAllowed` stays at 0 even when every pod is healthy. A Deployment with one replica and `minAvailable: 1` is the most common version of this. Sometimes it is deliberate: the Kubernetes docs describe `maxUnavailable: 0` as a way for an application owner to block all voluntary evictions until they are ready for downtime, then delete the budget and recreate it afterwards. If that is your situation, talk to whoever owns the application before you go further.

**Some pods are not Ready.** If `currentHealthy` is below `expectedPods`, part of the application is already down, so the budget has no room left. Find the pods that are not Ready:

```
kubectl --context CONTEXT_NAME -n NAMESPACE get pods -l KEY=VALUE
```

Use the budget's selector for `-l`. Pods in CrashLoopBackOff, or Running but showing 0/1 ready, are the usual culprits. Fix those first with the [CrashLoopBackOff guide](/blog/kubernetes-crashloopbackoff) or the [readiness probe guide](/blog/kubernetes-readiness-probe-failed). Once enough pods are healthy again, the drain continues on its own.

**Replacement pods cannot start anywhere.** Each pod drain evicts needs a new home. If the replacement sits in Pending because the remaining nodes are full or do not match its affinity or taints, the application never recovers its healthy count and the next eviction stays blocked. Check for Pending pods with the budget's selector and follow the [Pod Pending guide](/blog/kubernetes-pod-pending). Adding capacity before a drain avoids this.

**A previous eviction has not finished.** A pod that was just evicted keeps running until its grace period ends, and the budget does not regain room until its replacement is Ready. The docs note that stuck evictions can happen when the last evicted pod had a long termination grace period. If an old pod is sitting in Terminating, the [pod stuck in Terminating guide](/blog/kubernetes-pod-stuck-terminating) explains what is holding it.

**Several drains at once.** You can drain several nodes in parallel and each drain still respects the budgets. With 3 replicas and `minAvailable: 2`, only one pod can be unavailable at a time across all of them, so parallel drains take turns. That is slow but correct.

## Step 5: Let unhealthy pods be evicted with AlwaysAllow

By default a budget uses the `IfHealthyBudget` policy: a Running pod that is not yet Ready can only be evicted if the application is not already disrupted. The docs point out the cost of this. An application with pods stuck in CrashLoopBackOff, or pods that never report Ready, blocks node drains, because those broken pods are protected too.

Setting `unhealthyPodEvictionPolicy: AlwaysAllow` lets drain evict Running pods that are not Ready regardless of the budget, while healthy pods stay protected. The [safely drain a node](https://kubernetes.io/docs/tasks/administer-cluster/safely-drain-node/) page recommends it:

```
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: PDB_NAME
spec:
  minAvailable: 2
  unhealthyPodEvictionPolicy: AlwaysAllow
  selector:
    matchLabels:
      app: zookeeper
```

Or patch an existing budget:

```
kubectl --context CONTEXT_NAME -n NAMESPACE patch poddisruptionbudget PDB_NAME --type=merge -p '{"spec":{"unhealthyPodEvictionPolicy":"AlwaysAllow"}}'
```

The trade-off: pods of an application that is trying to recover might be evicted before they get the chance to become healthy. Pods in Pending, Succeeded or Failed phase can always be evicted whatever the policy.

## Step 6: Fix a budget that is set too tight

If the budget can never allow a disruption, change it so it allows at least one while keeping the application safe. Pick the field that matches the workload:

- For stateless services, the docs suggest a percentage such as `minAvailable: 90%`. Percentages round up.
- For quorum systems such as etcd, ZooKeeper or Consul, `maxUnavailable: 1` works at any scale, or `minAvailable` set to the quorum size, for example 3 when there are 5 replicas.
- For a single replica, no budget lets you evict it without downtime. Either run more replicas, or accept a short outage during maintenance.

Two restrictions apply when the pods are bare or managed by something other than a Deployment, ReplicaSet, StatefulSet, ReplicationController or a custom resource with a `scale` subresource: you can only use `minAvailable`, and only as a whole number, not a percentage. Restartable batch Jobs do not need a budget at all, because the Job controller creates a replacement pod.

If the budget belongs to a Helm chart or an operator, change it there, or your edit is reverted on the next sync.

## Step 7: Bypass the budget only on purpose

There are two ways around a budget. Both skip the protection it gives, so use them only when you have decided the application can take the disruption.

Delete the pod directly. The Eviction API docs list this as one way out of a stuck eviction, after waiting a while and investigating the application first:

```
kubectl --context CONTEXT_NAME -n NAMESPACE delete pod POD_NAME
```

A direct delete does not check budgets. The drain then sees the pod gone and moves on.

Or make drain itself use delete instead of eviction:

```
kubectl --context CONTEXT_NAME drain NODE_NAME --ignore-daemonsets --disable-eviction
```

The kubectl reference describes `--disable-eviction` as bypassing PodDisruptionBudget checks and says to use it with caution. It applies to every pod on the node, not just the one you looked at.

Do not confuse it with `--force`. That flag lets drain continue when pods have no controller, and those pods are deleted for good. It does nothing about budgets.

## Step 8: Verify

Run the drain again with a timeout so it cannot hang silently:

```
kubectl --context CONTEXT_NAME drain NODE_NAME --ignore-daemonsets --timeout=10m
```

Add `--delete-emptydir-data` only if you accept that data in emptyDir volumes on the node is lost. When drain returns without an error, every pod except DaemonSet and mirror pods has gone. Check that the application is back at full strength:

```
kubectl --context CONTEXT_NAME -n NAMESPACE get poddisruptionbudget PDB_NAME
```

Allowed disruptions should be back above 0 once all replacement pods are Ready. After maintenance, if the node stays in the cluster, make it schedulable again:

```
kubectl --context CONTEXT_NAME uncordon NODE_NAME
```

## Conclusion

A drain that keeps retrying is usually a PodDisruptionBudget with zero allowed disruptions. Find the budget that selects the pod, read `currentHealthy` against `desiredHealthy`, and fix the cause: unready pods, replacements with nowhere to run, overlapping selectors, or a budget that could never allow a disruption. Set `AlwaysAllow` so broken pods stop blocking maintenance, and bypass a budget only when you have decided the downtime is acceptable.

If you move between clusters, cloud consoles and terminals during node maintenance, Infrawrench brings Kubernetes exec and logs, SSH and the rest of your infrastructure into one workspace. [Download the free desktop app](/) for macOS, Windows or Linux, no account required.

## References

- [Safely drain a node](https://kubernetes.io/docs/tasks/administer-cluster/safely-drain-node/)
- [Specifying a disruption budget for your application](https://kubernetes.io/docs/tasks/run-application/configure-pdb/)
- [API-initiated eviction](https://kubernetes.io/docs/concepts/scheduling-eviction/api-eviction/)
- [Disruptions](https://kubernetes.io/docs/concepts/workloads/pods/disruptions/)
- [kubectl drain reference](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_drain/)
