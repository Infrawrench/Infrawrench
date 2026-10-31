---
title: "Kubernetes evicted pods: find out who evicted them and stop it"
description: "Find out why Kubernetes evicted a pod: node pressure, the Eviction API, a NoExecute taint or a storage limit. Then fix requests, priority or disk use, and clean up."
date: "2026-10-31"
kind: guide
---

An evicted pod was stopped on purpose. Something decided the pod had to leave its node: the kubelet protecting a node that was running out of memory or disk, a drain calling the Eviction API, or the control plane reacting to a taint. The pod is not restarted in place. If a Deployment, StatefulSet or other controller owns it, a replacement is created, and the evicted one is left behind as a Failed pod. This guide shows how to find evicted pods, work out which kind of eviction happened, fix the cause, and clean up what is left.

Prerequisites: kubectl installed, access to the cluster, and permission to read pods, events and nodes. Everything here follows the official [Kubernetes documentation](https://kubernetes.io/docs/concepts/scheduling-eviction/node-pressure-eviction/). Placeholders used throughout: CONTEXT_NAME, NAMESPACE, POD_NAME, NODE_NAME and DEPLOYMENT_NAME. Replace them before running a command. If you are new to the overall routine, start with the [Kubernetes troubleshooting guide for pods, logs and events](/blog/kubernetes-troubleshooting-pods-logs-and-events).

## Eviction is not OOMKilled

The two are easy to confuse, because both often come down to memory. An [OOMKilled](/blog/kubernetes-oomkilled) container was killed by the kernel when it hit its memory limit or the node ran out, and the kubelet can restart that container according to the pod's `restartPolicy`. An evicted pod was stopped as a whole by Kubernetes, its phase is set to Failed, and it is never restarted. Only its controller can replace it, with a new pod.

Kubernetes has several kinds of eviction, and each one has a different cause and fix:

- **Node-pressure eviction.** The kubelet stops pods because the node is short of memory, disk, inodes or process IDs.
- **API-initiated eviction.** Something asked the API server to evict the pod, usually `kubectl drain` or a tool that removes nodes.
- **Taint-based eviction.** The node got a NoExecute taint the pod does not tolerate, for example because it went [NotReady](/blog/kubernetes-node-not-ready).
- **Ephemeral storage limits.** The pod wrote more to local disk than its own limit allows.

## Step 1: Find the evicted pods

Check you are pointed at the right cluster, then list Failed pods in the namespace:

```
kubectl config current-context
kubectl --context CONTEXT_NAME get pods -n NAMESPACE --field-selector=status.phase=Failed -o wide
```

Pods evicted by the kubelet usually show Evicted in the STATUS column, and the NODE column tells you where it happened. Several evicted pods on the same node point at that node. Evicted pods spread across many nodes point at the workload itself, or at a cluster-wide event like a node pool upgrade.

To see every Failed pod across the cluster with the node it ran on:

```
kubectl --context CONTEXT_NAME get pods -A --field-selector=status.phase=Failed -o custom-columns=NAMESPACE:.metadata.namespace,NAME:.metadata.name,NODE:.spec.nodeName,REASON:.status.reason
```

## Step 2: Read why it was evicted

Describe one of the evicted pods:

```
kubectl --context CONTEXT_NAME describe pod POD_NAME -n NAMESPACE
```

Near the top, the Status, Reason and Message fields tell you what happened. For a node-pressure eviction, the message usually names the resource the node was short of, such as memory or ephemeral storage, and which containers were using the most of it.

Then check the pod's conditions. On current Kubernetes versions, a pod about to be deleted because of a disruption gets a `DisruptionTarget` condition whose reason names who did it:

```
kubectl --context CONTEXT_NAME get pod POD_NAME -n NAMESPACE -o jsonpath='{range .status.conditions[?(@.type=="DisruptionTarget")]}{.reason}{"\t"}{.message}{"\n"}{end}'
```

- **TerminationByKubelet**: the kubelet stopped it, because of node-pressure eviction, a graceful node shutdown, or to make room for a system critical pod. Go to Step 3.
- **EvictionByEvictionAPI**: something called the Eviction API. Go to Step 5.
- **DeletionByTaintManager**: a NoExecute taint the pod did not tolerate. Go to Step 6.
- **PreemptionByScheduler**: the scheduler removed it to make room for a higher priority pod.
- **DeletionByPodGC**: the pod was bound to a node that no longer exists.

If there is no DisruptionTarget condition and the message mentions ephemeral storage, the pod most likely exceeded its own limit. Kubernetes does not add the condition in that case, because the pod caused the disruption itself and it would happen again on retry. Go to Step 4.

## Step 3: Node-pressure eviction

The kubelet watches eviction signals on each node and compares them to thresholds. The default hard thresholds on Linux nodes are:

- `memory.available<100Mi`
- `nodefs.available<10%`
- `imagefs.available<15%`
- `nodefs.inodesFree<5%`
- `imagefs.inodesFree<5%`

`nodefs` is the node's main filesystem, which holds `/var/lib/kubelet`, logs and `emptyDir` volumes. `imagefs` is where the container runtime keeps images, and on many nodes it is the same filesystem. There is also `pid.available` for process IDs. Your provider or distribution may set different thresholds.

When a threshold is crossed, the kubelet sets a node condition (MemoryPressure, DiskPressure or PIDPressure), and the control plane adds a matching taint, so new pods stop landing on the node. Check the node the pods were evicted from:

```
kubectl --context CONTEXT_NAME describe node NODE_NAME
```

Look at the Conditions, the taints and the Allocated resources section. Before it evicts any pods, the kubelet tries to reclaim resources itself. For disk, it garbage collects dead pods and containers and deletes unused images. Only if that is not enough does it start evicting.

The kubelet picks pods in this order:

1. Pods whose usage of the starved resource is above their request, ranked by priority and then by how far usage exceeds the request.
2. Pods using less than their request, ranked by priority. These go last.

So the first pods evicted are usually those with no request at all, or with a request far below what they really use. Pods whose containers all have equal requests and limits (the Guaranteed QoS class) are never evicted because of another pod's usage. For inode and process ID pressure, which have no requests, the kubelet uses priority alone.

Two details make node-pressure eviction harsher than other kinds. It ignores PodDisruptionBudgets. And on a hard threshold, the kubelet kills the pod with no grace period, so the application gets no chance to shut down cleanly.

The fix depends on which resource ran out:

- **Memory.** Set memory requests that match real usage, so the scheduler does not pack the node beyond what it can hold and the kubelet does not pick your pods first. The [OOMKilled guide](/blog/kubernetes-oomkilled) covers measuring real usage.
- **Disk.** Find what is filling the node: container logs, large writable layers, `emptyDir` volumes or images. Set `ephemeral-storage` requests and limits on workloads that write to local disk, and move large or long-lived data to a PersistentVolume.
- **Process IDs.** Find the workload creating processes without limit. It is often a bug that spawns child processes and never reaps them.

If an important workload keeps getting evicted, give it a higher [priority class](https://kubernetes.io/docs/concepts/scheduling-eviction/pod-priority-preemption/) so it is chosen after less important pods.

## Step 4: Ephemeral storage limits

If a container sets `resources.limits.ephemeral-storage`, the kubelet marks the pod for eviction when that container's writable layer and logs use more than the limit. At the pod level, the kubelet adds up the containers' limits and evicts the pod if the containers plus its `emptyDir` volumes use more than the total.

Check the limits the pod sets:

```
kubectl --context CONTEXT_NAME get pod POD_NAME -n NAMESPACE -o jsonpath='{range .spec.containers[*]}{.name}{"\t"}{.resources.limits.ephemeral-storage}{"\n"}{end}'
```

The fix is in the application or the spec: stop writing large temporary files, rotate or reduce logs, use a PersistentVolume for data that grows, or raise the limit if the usage is expected.

## Step 5: API-initiated eviction

An eviction through the Eviction API is a polite delete. `kubectl drain` uses it, and so do tools that remove nodes. It respects PodDisruptionBudgets and the pod's `terminationGracePeriodSeconds`, and the API server refuses an eviction with `429 Too Many Requests` if it would break a budget.

If pods were evicted this way, someone or something drained a node. Find out who before changing anything. Check recent events on the node, your node pool or autoscaler activity, and any maintenance that was scheduled.

If a drain evicted too many replicas at once, add a PodDisruptionBudget so voluntary evictions keep enough of them running:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: DEPLOYMENT_NAME-pdb
  namespace: NAMESPACE
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: DEPLOYMENT_NAME
```

A budget only protects against voluntary disruptions like drains. It does not stop node-pressure eviction.

## Step 6: Taint-based eviction

When a node gets a NoExecute taint, pods that do not tolerate it are evicted. The most common source is a node going NotReady or unreachable: by default, pods tolerate those taints for 5 minutes, then they are evicted and recreated elsewhere. If the evicted pods all came from one node, check its state and follow the [node NotReady guide](/blog/kubernetes-node-not-ready). Someone may also have added a NoExecute taint by hand. List taints to see:

```
kubectl --context CONTEXT_NAME get nodes -o custom-columns=NAME:.metadata.name,TAINTS:.spec.taints
```

## Step 7: Clean up and verify

Failed pods stay in the API until a person or controller removes them. The control plane's pod garbage collector does delete terminated pods, but only once their number passes a threshold set in the kube-controller-manager, so in most clusters evicted pods pile up for a long time. Once you have read what you need from them, delete them:

```
kubectl --context CONTEXT_NAME delete pods -n NAMESPACE --field-selector=status.phase=Failed
```

That command deletes every Failed pod in the namespace, including ones that failed for reasons other than eviction, so read the list from Step 1 first.

Then check that the replacements are healthy and the node has recovered:

```
kubectl --context CONTEXT_NAME get pods -n NAMESPACE -o wide
kubectl --context CONTEXT_NAME describe node NODE_NAME
```

Every replacement should be Running and ready, and the node's MemoryPressure, DiskPressure and PIDPressure conditions should be False. If new pods now sit in [Pending](/blog/kubernetes-pod-pending), the cluster lost capacity and needs more nodes or smaller requests elsewhere.

## Conclusion

An evicted pod tells you who removed it, if you read the reason and the DisruptionTarget condition. Node pressure means fixing requests and disk use, the Eviction API means finding who drained the node and adding a disruption budget, a taint means looking at the node, and a storage limit means looking at what the pod writes. Then clear out the Failed pods so they do not hide the next problem.

If you switch between clusters, cloud consoles and terminals to chase problems like this, Infrawrench brings Kubernetes exec and logs, SSH and the rest of your infrastructure into one workspace. [Download the free desktop app](/) for macOS, Windows or Linux, no account required.

## References

- [Node-pressure eviction](https://kubernetes.io/docs/concepts/scheduling-eviction/node-pressure-eviction/)
- [API-initiated eviction](https://kubernetes.io/docs/concepts/scheduling-eviction/api-eviction/)
- [Disruptions: pod disruption conditions](https://kubernetes.io/docs/concepts/workloads/pods/disruptions/#pod-disruption-conditions)
- [Taints and tolerations: taint based evictions](https://kubernetes.io/docs/concepts/scheduling-eviction/taint-and-toleration/#taint-based-evictions)
- [Local ephemeral storage](https://kubernetes.io/docs/concepts/storage/ephemeral-storage/)
- [Pod quality of service classes](https://kubernetes.io/docs/concepts/workloads/pods/pod-qos/)
- [Pod priority and preemption](https://kubernetes.io/docs/concepts/scheduling-eviction/pod-priority-preemption/)
- [Pod lifecycle: garbage collection of pods](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#pod-garbage-collection)
