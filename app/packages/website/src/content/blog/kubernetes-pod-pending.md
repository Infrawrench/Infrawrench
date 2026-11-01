---
title: "Kubernetes pod stuck in Pending: read FailedScheduling and fix it"
description: "Find out why a Kubernetes pod is stuck in Pending by reading the FailedScheduling event, then fix requests, taints, selectors, volumes or ports in the spec."
date: "2026-10-31"
kind: guide
---

A pod stuck in Pending has not started, and usually has not even been placed on a node. Unlike a [CrashLoopBackOff](/blog/kubernetes-crashloopbackoff), there are no container logs to read, because no container has run. The evidence lives in one place: the scheduler's FailedScheduling event. This guide shows how to confirm the pod is unscheduled, read that event, map each part of it to a cause, and fix the cause in the spec instead of deleting the pod and hoping.

Prerequisites: kubectl installed, access to the cluster, and permission to read pods, events, nodes and PersistentVolumeClaims. Everything here follows the official [Kubernetes documentation](https://kubernetes.io/docs/tasks/debug/debug-application/debug-pods/). Placeholders used throughout: CONTEXT_NAME, NAMESPACE, POD_NAME, NODE_NAME, PVC_NAME and DEPLOYMENT_NAME. Replace them before running a command. If you are new to the overall routine, start with the [Kubernetes troubleshooting guide for pods, logs and events](/blog/kubernetes-troubleshooting-pods-logs-and-events).

## What Pending actually means

Pending is a pod phase. Kubernetes uses it for a pod that has been accepted by the cluster but whose containers are not yet set up and ready to run. That covers two quite different situations:

- **Not scheduled yet.** The scheduler has not found a node the pod fits on. This is the usual meaning of "stuck in Pending", and it is what this guide is about.
- **Scheduled, still starting.** The pod has a node, and the kubelet is pulling images or mounting volumes. `kubectl get pods` usually shows ContainerCreating or ErrImagePull here rather than Pending, and the fix is on the node side, not the scheduler side.

Telling the two apart is the first step, because the commands and causes differ.

## Step 1: Confirm the pod has no node

Check you are pointed at the right cluster and namespace, then list the pod with its node:

```
kubectl config current-context
kubectl --context CONTEXT_NAME get pod POD_NAME -n NAMESPACE -o wide
```

If the NODE column reads `<none>`, the pod has not been scheduled. You can confirm with the PodScheduled condition:

```
kubectl --context CONTEXT_NAME get pod POD_NAME -n NAMESPACE -o jsonpath='{.spec.nodeName}{"\t"}{.status.conditions[?(@.type=="PodScheduled")].reason}{"\n"}'
```

An empty node name and the reason Unschedulable mean the scheduler tried and found nowhere to put the pod. If a node name is set, the pod is past scheduling: go to the describe output and look for image pull or volume mount events instead.

If STATUS reads SchedulingGated, the pod is not unschedulable at all. It carries `schedulingGates` that tell the scheduler to wait, usually added by a controller or operator. The scheduler will not consider it until every gate is removed, so find what added the gate rather than changing nodes.

## Step 2: Read the FailedScheduling event

Every time the scheduler fails to place the pod it records an event. Describe the pod and read the Events section at the bottom:

```
kubectl --context CONTEXT_NAME describe pod POD_NAME -n NAMESPACE
```

Or pull only the scheduling events:

```
kubectl --context CONTEXT_NAME get events -n NAMESPACE --field-selector involvedObject.name=POD_NAME,reason=FailedScheduling
```

The message has a consistent shape: how many nodes were available out of the total, then a count of nodes rejected for each reason. For example, `0/42 nodes available: insufficient cpu` means none of 42 nodes had enough free CPU requests left for this pod. A message can list several reasons, one per group of nodes, and the exact wording varies between Kubernetes versions. Read every reason, because a pod only schedules once at least one node passes all of them.

The common phrases and what they point at:

- **Insufficient cpu** or **Insufficient memory**: resource requests (Step 3).
- **untolerated taint** or **had taint**: taints and tolerations (Step 4).
- **didn't match Pod's node affinity/selector**: nodeSelector or node affinity (Step 5).
- **unbound immediate PersistentVolumeClaims** or volume node affinity conflicts: storage (Step 6).
- **didn't have free ports**: hostPort (Step 7).
- **didn't match pod topology spread constraints** or **pod affinity rules**: spread and inter-pod rules (Step 7).

## Step 3: Requests that do not fit

The scheduler places pods by their resource requests, not by how busy a node actually is. A node at 10% real CPU use can still be full if the requests of the pods already on it add up to its allocatable CPU. If a container sets a limit but no request, and nothing applies a default, Kubernetes uses the limit as the request, which can make a pod much larger than you meant.

First, see what the pod asks for. A pod's request for a resource is the sum of its containers' requests:

```
kubectl --context CONTEXT_NAME get pod POD_NAME -n NAMESPACE -o jsonpath='{range .spec.containers[*]}{.name}{"\t"}{.resources.requests}{"\n"}{end}'
```

Then see what a node has left:

```
kubectl --context CONTEXT_NAME describe node NODE_NAME
```

Compare Allocatable with the Allocated resources section, which shows requests already committed on that node. If the pod's request is larger than Allocatable minus what is allocated on every node, it cannot fit. Check one thing first: a pod larger than any single node will never schedule. If every node has `cpu: 1` allocatable, a pod requesting `cpu: 1.1` stays Pending forever, no matter how empty the cluster is.

The fixes, from the official troubleshooting guidance: lower the pod's requests to what it really needs, remove pods you no longer need to free capacity, or add nodes.

If the Pending pods are extra replicas a HorizontalPodAutoscaler just added, the autoscaler is working and the cluster is out of room. The [HPA not scaling guide](/blog/kubernetes-hpa-not-scaling) covers the autoscaler side, including how requests drive its decisions.

## Step 4: Taints the pod does not tolerate

A taint with effect NoSchedule tells the scheduler to keep pods off a node unless they carry a matching toleration. Some taints you add yourself, for example to reserve GPU nodes. Others the cluster adds for you:

- `node-role.kubernetes.io/control-plane:NoSchedule` keeps ordinary workloads off control plane nodes.
- `node.kubernetes.io/unschedulable:NoSchedule` appears on a cordoned node.
- Condition taints such as `node.kubernetes.io/memory-pressure` and `node.kubernetes.io/disk-pressure` appear while a node is under pressure. The scheduler checks taints, not node conditions, so a node in trouble stops accepting new pods through its taint.

List taints across nodes:

```
kubectl --context CONTEXT_NAME get nodes -o custom-columns=NAME:.metadata.name,TAINTS:.spec.taints
```

If most nodes are tainted and the pod does not tolerate those taints, the scheduler only considers the few untainted nodes left, which may be full. Decide which side is wrong. If the pod belongs on those nodes, add a matching toleration to the workload spec. If the taint is stale, such as a node left cordoned after maintenance, uncordon it with `kubectl uncordon NODE_NAME` after checking with whoever cordoned it. If the taint comes from memory or disk pressure, fix the node, not the pod. If nodes carry `node.kubernetes.io/not-ready` or `node.kubernetes.io/unreachable`, they have stopped reporting healthy: follow the [node NotReady guide](/blog/kubernetes-node-not-ready) instead of adding tolerations.

## Step 5: Selectors and affinity no node matches

A `nodeSelector` or required node affinity rule limits the pod to nodes with specific labels. One typo, or a label that was never applied to the new node pool, and no node qualifies.

Read what the pod requires, then check which nodes carry that label:

```
kubectl --context CONTEXT_NAME get pod POD_NAME -n NAMESPACE -o jsonpath='{.spec.nodeSelector}{"\n"}{.spec.affinity.nodeAffinity}{"\n"}'
kubectl --context CONTEXT_NAME get nodes --show-labels
```

To test a single label directly, use `kubectl --context CONTEXT_NAME get nodes -l KEY=VALUE`. No results means no node can take the pod. Fix the selector in the workload, or label the nodes that should run it. If a rule only expresses a preference, use `preferredDuringSchedulingIgnoredDuringExecution` instead of a required rule so the pod can still land somewhere.

## Step 6: Volumes that cannot bind

A pod that mounts a PersistentVolumeClaim cannot schedule while that claim is unbound. Check the claim:

```
kubectl --context CONTEXT_NAME get pvc -n NAMESPACE
kubectl --context CONTEXT_NAME describe pvc PVC_NAME -n NAMESPACE
```

A claim stuck in Pending usually has events explaining why: no StorageClass matches, no PersistentVolume satisfies the requested size or access mode, or the provisioner failed. The [PVC Pending guide](/blog/kubernetes-pvc-pending) walks through each of these.

Watch for storage topology too. With a StorageClass whose `volumeBindingMode` is `Immediate`, the default, the volume is bound or provisioned as soon as the claim is created, without knowing where the pod needs to run. For storage that is not reachable from every node, such as zonal disks, the volume can end up somewhere the pod cannot schedule. `WaitForFirstConsumer` delays binding until a pod uses the claim, so the volume follows the pod's scheduling constraints. If you use `WaitForFirstConsumer`, do not set `nodeName` in the pod spec: it bypasses the scheduler and leaves the claim Pending. Use a nodeSelector on `kubernetes.io/hostname` instead.

## Step 7: Ports, spread and other placement rules

**hostPort.** A pod that binds a `hostPort` can only run on nodes where that port is free, so you can run at most one such pod per node. If you have more replicas than nodes, the rest stay Pending. In most cases a Service is the better way to expose the pod.

**Topology spread constraints.** With `whenUnsatisfiable: DoNotSchedule`, which is the default, the scheduler refuses placements that would make the spread across zones or nodes more uneven than `maxSkew` allows. Check the constraints in the spec against the zones and nodes you actually have.

**Pod affinity and anti-affinity.** A required anti-affinity rule that keeps replicas on separate nodes leaves extra replicas Pending once every node already has one.

**Priority and preemption.** When a higher-priority pod cannot fit, the scheduler may evict lower-priority pods to make room. While that happens, the pending pod's `status.nominatedNodeName` is set to the node it expects to use. A pod that stays Pending with a nominated node is usually waiting for victims to finish terminating.

**Quota is a different symptom.** A ResourceQuota is enforced when the pod is created, not when it is scheduled. A pod that would exceed quota is rejected outright and never exists, so it never shows as Pending. If a Deployment has fewer pods than expected and none are Pending, check the controller's events instead:

```
kubectl --context CONTEXT_NAME describe deployment DEPLOYMENT_NAME -n NAMESPACE
```

## Step 8: Fix through the spec and verify

Apply the fix where the workload is defined, usually the Deployment manifest or its Helm values. Deleting a Pending pod rarely helps: the controller creates an identical one, and the scheduler rejects it for the same reason. The scheduler keeps retrying unscheduled pods on its own, so once capacity or labels change on the cluster side, the existing pod schedules without being touched.

Then confirm it actually moved:

```
kubectl --context CONTEXT_NAME rollout status deployment/DEPLOYMENT_NAME -n NAMESPACE --timeout=180s
kubectl --context CONTEXT_NAME get pods -n NAMESPACE -o wide
```

Check that the NODE column now has a node, STATUS reaches Running and READY shows every container ready. If the pod now sits in ContainerCreating or [ImagePullBackOff](/blog/kubernetes-imagepullbackoff), scheduling is fixed and you have a new, node-side problem. If it starts and then restarts, follow the [CrashLoopBackOff guide](/blog/kubernetes-crashloopbackoff).

Write down the FailedScheduling message and the change that fixed it. The same message on the next pod will take a minute to resolve.

## Conclusion

A Pending pod has no logs, but it does have a reason. Confirm it has no node, read the FailedScheduling event in full, match each part to requests, taints, selectors, volumes or placement rules, then fix the spec and let the scheduler retry.

If you switch between clusters, cloud consoles and terminals to chase problems like this, Infrawrench brings Kubernetes exec and logs, SSH and the rest of your infrastructure into one workspace. [Download the free desktop app](/) for macOS, Windows or Linux, no account required.

## References

- [Debug pods](https://kubernetes.io/docs/tasks/debug/debug-application/debug-pods/)
- [Pod lifecycle: pod phase](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/)
- [Resource management for pods and containers](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/)
- [Taints and tolerations](https://kubernetes.io/docs/concepts/scheduling-eviction/taint-and-toleration/)
- [Assigning pods to nodes](https://kubernetes.io/docs/concepts/scheduling-eviction/assign-pod-node/)
- [Storage classes: volume binding mode](https://kubernetes.io/docs/concepts/storage/storage-classes/#volume-binding-mode)
- [Pod topology spread constraints](https://kubernetes.io/docs/concepts/scheduling-eviction/topology-spread-constraints/)
- [Pod priority and preemption](https://kubernetes.io/docs/concepts/scheduling-eviction/pod-priority-preemption/)
- [Pod scheduling readiness](https://kubernetes.io/docs/concepts/scheduling-eviction/pod-scheduling-readiness/)
- [Resource quotas](https://kubernetes.io/docs/concepts/policy/resource-quotas/)
