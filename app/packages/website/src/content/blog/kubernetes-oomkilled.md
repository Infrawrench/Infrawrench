---
title: "Kubernetes OOMKilled: confirm the out-of-memory kill and fix it"
description: "Confirm a Kubernetes container was OOMKilled, tell a limit kill from a node out-of-memory kill or an eviction, then fix memory limits, requests or the leak."
date: "2026-10-31"
kind: guide
---

OOMKilled means the kernel stopped a container because it used more memory than it was allowed. It is one of the most common reasons behind a [CrashLoopBackOff](/blog/kubernetes-crashloopbackoff), and one of the easiest to misread: exit code 137 on its own does not prove it, and raising the limit is not always the fix. This guide shows how to confirm the kill, work out which kind of memory pressure caused it, and fix it in the spec.

Prerequisites: kubectl installed, access to the cluster, and permission to read pods, events and nodes. `kubectl top` needs the cluster's metrics pipeline, usually metrics-server. Everything here follows the official [Kubernetes documentation on resource management](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/). Placeholders used throughout: CONTEXT_NAME, NAMESPACE, POD_NAME, CONTAINER_NAME, NODE_NAME and DEPLOYMENT_NAME. Replace them before running a command. If you are new to the overall routine, start with the [Kubernetes troubleshooting guide for pods, logs and events](/blog/kubernetes-troubleshooting-pods-logs-and-events).

## What OOMKilled actually means

Kubernetes enforces memory limits through the kernel. When a container uses more than its memory limit, the kernel may terminate it. The official docs stress two details that explain most of the confusion:

- **Enforcement is reactive.** The kernel only kills when it detects memory pressure, so a container can run above its limit for a while and then be killed later. A pod that survived yesterday's peak can still be killed today.
- **CPU behaves differently.** A container over its CPU limit is throttled, not killed. Slowness points at CPU; restarts with OOMKilled point at memory.

There are three ways memory trouble can end a container or pod, and they need different fixes:

- **The container hit its own memory limit.** The container shows Last State Terminated with reason OOMKilled. This is the common case.
- **The node ran out of memory.** If the node runs out before the kubelet can reclaim memory, the kernel's OOM killer picks a container to kill, and it may not be the one that grew. That container also shows OOMKilled.
- **The kubelet evicted the pod.** Under node memory pressure the kubelet can evict whole pods first. An evicted pod's phase is set to Failed and its status reason reads Evicted, not OOMKilled.

## Step 1: Confirm the kill

Check you are pointed at the right cluster and namespace, then describe the pod:

```
kubectl config current-context
kubectl --context CONTEXT_NAME describe pod POD_NAME -n NAMESPACE
```

For each container, look at Last State. A limit kill looks like this:

```
Last State:     Terminated
  Reason:       OOMKilled
  Exit Code:    137
Restart Count:  5
```

To print the last termination reason for every container at once:

```
kubectl --context CONTEXT_NAME get pod POD_NAME -n NAMESPACE -o jsonpath='{range .status.containerStatuses[*]}{.name}{"\t"}{.lastState.terminated.reason}{"\t"}{.lastState.terminated.exitCode}{"\t"}{.restartCount}{"\n"}{end}'
```

The reason is the evidence, not the exit code. Exit code 137 means the process received SIGKILL, and other things send SIGKILL too. Reason OOMKilled is what confirms an out-of-memory kill. If the reason is Error with code 137, go back to the [CrashLoopBackOff guide](/blog/kubernetes-crashloopbackoff) and check probes and termination instead.

If the pod itself shows STATUS Evicted rather than a restarting container, skip to Step 4.

## Step 2: Compare the limit with real usage

Read what the container is allowed and what it asks for:

```
kubectl --context CONTEXT_NAME get pod POD_NAME -n NAMESPACE -o jsonpath='{range .spec.containers[*]}{.name}{"\t"}{.resources.requests.memory}{"\t"}{.resources.limits.memory}{"\n"}{end}'
```

Then see what it actually uses while it is running:

```
kubectl --context CONTEXT_NAME top pod POD_NAME -n NAMESPACE --containers
```

Take several readings: at startup, under normal load and at peak. `kubectl top` shows a recent sample, not a history, and metrics can be missing for a few minutes after a pod starts. Three patterns cover most cases:

- **Usage climbs steadily until the kill, every time.** That shape suggests a leak or an unbounded cache. Raising the limit only delays the next kill.
- **Usage jumps at a specific moment**, such as startup, a large request or a batch job. The limit is too low for real peak usage.
- **Usage sits well under the limit and the container still dies.** Check whether it was the node, not the limit (Step 3).

Remember that memory counted against the container includes more than the application heap. A memory-backed `emptyDir` volume counts against the pod's memory limit, and with no `sizeLimit` it can grow until it does.

## Step 3: Decide whether the node ran out

If the container stayed under its limit, look at the node it ran on:

```
kubectl --context CONTEXT_NAME get pod POD_NAME -n NAMESPACE -o wide
kubectl --context CONTEXT_NAME describe node NODE_NAME
```

In the node description, check Conditions for MemoryPressure, and compare Allocatable memory with the Allocated resources section. The scheduler places pods by their requests, not their actual usage. If pods on the node use far more memory than they request, the node can run out even though every pod "fit".

When the node runs out before the kubelet reclaims memory, the kernel's OOM killer chooses a victim. The kubelet steers that choice through each pod's quality of service (QoS) class:

- **Guaranteed** pods, where every container's memory and CPU limits equal their requests, are the least likely to be killed.
- **BestEffort** pods, with no requests or limits at all, are killed first.
- **Burstable** pods fall in between, and the more memory a container uses relative to its request, the more likely it is to be chosen.

So a container with a small request and no limit can be killed for memory that a neighbour used. Check the pod's class:

```
kubectl --context CONTEXT_NAME get pod POD_NAME -n NAMESPACE -o jsonpath='{.status.qosClass}{"\n"}'
```

The fix here is on the requests side: set memory requests that reflect real usage across the workloads on that node, so the scheduler stops packing more onto it than it can hold.

## Step 4: Evictions are a different symptom

An evicted pod was not OOMKilled. The kubelet chose to stop the whole pod to protect the node under memory pressure. It sets the pod's phase to Failed and terminates it, and a Deployment or StatefulSet creates a replacement. Find evicted pods with:

```
kubectl --context CONTEXT_NAME get pods -n NAMESPACE --field-selector=status.phase=Failed
```

When choosing pods to evict, the kubelet considers whether a pod's usage exceeds its requests, then its priority, then how far its usage exceeds its requests. Pods using more memory than they request are the first candidates. The fix is the same as Step 3: requests that match real usage. One more difference matters: an OOMKilled container can be restarted by the kubelet according to its `restartPolicy`, while an evicted pod is gone and only its controller replaces it. The [evicted pods guide](/blog/kubernetes-evicted-pods) covers every kind of eviction and how to tell them apart.

## Step 5: Fix it in the spec

Apply the change where the workload is defined, usually the Deployment manifest or its Helm values. Pick the fix that matches what Steps 2 and 3 showed:

- **A leak or unbounded growth.** The official guidance is to check the application code for a memory leak first. A higher limit buys time while you fix the growth, but it is not the fix.
- **The limit is below real peak usage.** If the application behaves as expected, set a higher memory limit, and usually a higher request too, so the scheduler reserves what the container really needs.
- **Node-level kills or evictions.** Raise memory requests to match real usage. For workloads that must not be killed first, setting memory and CPU limits equal to requests gives the pod the Guaranteed class.
- **A memory-backed emptyDir.** Set a `sizeLimit` so the volume cannot consume the whole memory limit.

Deleting the pod does not help. The controller creates an identical one, and it runs out of memory the same way.

## Step 6: Verify

Roll out the change and watch the restart count:

```
kubectl --context CONTEXT_NAME rollout status deployment/DEPLOYMENT_NAME -n NAMESPACE --timeout=180s
kubectl --context CONTEXT_NAME get pods -n NAMESPACE
kubectl --context CONTEXT_NAME top pod POD_NAME -n NAMESPACE --containers
```

RESTARTS should stay where it is through a full cycle of the load that used to trigger the kill, not just the first few minutes. Because enforcement is reactive, a pod that runs for ten minutes has not proved anything yet. Compare usage under peak with the new limit and keep real headroom.

Write down the usage you measured, the old and new values and the reason for the change. The next OOMKilled on the same workload will take a minute to judge.

## Conclusion

OOMKilled is a reason, not an exit code. Confirm it in Last State, compare the memory limit with what the container really uses, then decide whether the container outgrew its limit, the node ran out, or the kubelet evicted the pod. Fix leaks in the code, limits that are too low in the spec, and node pressure with honest requests.

If you switch between clusters, cloud consoles and terminals to chase problems like this, Infrawrench brings Kubernetes exec and logs, SSH and the rest of your infrastructure into one workspace. [Download the free desktop app](/) for macOS, Windows or Linux, no account required.

## References

- [Resource management for pods and containers](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/)
- [Assign memory resources to containers and pods](https://kubernetes.io/docs/tasks/configure-pod-container/assign-memory-resource/)
- [Node-pressure eviction](https://kubernetes.io/docs/concepts/scheduling-eviction/node-pressure-eviction/)
- [Pod quality of service classes](https://kubernetes.io/docs/concepts/workloads/pods/pod-qos/)
- [kubectl top pod](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_top/kubectl_top_pod/)
- [Debug pods](https://kubernetes.io/docs/tasks/debug/debug-application/debug-pods/)
